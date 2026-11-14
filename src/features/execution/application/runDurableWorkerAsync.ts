import type {
  FlowDurableRun,
  FlowDurableWork,
  FlowRetryPolicy,
  FlowRunCheckpoint,
} from '../../../types/durableExecution.js';
import type { FlowClock } from '../../../types/execution.js';
import type { FlowSecurityPort } from '../../../types/security.js';
import { FlowSecurityError } from '../../security/FlowSecurityError.js';
import { createRetryWork } from '../domain/createRetryWork.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';

/** Claim bounded durable work and execute it with fenced recovery, retry, and approval handling. */
export const runDurableWorkerAsync = async (
  input: {
    readonly approvalPollIntervalMs: number;
    readonly concurrency: number;
    readonly leaseDurationMs: number;
    readonly limit: number;
    readonly retry: FlowRetryPolicy;
    readonly workerId: string;
  },
  dependencies: {
    readonly clock: FlowClock;
    readonly effects: FlowDurableEffectPort;
    readonly persistence: FlowPersistencePort;
    readonly security?: FlowSecurityPort;
  },
): Promise<FlowWorkerResult> => {
  assertWorkerInput(input);
  const now = dependencies.clock.now();
  const recoveredWorkIds = await dependencies.persistence.recoverExpiredClaimsAsync(now);
  const claimed = await dependencies.persistence.claimDueWorkAsync({
    leaseDurationMs: input.leaseDurationMs,
    limit: Math.min(input.limit, input.concurrency),
    now,
    workerId: input.workerId,
  });
  const outcomes = await Promise.all(
    claimed.map((work) => processWorkAsync(work, input, dependencies)),
  );
  return { claimedWorkIds: claimed.map((work) => work.id), outcomes, recoveredWorkIds };
};

/** Executes one effect through the durable step and security boundaries. */
const processWorkAsync = async (
  work: FlowDurableWork,
  input: Parameters<typeof runDurableWorkerAsync>[0],
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
): Promise<FlowWorkerOutcome> => {
  const { lease } = work;
  if (lease === undefined) return { status: 'lost_lease', workId: work.id };
  const run = await dependencies.persistence.readRunAsync(work.runId);
  if (run === undefined || run.status === 'cancelled') {
    await completeAsync(work, input.workerId, dependencies);
    return { status: 'cancelled', workId: work.id };
  }
  if (isCompleted(run.checkpoint, work.stepId)) {
    await completeAsync(work, input.workerId, dependencies);
    return { status: 'already_completed', workId: work.id };
  }
  try {
    const outbox = await prepareOutboxAsync(work, dependencies);
    if (outbox.status === 'delivered') {
      const transitioned = await transitionAsync(
        run,
        'succeeded',
        completedCheckpoint(run.checkpoint, work.stepId),
        dependencies,
      );
      const completed = await completeAsync(work, input.workerId, dependencies);
      return {
        status: transitioned && completed ? 'already_completed' : 'lost_lease',
        workId: work.id,
      };
    }
    const effectStatus = await executeEffectAsync(work, run, dependencies);
    await dependencies.persistence.markOutboxDeliveredAsync(work.id);
    const transitioned = await transitionAsync(
      run,
      'succeeded',
      completedCheckpoint(run.checkpoint, work.stepId),
      dependencies,
    );
    if (!transitioned || !(await completeAsync(work, input.workerId, dependencies)))
      return { status: 'lost_lease', workId: work.id };
    return { status: effectStatus, workId: work.id };
  } catch (error) {
    if (isApprovalPending(error)) return waitForApprovalAsync(work, run, input, dependencies);
    return retryOrFailAsync(work, run, input, dependencies, error);
  }
};

/** Create an idempotency-keyed outbox record before delivery, or resume its pending record after a crash. */
const prepareOutboxAsync = async (
  work: FlowDurableWork,
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
) => {
  const existing = await dependencies.persistence.readOutboxAsync(work.id);
  if (existing !== undefined) return existing;
  const now = dependencies.clock.now().toISOString();
  await dependencies.persistence.createOutboxAsync({
    createdAt: now,
    id: work.id,
    idempotencyKey: work.idempotencyKey ?? work.id,
    runId: work.runId,
    status: 'pending',
    workId: work.id,
  });
  const created = await dependencies.persistence.readOutboxAsync(work.id);
  if (created === undefined) throw new Error('FLOW_OUTBOX_CREATE_FAILED');
  return created;
};

/** Runs internal work directly, while protected provider work requires reconciliation and a canonical permit. */
const executeEffectAsync = async (
  work: FlowDurableWork,
  run: FlowDurableRun,
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
): Promise<'succeeded'> => {
  const execute = () =>
    dependencies.effects.executeAsync({
      idempotencyKey: work.idempotencyKey ?? work.id,
      run,
      work,
    });
  if (work.effectKind === 'internal') {
    if (work.securityOperation !== undefined)
      throw new Error('FLOW_INTERNAL_EFFECT_SECURITY_OPERATION');
    await execute();
    return 'succeeded';
  }
  if (work.securityOperation === undefined)
    throw new Error('FLOW_PROTECTED_EFFECT_SECURITY_OPERATION');
  if (dependencies.security === undefined) throw new Error('FLOW_SECURITY_PORT_REQUIRED');
  if (dependencies.effects.reconcileAsync === undefined)
    throw new Error('FLOW_PROTECTED_EFFECT_RECONCILIATION_REQUIRED');
  if (
    (await dependencies.effects.reconcileAsync({
      idempotencyKey: work.idempotencyKey ?? work.id,
      run,
      work,
    })) === 'delivered'
  )
    return 'succeeded';
  const permit = await dependencies.security.authorizeAsync(work.securityOperation);
  await permit.executeAsync(async () => execute());
  return 'succeeded';
};

/** Persist a waiting approval and defer its at-least-once delivery without consuming the lease. */
const waitForApprovalAsync = async (
  work: FlowDurableWork,
  run: FlowDurableRun,
  input: Parameters<typeof runDurableWorkerAsync>[0],
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
): Promise<FlowWorkerOutcome> => {
  const transitioned = await transitionAsync(run, 'waiting_approval', run.checkpoint, dependencies);
  const released = await dependencies.persistence.releaseWorkAsync({
    dueAt: new Date(
      dependencies.clock.now().getTime() + input.approvalPollIntervalMs,
    ).toISOString(),
    id: work.id,
    leaseFencingToken: claimFencingToken(work),
    workerId: input.workerId,
  });
  return { status: transitioned && released ? 'waiting_approval' : 'lost_lease', workId: work.id };
};

/** Persist a bounded retry or terminal failure before releasing the claimed delivery. */
const retryOrFailAsync = async (
  work: FlowDurableWork,
  run: FlowDurableRun,
  input: Parameters<typeof runDurableWorkerAsync>[0],
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
  error: unknown,
): Promise<FlowWorkerOutcome> => {
  if (work.attempt >= input.retry.maxAttempts) {
    await dependencies.effects.compensateAsync?.({ run, work });
    const transitioned = await transitionAsync(
      run,
      'failed',
      failedCheckpoint(run.checkpoint, work.stepId),
      dependencies,
    );
    const completed = await completeAsync(work, input.workerId, dependencies);
    return {
      error: errorMessage(error),
      status: transitioned && completed ? 'failed' : 'lost_lease',
      workId: work.id,
    };
  }
  await dependencies.persistence.enqueueWorkAsync(
    createRetryWork(work, dependencies.clock.now(), input.retry),
  );
  const completed = await completeAsync(work, input.workerId, dependencies);
  return {
    error: errorMessage(error),
    status: completed ? 'retry_scheduled' : 'lost_lease',
    workId: work.id,
  };
};

/** Compare-and-swap a run state while preserving its immutable flow revision. */
const transitionAsync = (
  run: FlowDurableRun,
  status: FlowDurableRun['status'],
  checkpoint: FlowRunCheckpoint | undefined,
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
): Promise<boolean> =>
  dependencies.persistence.transitionRunAsync({
    expectedRevision: run.revision,
    run: {
      ...run,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      revision: run.revision + 1,
      status,
      updatedAt: dependencies.clock.now().toISOString(),
    },
  });

/** Complete a work lease only when its owner and fencing token still match. */
const completeAsync = (
  work: FlowDurableWork,
  workerId: string,
  dependencies: Parameters<typeof runDurableWorkerAsync>[1],
): Promise<boolean> =>
  dependencies.persistence.completeWorkAsync({
    id: work.id,
    leaseFencingToken: claimFencingToken(work),
    now: dependencies.clock.now(),
    workerId,
  });

/** Read the lease token only from a claimed work item. */
const claimFencingToken = (work: FlowDurableWork): number => {
  if (work.lease === undefined) throw new Error('FLOW_WORK_LEASE_MISSING');
  return work.lease.fencingToken;
};

/** Add a successful step exactly once to an immutable checkpoint. */
const completedCheckpoint = (
  checkpoint: FlowRunCheckpoint | undefined,
  stepId: string | undefined,
): FlowRunCheckpoint => ({
  completedStepIds: unique([
    ...(checkpoint?.completedStepIds ?? []),
    ...(stepId === undefined ? [] : [stepId]),
  ]),
  ...(checkpoint?.data === undefined ? {} : { data: checkpoint.data }),
  failedStepIds: checkpoint?.failedStepIds ?? [],
});

/** Add a terminally failed step to an immutable checkpoint. */
const failedCheckpoint = (
  checkpoint: FlowRunCheckpoint | undefined,
  stepId: string | undefined,
): FlowRunCheckpoint => ({
  completedStepIds: checkpoint?.completedStepIds ?? [],
  ...(checkpoint?.data === undefined ? {} : { data: checkpoint.data }),
  failedStepIds: unique([
    ...(checkpoint?.failedStepIds ?? []),
    ...(stepId === undefined ? [] : [stepId]),
  ]),
});

/** Check whether a completed checkpoint makes a duplicate delivery a no-op. */
const isCompleted = (
  checkpoint: FlowRunCheckpoint | undefined,
  stepId: string | undefined,
): boolean => stepId !== undefined && checkpoint?.completedStepIds.includes(stepId) === true;

/** Validate finite worker bounds before touching persistence. */
const assertWorkerInput = (input: Parameters<typeof runDurableWorkerAsync>[0]): void => {
  for (const value of [
    input.approvalPollIntervalMs,
    input.concurrency,
    input.leaseDurationMs,
    input.limit,
    input.retry.maxAttempts,
  ])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('FLOW_WORKER_INPUT_INVALID');
};

/** Identify the canonical pending-approval error without interpreting untrusted error shapes. */
const isApprovalPending = (error: unknown): boolean =>
  error instanceof FlowSecurityError && error.code === 'approval_pending';

/** Preserve a concise, provider-neutral failure signal in the worker result. */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'FLOW_EFFECT_FAILED';

/** Keep persisted checkpoint arrays deterministic. */
const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

/** Application-owned effect boundary; adapters must apply the supplied idempotency key at their side-effect boundary. */
export interface FlowDurableEffectPort {
  readonly compensateAsync?: (input: {
    readonly run: FlowDurableRun;
    readonly work: FlowDurableWork;
  }) => Promise<void>;
  readonly executeAsync: (input: {
    readonly idempotencyKey: string;
    readonly run: FlowDurableRun;
    readonly work: FlowDurableWork;
  }) => Promise<void>;
  /**
   * Query the provider's idempotency boundary before a protected replay. A provider must return
   * `delivered` only when the stable key proves that the original effect completed.
   */
  readonly reconcileAsync?: (input: {
    readonly idempotencyKey: string;
    readonly run: FlowDurableRun;
    readonly work: FlowDurableWork;
  }) => Promise<'delivered' | 'unknown'>;
}

/** Observable outcome for every delivery claimed by one bounded worker tick. */
export interface FlowWorkerOutcome {
  readonly error?: string;
  readonly status:
    | 'already_completed'
    | 'cancelled'
    | 'failed'
    | 'lost_lease'
    | 'retry_scheduled'
    | 'succeeded'
    | 'waiting_approval';
  readonly workId: string;
}

/** Summary of one worker tick; delivery remains at-least-once until fenced completion. */
export interface FlowWorkerResult {
  readonly claimedWorkIds: readonly string[];
  readonly outcomes: readonly FlowWorkerOutcome[];
  readonly recoveredWorkIds: readonly string[];
}
