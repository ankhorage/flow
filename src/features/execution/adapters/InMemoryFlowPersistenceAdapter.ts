import type {
  FlowDurableEffectResult,
  FlowDurableRun,
  FlowDurableWork,
  FlowOutboxRecord,
} from '../../../types/durableExecution.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';

/*** Provide the canonical durable persistence contract for embedded tests and local composition. */
export const InMemoryFlowPersistenceAdapter = (): FlowPersistencePort => {
  const state = createState();
  return {
    cancelRunWorkAsync: (runId) => Promise.resolve(cancelRunWork(state, runId)),
    claimDueWorkAsync: (input) => Promise.resolve(claimDueWork(state, input)),
    completeWorkAsync: (input) => Promise.resolve(completeWork(state, input)),
    createOutboxAsync: (record) => Promise.resolve(createOutbox(state, record)),
    createRunAsync: (run) => Promise.resolve(createRun(state, run)),
    enqueueWorkAsync: (work) => Promise.resolve(enqueueWork(state, work)),
    finalizeWorkAsync: (input) => Promise.resolve(finalizeWork(state, input)),
    markOutboxDeliveredAsync: (id, result) =>
      Promise.resolve(markOutboxDelivered(state, id, result)),
    readOutboxAsync: (id) => Promise.resolve(state.outbox.get(id)),
    readRunAsync: (id) => Promise.resolve(state.runs.get(id)),
    readWorkAsync: (id) => Promise.resolve(state.work.get(id)),
    recoverExpiredClaimsAsync: (now) => Promise.resolve(recoverExpiredClaims(state, now)),
    releaseWorkAsync: (input) => Promise.resolve(releaseWork(state, input)),
    transitionRunAsync: (input) => Promise.resolve(transitionRun(state, input)),
    verifyClaimAsync: (input) => Promise.resolve(verifyClaim(state, input)),
  };
};

interface State {
  readonly outbox: Map<string, FlowOutboxRecord>;
  readonly runs: Map<string, FlowDurableRun>;
  nextToken: number;
  readonly work: Map<string, FlowDurableWork>;
}

/*** Initialize one isolated, mutable adapter boundary. */
const createState = (): State => ({
  outbox: new Map(),
  nextToken: 1,
  runs: new Map(),
  work: new Map(),
});

/*** Cancel each active work item associated with one durable run. */
const cancelRunWork = (state: State, runId: string): readonly string[] => {
  const cancelled = [...state.work.values()].filter(
    (work) => work.runId === runId && work.status !== 'completed',
  );
  cancelled.forEach((work) =>
    state.work.set(work.id, { ...work, lease: undefined, status: 'cancelled' }),
  );
  return cancelled.map((work) => work.id);
};

/*** Lease bounded due work with a monotonically increasing fencing token. */
const claimDueWork = (
  state: State,
  input: Parameters<FlowPersistencePort['claimDueWorkAsync']>[0],
): readonly FlowDurableWork[] => {
  const claimed = [...state.work.values()]
    .filter((work) => work.status === 'ready' && work.dueAt <= input.now.toISOString())
    .slice(0, input.limit)
    .map((work) => ({
      ...work,
      lease: {
        expiresAt: new Date(input.now.getTime() + input.leaseDurationMs).toISOString(),
        fencingToken: state.nextToken++,
        workerId: input.workerId,
      },
      status: 'claimed' as const,
    }));
  claimed.forEach((work) => state.work.set(work.id, work));
  return claimed;
};

/*** Complete only the exact current lease. */
const completeWork = (
  state: State,
  input: Parameters<FlowPersistencePort['completeWorkAsync']>[0],
): boolean => {
  const work = state.work.get(input.id);
  if (work?.lease === undefined) return false;
  if (work.lease.fencingToken !== input.leaseFencingToken || work.lease.workerId !== input.workerId)
    return false;
  state.work.set(input.id, { ...work, lease: undefined, status: 'completed' });
  return true;
};

/*** Persist one outbox record exactly once. */
const createOutbox = (state: State, record: FlowOutboxRecord): void =>
  void state.outbox.set(record.id, state.outbox.get(record.id) ?? record);
/*** Persist one run exactly once. */
const createRun = (state: State, run: FlowDurableRun): void =>
  void state.runs.set(run.id, state.runs.get(run.id) ?? run);
/*** Persist one work record exactly once. */
const enqueueWork = (state: State, work: FlowDurableWork): void =>
  void state.work.set(work.id, state.work.get(work.id) ?? work);
/** Atomically retain a fenced checkpoint and every successor before releasing its predecessor lease. */
const finalizeWork = (
  state: State,
  input: Parameters<FlowPersistencePort['finalizeWorkAsync']>[0],
): boolean => {
  const work = state.work.get(input.workId);
  const lease = work?.lease;
  if (work?.status !== 'claimed' || lease === undefined) return false;
  if (
    lease.fencingToken !== input.leaseFencingToken ||
    lease.workerId !== input.workerId ||
    lease.expiresAt <= input.now.toISOString() ||
    state.runs.get(input.run.id)?.revision !== input.expectedRevision
  )
    return false;
  state.runs.set(input.run.id, input.run);
  state.work.set(input.workId, { ...work, lease: undefined, status: 'completed' });
  input.nextWork.forEach((next) => enqueueWork(state, next));
  return true;
};
/*** Mark an existing outbox record delivered. */
const markOutboxDelivered = (
  state: State,
  id: string,
  result?: FlowDurableEffectResult,
): boolean => {
  const record = state.outbox.get(id);
  if (record === undefined) return false;
  state.outbox.set(id, {
    ...record,
    ...(result === undefined ? {} : { result }),
    status: 'delivered',
  });
  return true;
};
/*** Recover every lease that expired before a replacement worker arrived. */
const recoverExpiredClaims = (state: State, now: Date): readonly string[] => {
  const recovered = [...state.work.values()].filter(
    (work) =>
      work.status === 'claimed' &&
      work.lease !== undefined &&
      work.lease.expiresAt <= now.toISOString(),
  );
  recovered.forEach((work) =>
    state.work.set(work.id, { ...work, lease: undefined, status: 'ready' }),
  );
  return recovered.map((work) => work.id);
};
/*** Return a fenced lease to the ready queue. */
const releaseWork = (
  state: State,
  input: Parameters<FlowPersistencePort['releaseWorkAsync']>[0],
): boolean => {
  const work = state.work.get(input.id);
  if (
    work?.lease?.fencingToken !== input.leaseFencingToken ||
    work.lease.workerId !== input.workerId
  )
    return false;
  state.work.set(input.id, { ...work, dueAt: input.dueAt, lease: undefined, status: 'ready' });
  return true;
};
/*** Compare-and-swap one durable run revision. */
const transitionRun = (
  state: State,
  input: Parameters<FlowPersistencePort['transitionRunAsync']>[0],
): boolean => {
  if (state.runs.get(input.run.id)?.revision !== input.expectedRevision) return false;
  state.runs.set(input.run.id, input.run);
  return true;
};
/** Verify the fence immediately before delivery so stale workers cannot enter a provider boundary. */
const verifyClaim = (
  state: State,
  input: Parameters<FlowPersistencePort['verifyClaimAsync']>[0],
): boolean => {
  const work = state.work.get(input.workId);
  return (
    work?.status === 'claimed' &&
    work.lease?.fencingToken === input.leaseFencingToken &&
    work.lease.workerId === input.workerId &&
    work.lease.expiresAt > input.now.toISOString()
  );
};
