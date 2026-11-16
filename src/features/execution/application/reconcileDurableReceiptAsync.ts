import type {
  FlowDurableEffectPort,
  FlowDurableEffectResult,
  FlowDurableRun,
  FlowDurableWork,
} from '../../../types/durableExecution.js';
import type { FlowSecurityReconciliationPermit } from '../../../types/security.js';

/** Reconcile a credential-free provider receipt before any recovery path can resolve a secret. */
export const reconcileDurableReceiptAsync = async (input: {
  readonly effects: FlowDurableEffectPort;
  readonly recoveryPermit: FlowSecurityReconciliationPermit;
  readonly run: FlowDurableRun;
  readonly work: FlowDurableWork;
}): Promise<FlowDurableEffectResult | 'unknown'> => {
  const reconcile = input.effects.reconcileWithoutSecretsAsync;
  if (reconcile === undefined) return 'unknown';
  return input.recoveryPermit.reconcileWithoutSecretsAsync(() =>
    reconcile({
      idempotencyKey: input.work.idempotencyKey ?? input.work.id,
      run: input.run,
      work: input.work,
    }),
  );
};
