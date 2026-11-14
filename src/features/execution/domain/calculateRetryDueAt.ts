import type { FlowRetryPolicy } from '../../../types/durableExecution.js';

/*** Calculate an exponential retry time from persisted attempt state without ambient time. */
export const calculateRetryDueAt = (
  now: Date,
  completedAttempt: number,
  policy: FlowRetryPolicy,
): string => {
  if (!Number.isSafeInteger(completedAttempt) || completedAttempt < 1)
    throw new Error('FLOW_RETRY_ATTEMPT_INVALID');
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0)
    throw new Error('FLOW_RETRY_BASE_DELAY_INVALID');
  if (
    !Number.isSafeInteger(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs ||
    policy.maxDelayMs < 0
  )
    throw new Error('FLOW_RETRY_MAX_DELAY_INVALID');
  const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (completedAttempt - 1));
  return new Date(now.getTime() + delay).toISOString();
};
