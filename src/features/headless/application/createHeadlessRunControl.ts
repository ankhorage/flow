import { randomUUID } from 'node:crypto';

import type { FlowRunSnapshot } from '@ankhorage/contracts/flow';

import type { FlowResourceScope, FlowRuntimeDependencies } from '../../../types/headless.js';
import { cancelDurableRunAsync } from '../../execution/application/cancelDurableRunAsync.js';

/** Create the stateful headless cancellation and retry boundary around canonical durable work. */
export const createHeadlessRunControl = (
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
) => ({
  cancelRunAsync: async (scope: FlowResourceScope, runId: string) => {
    const run = await dependencies.store.getRunAsync(scope, runId);
    if (run === undefined || isTerminal(run)) return undefined;
    const cancelled = {
      ...run,
      completedAt: clock.now().toISOString(),
      status: 'cancelled' as const,
    };
    const transitioned = await dependencies.store.transitionRunAsync({
      event: { id: 0, runId, timestamp: cancelled.completedAt, type: 'run_cancelled' },
      expectedStatus: run.status,
      run: cancelled,
      scope,
    });
    if (transitioned)
      await cancelDurableRunAsync(runId, { clock, persistence: dependencies.persistence });
    return transitioned ? cancelled : undefined;
  },
  retryRunAsync: async (scope: FlowResourceScope, runId: string) => {
    const previous = await dependencies.store.getRunAsync(scope, runId);
    if (previous === undefined || !isTerminal(previous)) return undefined;
    const now = clock.now().toISOString();
    const retry: FlowRunSnapshot = {
      createdAt: now,
      flow: previous.flow,
      id: randomUUID(),
      ...(previous.input === undefined ? {} : { input: previous.input }),
      status: 'pending',
      steps: [],
      trigger: previous.trigger,
    };
    return dependencies.store.saveRunAsync(scope, retry);
  },
});

/** Identify statuses that cannot be cancelled or retried in place. */
const isTerminal = (run: FlowRunSnapshot): boolean =>
  ['cancelled', 'failed', 'succeeded', 'timed_out'].includes(run.status);
