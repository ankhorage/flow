import type { SecretRef, SecretStoreAdapter } from '@ankhorage/contracts/secrets';

import type {
  FlowApprovalStorePort,
  FlowRateLimitPort,
  FlowResolvedSecrets,
  FlowSecurityActor,
  FlowSecurityAuditEvent,
  FlowSecurityAuditPort,
  FlowSecurityGrant,
  FlowSecurityOperation,
  FlowSecurityPermit,
  FlowSecurityPort,
} from '../../../types/security.js';
import { FlowSecurityError } from '../FlowSecurityError.js';

/*** Creates the provider-neutral server-side authorization, approval, audit, and secret boundary. */
export const createFlowSecurityPort = (input: {
  readonly approvalStore: FlowApprovalStorePort;
  readonly audit: FlowSecurityAuditPort;
  readonly grants: readonly FlowSecurityGrant[];
  readonly rateLimit: FlowRateLimitPort;
  readonly secretStore: SecretStoreAdapter;
}): FlowSecurityPort => {
  const completed = new Map<string, string>();
  return {
    authorizeAsync: async (operation) => authorizeAsync(input, completed, operation),
    getSecretMetadataAsync: async ({ actor, ref }) => getSecretMetadataAsync(input, actor, ref),
  };
};

/*** Authorizes one exact operation before resolving any secret material. */
const authorizeAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  completed: Map<string, string>,
  operation: FlowSecurityOperation,
): Promise<FlowSecurityPermit> => {
  const targetHost = validateTarget(operation.targetUrl);
  const secretRefs = unique(operation.secretRefs ?? []);
  if (!isGranted(input.grants, operation.actor, operation.capability))
    return denyAsync(input.audit, operation, secretRefs, targetHost, 'permission_denied');
  const prior = completed.get(operation.idempotencyKey);
  if (prior && prior !== operation.operationId)
    return denyAsync(input.audit, operation, secretRefs, targetHost, 'idempotency_conflict');
  const approval = await input.approvalStore.getAsync(operation.operationId);
  if (!approval || approval.status === 'pending')
    return denyAsync(input.audit, operation, secretRefs, targetHost, 'approval_pending');
  if (approval.status !== 'approved')
    return denyAsync(input.audit, operation, secretRefs, targetHost, 'approval_rejected');
  if (
    !(await input.rateLimit.acquireAsync({
      actor: operation.actor,
      capability: operation.capability,
      operationId: operation.operationId,
    }))
  )
    return denyAsync(input.audit, operation, secretRefs, targetHost, 'rate_limited');
  completed.set(operation.idempotencyKey, operation.operationId);
  await writeAuditAsync(
    input.audit,
    operation,
    secretRefs,
    targetHost,
    'permitted',
    'permission_denied',
  );
  return createPermit(input, operation, secretRefs);
};

/*** Creates a single-use permit so a successful approval cannot replay a side effect. */
const createPermit = (
  input: Parameters<typeof createFlowSecurityPort>[0],
  operation: FlowSecurityOperation,
  secretRefs: readonly SecretRef[],
): FlowSecurityPermit => {
  let executed = false;
  return {
    operation,
    executeAsync: async (callback) => {
      if (executed)
        throw new FlowSecurityError(
          'idempotency_conflict',
          'The operation permit has already been consumed.',
        );
      executed = true;
      return resolveAndExecuteAsync(input, operation, secretRefs, callback);
    },
  };
};

/*** Returns metadata only after enforcing the same project and environment boundary. */
const getSecretMetadataAsync = async (
  input: Parameters<typeof createFlowSecurityPort>[0],
  actor: FlowSecurityActor,
  ref: SecretRef,
) => {
  const result = await input.secretStore.getMetadata({ scope: scopeOf(actor), ref });
  if (!result.ok)
    throw new FlowSecurityError('secret_unavailable', 'The requested secret is unavailable.');
  return result.data;
};

/*** Resolves secrets only in the server-side callback after a permit exists. */
const resolveAndExecuteAsync = async <T>(
  input: Parameters<typeof createFlowSecurityPort>[0],
  operation: FlowSecurityOperation,
  secretRefs: readonly SecretRef[],
  callback: (secrets: FlowResolvedSecrets) => Promise<T>,
): Promise<T> => {
  const resolved = await Promise.all(
    secretRefs.map(
      async (ref) =>
        [ref, await resolveSecretAsync(input.secretStore, operation.actor, ref)] as const,
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

/*** Rejects external targets that do not have an explicit public HTTPS authority. */
const validateTarget = (targetUrl: string | undefined): string | undefined => {
  if (!targetUrl) return undefined;
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new FlowSecurityError('invalid_target', 'External targets must be absolute HTTPS URLs.');
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash ||
    isPrivateHost(target.hostname)
  )
    throw new FlowSecurityError(
      'invalid_target',
      'External targets must use a public HTTPS host without credentials or fragments.',
    );
  return target.hostname;
};

/*** Recognizes DNS-independent private and local host forms before network access. */
const isPrivateHost = (host: string): boolean =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host === '::1' ||
  host.startsWith('127.') ||
  host.startsWith('10.') ||
  host.startsWith('192.168.') ||
  host.startsWith('169.254.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host);
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
  operation: FlowSecurityOperation,
  secretRefs: readonly SecretRef[],
  targetHost: string | undefined,
  reason: FlowSecurityAuditEvent['reason'],
): Promise<never> => {
  await writeAuditAsync(audit, operation, secretRefs, targetHost, 'denied', reason);
  throw new FlowSecurityError(reason, denialMessage(reason));
};
/*** Emits only identifiers and target host metadata to the audit edge. */
const writeAuditAsync = (
  audit: FlowSecurityAuditPort,
  operation: FlowSecurityOperation,
  secretRefs: readonly SecretRef[],
  targetHost: string | undefined,
  decision: FlowSecurityAuditEvent['decision'],
  reason: FlowSecurityAuditEvent['reason'],
): Promise<void> =>
  audit.writeAsync({
    actorId: operation.actor.id,
    capability: operation.capability,
    decision,
    operationId: operation.operationId,
    reason,
    secretRefs,
    ...(targetHost ? { targetHost } : {}),
  });
/*** Maps policy reasons to public redaction-safe error text. */
const denialMessage = (reason: FlowSecurityAuditEvent['reason']): string => {
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
};
