import type { SecretRef, SecretStoreAdapter } from '@ankhorage/contracts/secrets';

import type { FlowResolvedSecrets, FlowSecurityActor } from '../../../types/security.js';
import { FlowSecurityError } from '../FlowSecurityError.js';

/** Resolve the exact server-held secret references only for an authorized permit callback. */
export const resolveFlowSecretsAsync = async <T>(input: {
  readonly actor: FlowSecurityActor;
  readonly callback: (secrets: FlowResolvedSecrets) => Promise<T>;
  readonly secretRefs: readonly SecretRef[];
  readonly secretStore: SecretStoreAdapter;
}): Promise<T> => {
  const resolved = await Promise.all(
    input.secretRefs.map(async (ref) => [ref, await resolveSecretAsync(input, ref)] as const),
  );
  return input.callback(Object.fromEntries(resolved));
};

/** Resolve one published reference without leaking backend or payload details. */
const resolveSecretAsync = async (
  input: Parameters<typeof resolveFlowSecretsAsync>[0],
  ref: SecretRef,
) => {
  const result = await input.secretStore.resolve({
    ref,
    scope: { environment: input.actor.environment, projectId: input.actor.projectId },
  });
  if (!result.ok)
    throw new FlowSecurityError('secret_unavailable', 'A required secret is unavailable.');
  return result.data;
};
