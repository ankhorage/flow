import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  FlowDurableEffectResult,
  FlowDurableRun,
  FlowDurableWork,
  FlowOutboxRecord,
} from '../../../types/durableExecution.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';
import {
  claimFileFlowWork,
  createFileFlowPersistenceSupport,
  replaceFileFlowOutbox,
  replaceFileFlowRuns,
  replaceFileFlowWork,
} from './createFileFlowPersistenceSupport.js';

/*** Create a self-hostable, single-process JSON persistence adapter for durable Flow state. */
export const FileFlowPersistenceAdapter = (path: string): FlowPersistencePort => {
  const persistencePath = resolve(path);
  const support = createFileFlowPersistenceSupport(persistencePath);
  return {
    cancelRunWorkAsync: (runId) =>
      support.runAsync(() => cancelRunWorkAsync(persistencePath, runId)),
    claimDueWorkAsync: (input) => support.runAsync(() => claimDueWorkAsync(persistencePath, input)),
    completeWorkAsync: (input) => support.runAsync(() => completeWorkAsync(persistencePath, input)),
    createOutboxAsync: (record) =>
      support.runAsync(() => createOutboxAsync(persistencePath, record)),
    createRunAsync: (run) => support.runAsync(() => createRunAsync(persistencePath, run)),
    enqueueWorkAsync: (work) => support.runAsync(() => enqueueWorkAsync(persistencePath, work)),
    finalizeWorkAsync: (input) => support.runAsync(() => finalizeWorkAsync(persistencePath, input)),
    markOutboxDeliveredAsync: (id, result) =>
      support.runAsync(() => markOutboxDeliveredAsync(persistencePath, id, result)),
    readOutboxAsync: (id) => support.runAsync(() => readOutboxAsync(persistencePath, id)),
    readRunAsync: (id) => support.runAsync(() => readRunAsync(persistencePath, id)),
    readWorkAsync: (id) => support.runAsync(() => readWorkAsync(persistencePath, id)),
    recoverExpiredClaimsAsync: (now) =>
      support.runAsync(() => recoverExpiredClaimsAsync(persistencePath, now)),
    releaseWorkAsync: (input) => support.runAsync(() => releaseWorkAsync(persistencePath, input)),
    transitionRunAsync: (input) =>
      support.runAsync(() => transitionRunAsync(persistencePath, input)),
    verifyClaimAsync: (input) => support.runAsync(() => verifyClaimAsync(persistencePath, input)),
  };
};

/** Cancel every nonterminal delivery for a run after its durable cancellation transition. */
const cancelRunWorkAsync = async (path: string, runId: string): Promise<readonly string[]> =>
  updateStoreAsync(path, (store) => {
    const cancelled = store.work
      .filter(
        (work) => work.runId === runId && (work.status === 'ready' || work.status === 'claimed'),
      )
      .map((work) => ({ ...work, lease: undefined, status: 'cancelled' as const }));
    return {
      result: cancelled.map((work) => work.id),
      store: { ...store, work: replaceFileFlowWork(store.work, cancelled) },
    };
  });

interface FileFlowStore {
  readonly nextLeaseFencingToken: number;
  readonly outbox: readonly FlowOutboxRecord[];
  readonly runs: readonly FlowDurableRun[];
  readonly work: readonly FlowDurableWork[];
}

/** Persist a stable outbox identity before any external effect is attempted. */
const createOutboxAsync = async (path: string, record: FlowOutboxRecord): Promise<void> =>
  updateStoreAsync(path, (store) => {
    const existing = store.outbox.find((candidate) => candidate.id === record.id);
    if (existing !== undefined && existing.idempotencyKey !== record.idempotencyKey)
      throw new Error(`FLOW_OUTBOX_CONFLICT:${record.id}`);
    return {
      result: undefined,
      store: existing === undefined ? { ...store, outbox: [...store.outbox, copy(record)] } : store,
    };
  });

/*** Claim due work in stable order and record a lease before it is returned to a worker. */
const claimDueWorkAsync = async (
  path: string,
  input: Parameters<FlowPersistencePort['claimDueWorkAsync']>[0],
): Promise<readonly FlowDurableWork[]> =>
  updateStoreAsync(path, (store) => {
    const claimed = store.work
      .filter((work) => work.status === 'ready' && work.dueAt <= input.now.toISOString())
      .sort(
        (left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit)
      .map((work, index) => claimFileFlowWork(work, input, store.nextLeaseFencingToken + index));
    return {
      result: claimed,
      store: {
        ...store,
        nextLeaseFencingToken: store.nextLeaseFencingToken + claimed.length,
        work: replaceFileFlowWork(store.work, claimed),
      },
    };
  });

/*** Complete only the unexpired fenced lease returned by the successful claim. */
const completeWorkAsync = async (
  path: string,
  { id, leaseFencingToken, now, workerId }: Parameters<FlowPersistencePort['completeWorkAsync']>[0],
): Promise<boolean> =>
  updateStoreAsync(path, (store) => {
    const work = store.work.find((candidate) => candidate.id === id);
    if (
      work?.status !== 'claimed' ||
      work.lease?.workerId !== workerId ||
      work.lease.fencingToken !== leaseFencingToken ||
      work.lease.expiresAt <= now.toISOString()
    )
      return { result: false, store };
    return {
      result: true,
      store: {
        ...store,
        work: replaceFileFlowWork(store.work, [{ ...work, status: 'completed' }]),
      },
    };
  });

/*** Persist a new run once, rejecting a duplicate durable identity. */
const createRunAsync = async (path: string, run: FlowDurableRun): Promise<void> =>
  updateStoreAsync(path, (store) => {
    const existing = store.runs.find((candidate) => candidate.id === run.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(run))
      throw new Error(`FLOW_RUN_CONFLICT:${run.id}`);
    return {
      result: undefined,
      store: existing === undefined ? { ...store, runs: [...store.runs, copy(run)] } : store,
    };
  });

/*** Persist one immutable work identity once, rejecting duplicate delivery records. */
const enqueueWorkAsync = async (path: string, work: FlowDurableWork): Promise<void> =>
  updateStoreAsync(path, (store) => {
    const existing = store.work.find((candidate) => candidate.id === work.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(work))
      throw new Error(`FLOW_WORK_CONFLICT:${work.id}`);
    return {
      result: undefined,
      store: existing === undefined ? { ...store, work: [...store.work, copy(work)] } : store,
    };
  });

/** Atomically commit a fenced checkpoint, complete its source lease, and materialize successors. */
const finalizeWorkAsync = async (
  path: string,
  input: Parameters<FlowPersistencePort['finalizeWorkAsync']>[0],
): Promise<boolean> =>
  updateStoreAsync(path, (store) => {
    const work = store.work.find((candidate) => candidate.id === input.workId);
    const current = store.runs.find((candidate) => candidate.id === input.run.id);
    if (
      work?.status !== 'claimed' ||
      work.lease?.workerId !== input.workerId ||
      work.lease.fencingToken !== input.leaseFencingToken ||
      work.lease.expiresAt <= input.now.toISOString() ||
      current?.revision !== input.expectedRevision ||
      !sameFlow(current, input.run) ||
      input.run.revision !== input.expectedRevision + 1
    )
      return { result: false, store };
    const conflicting = input.nextWork.some((next) =>
      store.work.some((candidate) => candidate.id === next.id && candidate.runId !== next.runId),
    );
    if (conflicting) throw new Error('FLOW_WORK_CONFLICT');
    const newWork = input.nextWork.filter(
      (next) => !store.work.some((candidate) => candidate.id === next.id),
    );
    return {
      result: true,
      store: {
        ...store,
        runs: replaceFileFlowRuns(store.runs, [copy(input.run)]),
        work: [
          ...replaceFileFlowWork(store.work, [{ ...work, lease: undefined, status: 'completed' }]),
          ...newWork.map(copy),
        ],
      },
    };
  });

/** Mark an effect delivery complete; duplicate marks are harmless and do not rerun the effect. */
const markOutboxDeliveredAsync = async (
  path: string,
  id: string,
  result?: FlowDurableEffectResult,
): Promise<boolean> =>
  updateStoreAsync(path, (store) => {
    const record = store.outbox.find((candidate) => candidate.id === id);
    if (record === undefined) return { result: false, store };
    return {
      result: true,
      store: {
        ...store,
        outbox: replaceFileFlowOutbox(store.outbox, [
          { ...record, ...(result === undefined ? {} : { result }), status: 'delivered' },
        ]),
      },
    };
  });

/** Read a copied outbox snapshot without exposing adapter-owned mutable state. */
const readOutboxAsync = async (path: string, id: string): Promise<FlowOutboxRecord | undefined> =>
  copy((await readStoreAsync(path)).outbox.find((record) => record.id === id));

/*** Read a copied run snapshot so callers cannot mutate persisted state in-place. */
const readRunAsync = async (path: string, id: string): Promise<FlowDurableRun | undefined> =>
  copy((await readStoreAsync(path)).runs.find((run) => run.id === id));

/** Read a copied work snapshot so recovery can resume a torn enqueue without duplicating it. */
const readWorkAsync = async (path: string, id: string): Promise<FlowDurableWork | undefined> =>
  copy((await readStoreAsync(path)).work.find((work) => work.id === id));

/*** Make expired claims available for recovery after a worker crash or stop. */
const recoverExpiredClaimsAsync = async (path: string, now: Date): Promise<readonly string[]> =>
  updateStoreAsync(path, (store) => {
    const recovered = store.work
      .filter(
        (work) =>
          work.status === 'claimed' &&
          work.lease?.expiresAt !== undefined &&
          work.lease.expiresAt <= now.toISOString(),
      )
      .map((work) => ({ ...work, lease: undefined, status: 'ready' as const }));
    return {
      result: recovered.map((work) => work.id),
      store: { ...store, work: replaceFileFlowWork(store.work, recovered) },
    };
  });

/** Return a fenced claim to the queue without permitting a stale worker to reschedule it. */
const releaseWorkAsync = async (
  path: string,
  input: Parameters<FlowPersistencePort['releaseWorkAsync']>[0],
): Promise<boolean> =>
  updateStoreAsync(path, (store) => {
    const work = store.work.find((candidate) => candidate.id === input.id);
    if (
      work?.status !== 'claimed' ||
      work.lease?.workerId !== input.workerId ||
      work.lease.fencingToken !== input.leaseFencingToken
    )
      return { result: false, store };
    return {
      result: true,
      store: {
        ...store,
        work: replaceFileFlowWork(store.work, [
          { ...work, dueAt: input.dueAt, lease: undefined, status: 'ready' },
        ]),
      },
    };
  });

/*** Store a revision-checked run transition while preserving its immutable flow reference. */
const transitionRunAsync = async (
  path: string,
  { expectedRevision, run }: Parameters<FlowPersistencePort['transitionRunAsync']>[0],
): Promise<boolean> =>
  updateStoreAsync(path, (store) => {
    const current = store.runs.find((candidate) => candidate.id === run.id);
    if (!sameFlow(current ?? run, run) || current?.revision !== expectedRevision)
      return { result: false, store };
    if (run.revision !== expectedRevision + 1) throw new Error('FLOW_RUN_REVISION_INVALID');
    return {
      result: true,
      store: { ...store, runs: replaceFileFlowRuns(store.runs, [copy(run)]) },
    };
  });

/** Verify one unexpired fenced lease immediately before the provider boundary. */
const verifyClaimAsync = async (
  path: string,
  input: Parameters<FlowPersistencePort['verifyClaimAsync']>[0],
): Promise<boolean> =>
  updateStoreAsync(path, (store) => {
    const work = store.work.find((candidate) => candidate.id === input.workId);
    const valid =
      work?.status === 'claimed' &&
      work.lease?.fencingToken === input.leaseFencingToken &&
      work.lease.workerId === input.workerId &&
      work.lease.expiresAt > input.now.toISOString();
    return { result: valid, store };
  });

/*** Read persisted state or initialize an empty store when it has not yet been created. */
const readStoreAsync = async (path: string): Promise<FileFlowStore> => {
  try {
    return readFileStore(JSON.parse(await readFile(path, 'utf8')));
  } catch (reason) {
    if (isMissingFile(reason)) return { nextLeaseFencingToken: 1, outbox: [], runs: [], work: [] };
    throw reason;
  }
};

/*** Validate the adapter-owned persistence envelope before using its fencing counter. */
const readFileStore = (value: unknown): FileFlowStore => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('nextLeaseFencingToken' in value) ||
    typeof value.nextLeaseFencingToken !== 'number' ||
    !Number.isSafeInteger(value.nextLeaseFencingToken) ||
    value.nextLeaseFencingToken < 1 ||
    !('runs' in value) ||
    !Array.isArray(value.runs) ||
    !('work' in value) ||
    !Array.isArray(value.work) ||
    !('outbox' in value) ||
    !Array.isArray(value.outbox)
  )
    throw new Error('FLOW_PERSISTENCE_INVALID');
  return value as FileFlowStore;
};

/*** Apply one single-process transaction and atomically replace the persisted JSON snapshot. */
const updateStoreAsync = async <Result>(
  path: string,
  update: (store: FileFlowStore) => { readonly result: Result; readonly store: FileFlowStore },
): Promise<Result> => {
  const updated = update(await readStoreAsync(path));
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(updated.store));
  await rename(temporaryPath, path);
  return copy(updated.result);
};

/*** Preserve adapter encapsulation by returning data that callers cannot mutate in-place. */
const copy = <Value>(value: Value): Value => structuredClone(value);

/*** Distinguish an absent first-run store from real filesystem or JSON errors. */
const isMissingFile = (reason: unknown): reason is NodeJS.ErrnoException =>
  typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'ENOENT';

/*** Reject a transition that attempts to repoint a run at another immutable flow revision. */
const sameFlow = (left: FlowDurableRun, right: FlowDurableRun): boolean =>
  left.flow.id === right.flow.id && left.flow.version === right.flow.version;
