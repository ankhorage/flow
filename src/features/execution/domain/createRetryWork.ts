import type { FlowDurableWork, FlowRetryPolicy } from '../../../types/durableExecution.js';
import { calculateRetryDueAt } from './calculateRetryDueAt.js';

/*** Create the next immutable work attempt from a completed attempt and controlled clock. */
export const createRetryWork = (
  completed: FlowDurableWork,
  now: Date,
  policy: FlowRetryPolicy,
): FlowDurableWork => ({
  ...(completed.idempotencyKey === undefined ? {} : { idempotencyKey: completed.idempotencyKey }),
  attempt: completed.attempt + 1,
  dueAt: calculateRetryDueAt(now, completed.attempt, policy),
  flow: { ...completed.flow },
  id: `${completed.runId}:attempt:${completed.attempt + 1}`,
  runId: completed.runId,
  ...(completed.securityOperation === undefined
    ? {}
    : { securityOperation: completed.securityOperation }),
  ...(completed.stepId === undefined ? {} : { stepId: completed.stepId }),
  status: 'ready',
});
