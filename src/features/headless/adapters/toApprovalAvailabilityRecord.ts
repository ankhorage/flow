import type { FlowApprovalRequest } from '@ankhorage/contracts/flow';

/*** Project one persisted approval record before it can cross the headless store read port. */
export const toApprovalAvailabilityRecord = (approval: FlowApprovalRequest | undefined) =>
  approval === undefined
    ? undefined
    : {
        ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
        id: approval.id,
        runId: approval.runId,
        status: approval.status,
      };
