import type { FlowRunCheckpoint } from '../../../types/durableExecution.js';

/** Add one durable step to its terminal checkpoint state without duplicating retry recovery. */
export const updateDurableCheckpoint = (input: {
  readonly checkpoint: FlowRunCheckpoint | undefined;
  readonly status: 'completed' | 'failed';
  readonly stepId: string | undefined;
}): FlowRunCheckpoint => ({
  completedStepIds: completedStepIds(input),
  ...(input.checkpoint?.data === undefined ? {} : { data: input.checkpoint.data }),
  failedStepIds: failedStepIds(input),
  ...(input.checkpoint?.steps === undefined ? {} : { steps: input.checkpoint.steps }),
});

/** Preserve successful steps unless this transition completes one additional step. */
const completedStepIds = (input: Parameters<typeof updateDurableCheckpoint>[0]) =>
  input.status === 'completed'
    ? unique([
        ...(input.checkpoint?.completedStepIds ?? []),
        ...(input.stepId === undefined ? [] : [input.stepId]),
      ])
    : (input.checkpoint?.completedStepIds ?? []);

/** Preserve failed steps unless this transition terminally fails one additional step. */
const failedStepIds = (input: Parameters<typeof updateDurableCheckpoint>[0]) =>
  input.status === 'failed'
    ? unique([
        ...(input.checkpoint?.failedStepIds ?? []),
        ...(input.stepId === undefined ? [] : [input.stepId]),
      ])
    : (input.checkpoint?.failedStepIds ?? []);

/** Keep checkpoint arrays deterministic across retries and process recovery. */
const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];
