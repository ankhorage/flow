import type { FlowRunSnapshot } from '@ankhorage/contracts/flow';

import type { FlowDurableRun } from '../../../types/durableExecution.js';
import type { FlowRuntimeDependencies } from '../../../types/headless.js';
import { observeFlowRuntimeAsync } from './observeFlowRuntimeAsync.js';

/** Reconcile the public headless projection from canonical durable checkpoints after every worker outcome. */
export const synchronizeHeadlessRunAsync = async (
  workId: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<void> => {
  const [runId] = workId.split(':step:');
  if (runId === undefined) return;
  const durable = await dependencies.persistence.readRunAsync(runId);
  if (durable?.scope === undefined) return;
  const current = await dependencies.store.getRunAsync(durable.scope, durable.id);
  if (current === undefined) return;
  const status = headlessStatus(durable.status);
  const steps = durable.checkpoint?.steps ?? current.steps;
  if (current.status === status && JSON.stringify(current.steps) === JSON.stringify(steps)) return;
  const terminal = durable.status === 'failed' || durable.status === 'succeeded';
  const updated: FlowRunSnapshot = {
    ...current,
    ...(terminal ? { completedAt: clock.now().toISOString() } : {}),
    status,
    steps,
  };
  const transitioned = await dependencies.store.transitionRunAsync({
    event: {
      id: 0,
      runId: current.id,
      timestamp: clock.now().toISOString(),
      type: terminal
        ? 'run_completed'
        : current.status === 'pending'
          ? 'run_started'
          : 'run_progressed',
    },
    expectedStatus: current.status,
    run: updated,
    scope: durable.scope,
  });
  if (transitioned && terminal)
    await observeFlowRuntimeAsync(
      dependencies,
      'execution',
      `run_${updated.status}`,
      clock.now().toISOString(),
      current.id,
    );
};

/** Translate canonical worker-only waiting status to the public Flow run contract. */
const headlessStatus = (status: FlowDurableRun['status']): FlowRunSnapshot['status'] =>
  status === 'waiting_approval' ? 'waiting_for_approval' : status === 'queued' ? 'pending' : status;
