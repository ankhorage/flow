import type { FlowDurableRun } from '../../../types/durableExecution.js';
import type { FlowClock } from '../../../types/execution.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';

/** Cancel a durable run and atomically prevent future ready or claimed deliveries from starting. */
export const cancelDurableRunAsync = async (
  runId: string,
  dependencies: { readonly clock: FlowClock; readonly persistence: FlowPersistencePort },
): Promise<boolean> => {
  const run = await dependencies.persistence.readRunAsync(runId);
  if (run === undefined || run.status === 'cancelled' || isTerminal(run)) return false;
  const transitioned = await dependencies.persistence.transitionRunAsync({
    expectedRevision: run.revision,
    run: {
      ...run,
      revision: run.revision + 1,
      status: 'cancelled',
      updatedAt: dependencies.clock.now().toISOString(),
    },
  });
  if (!transitioned) return false;
  await dependencies.persistence.cancelRunWorkAsync(runId);
  return true;
};

/** Leave completed and terminally failed runs immutable. */
const isTerminal = (run: FlowDurableRun): boolean =>
  run.status === 'failed' || run.status === 'succeeded';
