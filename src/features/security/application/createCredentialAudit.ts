import type { SecretRef } from '@ankhorage/contracts/secrets';

import type { FlowSecurityActor, FlowSecurityAuditPort } from '../../../types/security.js';
import { FlowSecurityError } from '../FlowSecurityError.js';

/** Create redaction-safe credential-management audit and denial operations. */
export const createCredentialAudit = (audit: FlowSecurityAuditPort) => ({
  denyAsync: async (
    actor: FlowSecurityActor,
    ref: SecretRef,
    capability: string,
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
  },
  writeAsync: async (
    actor: FlowSecurityActor,
    ref: SecretRef,
    capability: string,
    reason: 'credential_create' | 'credential_replace' | 'credential_revoke',
  ): Promise<void> =>
    audit.writeAsync({
      actorId: actor.id,
      capability,
      decision: 'permitted',
      operationId: ref,
      reason,
      secretRefs: [ref],
    }),
});
