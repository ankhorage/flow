import type { SecretRef, SecretStoreAdapter } from '@ankhorage/contracts/secrets';

import type {
  FlowApprovalStorePort,
  FlowOperationStorePort,
  FlowRateLimitPort,
  FlowResolvedSecrets,
  FlowSecretCreateInput,
  FlowSecretMetadata,
  FlowSecretRevokeInput,
  FlowSecurityActor,
  FlowSecurityAuditEvent,
  FlowSecurityAuditPort,
  FlowSecurityGrant,
  FlowSecurityOperation,
  FlowSecurityOperationIdentity,
  FlowSecurityPermit,
  FlowSecurityPort,
  FlowSecurityTarget,
} from '../../../types/security.js';
import { validateFlowSecurityTarget } from '../domain/validateFlowSecurityTarget.js';
import { FlowSecurityError } from '../FlowSecurityError.js';

const METADATA_CAPABILITY = 'secrets:metadata';
const CREATE_CAPABILITY = 'secrets:create';
const REVOKE_CAPABILITY = 'secrets:revoke';
type FlowSecurityDenialReason = Exclude<
  FlowSecurityAuditEvent['reason'],
  'credential_create' | 'credential_revoke'
>;

/*** Creates the provider-neutral server-side authorization, approval, audit, and secret boundary. */
export const createFlowSecurityPort = (input: {
  readonly approvalStore: FlowApprovalStorePort;
  readonly audit: FlowSecurityAuditPort;
  readonly grants: readonly FlowSecurityGrant[];
  readonly operationStore: FlowOperationStorePort;
  readonly rateLimit: FlowRateLimitPort;
  readonly secretStore: SecretStoreAdapter;
}): FlowSecurityPort => ({
  authorizeAsync: async (operation) => authorizeAsync(input, operation),
  createSecretAsync: async (request) => createSecretAsync(input, request),
  getSecretMetadataAsync: async ({ actor, ref }) => getSecretMetadataAsync(input, actor, ref),
  revokeSecretAsync: async (request) => revokeSecretAsync(input, request),
});

/*** Authorizes and durably claims one exact operation before resolving any secret material. */
const authorizeAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  operation: FlowSecurityOperation,
): Promise<FlowSecurityPermit> => {
  const identity = identityOf(operation);
  const targetHost = validateFlowSecurityTarget(identity.target);
  if (!isGranted(input.grants, identity.actor, identity.capability))
    return denyAsync(input.audit, identity, targetHost, 'permission_denied');
  const approval = await input.approvalStore.getAsync(identity);
  if (approval?.status === 'pending')
    return denyAsync(input.audit, identity, targetHost, 'approval_pending');
  if (approval?.status !== 'approved' || !sameIdentity(approval.operation, identity))
    return denyAsync(input.audit, identity, targetHost, 'approval_rejected');
  if (!(await input.operationStore.claimAsync(identity)))
    return denyAsync(input.audit, identity, targetHost, 'idempotency_conflict');
  try {
    if (
      !(await input.rateLimit.acquireAsync({
        actor: identity.actor,
        capability: identity.capability,
        operationId: identity.operationId,
      }))
    )
      return denyAfterReleaseAsync(input, identity, targetHost, 'rate_limited');
    await writeAuditAsync(input.audit, identity, targetHost, 'permitted', 'permission_denied');
    return createPermit(input, identity);
  } catch (error) {
    await input.operationStore.releaseAsync(identity);
    throw error;
  }
};

/*** Creates a one-use permit that atomically consumes the durable operation claim before side effects. */
const createPermit = (
  input: Parameters<typeof createFlowSecurityPort>[0],
  identity: FlowSecurityOperationIdentity,
): FlowSecurityPermit => ({
  operation: identity,
  executeAsync: async (callback) => {
    if (!(await input.operationStore.consumeAsync(identity)))
      throw new FlowSecurityError(
        'idempotency_conflict',
        'The operation permit has already been consumed.',
      );
    return resolveAndExecuteAsync(input, identity.actor, identity.secretRefs, callback);
  },
});

/*** Releases an unconsumed claim before emitting a retryable denial. */
const denyAfterReleaseAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  identity: FlowSecurityOperationIdentity,
  targetHost: string | undefined,
  reason: FlowSecurityDenialReason,
): Promise<never> => {
  await input.operationStore.releaseAsync(identity);
  return denyAsync(input.audit, identity, targetHost, reason);
};

/*** Creates a credential only after an explicit server-side scoped grant and redacted audit. */
const createSecretAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  request: FlowSecretCreateInput,
): Promise<FlowSecretMetadata> => {
  const actor = snapshotActor(request.actor);
  if (!isGranted(input.grants, actor, CREATE_CAPABILITY))
    return denyCredentialAsync(input.audit, actor, request.ref, CREATE_CAPABILITY);
  await writeCredentialAuditAsync(input.audit, actor, request.ref, CREATE_CAPABILITY);
  const result = await input.secretStore.create({
    kind: request.kind,
    payload: request.payload,
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    ref: request.ref,
    scope: scopeOf(actor),
  });
  if (!result.ok)
    throw new FlowSecurityError('secret_unavailable', 'The requested secret is unavailable.');
  return result.data;
};

/*** Returns metadata only after an explicit actor, tenant, project, and environment grant. */
const getSecretMetadataAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  actor: FlowSecurityActor,
  ref: SecretRef,
) => {
  const identity = snapshotActor(actor);
  if (!isGranted(input.grants, identity, METADATA_CAPABILITY))
    throw new FlowSecurityError(
      'permission_denied',
      'The actor is not permitted to inspect secrets.',
    );
  const result = await input.secretStore.getMetadata({ scope: scopeOf(identity), ref });
  if (!result.ok)
    throw new FlowSecurityError('secret_unavailable', 'The requested secret is unavailable.');
  return result.data;
};

/*** Revokes a credential only after an explicit server-side scoped grant and redacted audit. */
const revokeSecretAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  request: FlowSecretRevokeInput,
): Promise<void> => {
  const actor = snapshotActor(request.actor);
  if (!isGranted(input.grants, actor, REVOKE_CAPABILITY))
    return denyCredentialAsync(input.audit, actor, request.ref, REVOKE_CAPABILITY);
  await writeCredentialAuditAsync(input.audit, actor, request.ref, REVOKE_CAPABILITY);
  const result = await input.secretStore.remove({ ref: request.ref, scope: scopeOf(actor) });
  if (!result.ok)
    throw new FlowSecurityError('secret_unavailable', 'The requested secret is unavailable.');
};

/*** Resolves secrets only in the server-side callback after durable consumption succeeds. */
const resolveAndExecuteAsync = async <T>(
  input: Parameters<typeof createFlowSecurityPort>[0],
  actor: FlowSecurityActor,
  secretRefs: readonly SecretRef[],
  callback: (secrets: FlowResolvedSecrets) => Promise<T>,
): Promise<T> => {
  const resolved = await Promise.all(
    secretRefs.map(
      async (ref) => [ref, await resolveSecretAsync(input.secretStore, actor, ref)] as const,
    ),
  );
  return callback(Object.fromEntries(resolved));
};

/*** Resolves one published secret reference without exposing a provider error or payload in failures. */
const resolveSecretAsync = async (
  secretStore: SecretStoreAdapter,
  actor: FlowSecurityActor,
  ref: SecretRef,
) => {
  const result = await secretStore.resolve({ scope: scopeOf(actor), ref });
  if (!result.ok)
    throw new FlowSecurityError('secret_unavailable', 'A required secret is unavailable.');
  return result.data;
};

/*** Creates a deterministic complete identity from untrusted operation input. */
const identityOf = (operation: FlowSecurityOperation): FlowSecurityOperationIdentity =>
  Object.freeze({
    actor: snapshotActor(operation.actor),
    capability: operation.capability,
    idempotencyKey: operation.idempotencyKey,
    operationId: operation.operationId,
    secretRefs: Object.freeze(unique(operation.secretRefs ?? [])),
    ...(operation.target
      ? {
          target: Object.freeze({
            allowedHosts: Object.freeze([...operation.target.allowedHosts]),
            url: operation.target.url,
          }),
        }
      : {}),
  });

/*** Captures a runtime-immutable actor scope before any authorization boundary can await. */
const snapshotActor = (actor: FlowSecurityActor): FlowSecurityActor => Object.freeze({ ...actor });

/*** Compares every authorization-relevant operation field without relying on object identity. */
const sameIdentity = (
  left: FlowSecurityOperationIdentity,
  right: FlowSecurityOperationIdentity,
): boolean =>
  left.actor.id === right.actor.id &&
  left.actor.tenantId === right.actor.tenantId &&
  left.actor.projectId === right.actor.projectId &&
  left.actor.environment === right.actor.environment &&
  left.capability === right.capability &&
  left.idempotencyKey === right.idempotencyKey &&
  left.operationId === right.operationId &&
  sameStrings(left.secretRefs, right.secretRefs) &&
  sameTarget(left.target, right.target);

/*** Compares target authority exactly so approvals cannot move an operation to another host. */
const sameTarget = (
  left: FlowSecurityTarget | undefined,
  right: FlowSecurityTarget | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.url === right.url && sameStrings(left.allowedHosts, right.allowedHosts);

/*** Matches two ordered identity arrays exactly. */
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/*** Matches a grant only when all actor isolation dimensions are equal. */
const isGranted = (
  grants: readonly FlowSecurityGrant[],
  actor: FlowSecurityActor,
  capability: string,
): boolean =>
  grants.some(
    (grant) =>
      grant.actorId === actor.id &&
      grant.capability === capability &&
      grant.tenantId === actor.tenantId &&
      grant.projectId === actor.projectId &&
      grant.environment === actor.environment,
  );
/*** Converts a trusted actor boundary to the published secret-store scope. */
const scopeOf = (actor: FlowSecurityActor) => ({
  projectId: actor.projectId,
  environment: actor.environment,
});
/*** Deduplicates secret references without changing their deterministic order. */
const unique = (refs: readonly SecretRef[]): readonly SecretRef[] => [...new Set(refs)];
/*** Audits a redacted decision before returning a stable denial. */
const denyAsync = async (
  audit: FlowSecurityAuditPort,
  identity: FlowSecurityOperationIdentity,
  targetHost: string | undefined,
  reason: FlowSecurityDenialReason,
): Promise<never> => {
  await writeAuditAsync(audit, identity, targetHost, 'denied', reason);
  throw new FlowSecurityError(reason, denialMessage(reason));
};
/*** Emits only identifiers and target host metadata to the audit edge. */
const writeAuditAsync = (
  audit: FlowSecurityAuditPort,
  identity: FlowSecurityOperationIdentity,
  targetHost: string | undefined,
  decision: FlowSecurityAuditEvent['decision'],
  reason: FlowSecurityAuditEvent['reason'],
): Promise<void> =>
  audit.writeAsync({
    actorId: identity.actor.id,
    capability: identity.capability,
    decision,
    operationId: identity.operationId,
    reason,
    secretRefs: identity.secretRefs,
    ...(targetHost ? { targetHost } : {}),
  });
/*** Audits a credential-management decision without accepting its payload at the audit edge. */
const writeCredentialAuditAsync = (
  audit: FlowSecurityAuditPort,
  actor: FlowSecurityActor,
  ref: SecretRef,
  capability: typeof CREATE_CAPABILITY | typeof REVOKE_CAPABILITY,
): Promise<void> =>
  audit.writeAsync({
    actorId: actor.id,
    capability,
    decision: 'permitted',
    operationId: ref,
    reason: capability === CREATE_CAPABILITY ? 'credential_create' : 'credential_revoke',
    secretRefs: [ref],
  });
/*** Audits and returns a stable denial for unauthorized credential management. */
const denyCredentialAsync = async (
  audit: FlowSecurityAuditPort,
  actor: FlowSecurityActor,
  ref: SecretRef,
  capability: typeof CREATE_CAPABILITY | typeof REVOKE_CAPABILITY,
): Promise<never> => {
  await audit.writeAsync({
    actorId: actor.id,
    capability,
    decision: 'denied',
    operationId: ref,
    reason: 'permission_denied',
    secretRefs: [ref],
  });
  throw new FlowSecurityError(
    'permission_denied',
    'The actor is not permitted to perform this operation.',
  );
};
/*** Maps policy reasons to public redaction-safe error text. */
const denialMessage = (reason: FlowSecurityDenialReason): string => {
  switch (reason) {
    case 'approval_pending':
      return 'The operation requires an approved Flow approval gate.';
    case 'approval_rejected':
      return 'The Flow approval gate rejected this operation.';
    case 'idempotency_conflict':
      return 'The idempotency key is already bound to another operation.';
    case 'invalid_target':
      return 'The external target is not permitted.';
    case 'permission_denied':
      return 'The actor is not permitted to perform this operation.';
    case 'rate_limited':
      return 'The operation is rate limited.';
    case 'secret_unavailable':
      return 'A required secret is unavailable.';
  }
  const impossible: never = reason;
  return impossible;
};
