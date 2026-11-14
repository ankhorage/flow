import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { FlowDurableRun, FlowDurableWork } from '../../../types/durableExecution.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';

/*** Create a self-hostable, single-process JSON persistence adapter for durable Flow state. */
export const FileFlowPersistenceAdapter = (path: string): FlowPersistencePort => {
  const persistencePath = resolve(path);
  const serializedCall = getSerializedCall(persistencePath);
  return {
    claimDueWorkAsync: (input) =>
      serializedCall.runAsync(() => claimDueWorkAsync(persistencePath, input)),
    completeWorkAsync: (input) =>
      serializedCall.runAsync(() => completeWorkAsync(persistencePath, input)),
    createRunAsync: (run) => serializedCall.runAsync(() => createRunAsync(persistencePath, run)),
    enqueueWorkAsync: (work) =>
      serializedCall.runAsync(() => enqueueWorkAsync(persistencePath, work)),
    readRunAsync: (id) => serializedCall.runAsync(() => readRunAsync(persistencePath, id)),
    recoverExpiredClaimsAsync: (now) =>
      serializedCall.runAsync(() => recoverExpiredClaimsAsync(persistencePath, now)),
    transitionRunAsync: (input) =>
      serializedCall.runAsync(() => transitionRunAsync(persistencePath, input)),
  };
};

interface FileFlowStore {
  readonly nextLeaseFencingToken: number;
  readonly runs: readonly FlowDurableRun[];
  readonly work: readonly FlowDurableWork[];
}

interface SerializedCall {
  readonly runAsync: <Result>(operation: () => Promise<Result>) => Promise<Result>;
}

const serializedCallsByPath = new Map<string, SerializedCall>();

/*** Share serialization for every adapter instance targeting one normalized persistence path. */
const getSerializedCall = (path: string): SerializedCall => {
  const existing = serializedCallsByPath.get(path);
  if (existing !== undefined) return existing;
  const serializedCall = createSerializedCall();
  serializedCallsByPath.set(path, serializedCall);
  return serializedCall;
};

/*** Serialize one file path so concurrent callbacks cannot claim or overwrite the same state. */
const createSerializedCall = (): SerializedCall => {
  let previous = Promise.resolve();
  return {
    runAsync: async (operation) => {
      const current = previous.then(operation, operation);
      previous = current.then(
        () => undefined,
        () => undefined,
      );
      return current;
    },
  };
};

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
      .map((work, index) => claimWork(work, input, store.nextLeaseFencingToken + index));
    return {
      result: claimed,
      store: {
        ...store,
        nextLeaseFencingToken: store.nextLeaseFencingToken + claimed.length,
        work: replaceWork(store.work, claimed),
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
      store: { ...store, work: replaceWork(store.work, [{ ...work, status: 'completed' }]) },
    };
  });

/*** Persist a new run once, rejecting a duplicate durable identity. */
const createRunAsync = async (path: string, run: FlowDurableRun): Promise<void> =>
  updateStoreAsync(path, (store) => {
    if (store.runs.some((candidate) => candidate.id === run.id))
      throw new Error(`FLOW_RUN_EXISTS:${run.id}`);
    return { result: undefined, store: { ...store, runs: [...store.runs, copy(run)] } };
  });

/*** Persist one immutable work identity once, rejecting duplicate delivery records. */
const enqueueWorkAsync = async (path: string, work: FlowDurableWork): Promise<void> =>
  updateStoreAsync(path, (store) => {
    if (store.work.some((candidate) => candidate.id === work.id))
      throw new Error(`FLOW_WORK_EXISTS:${work.id}`);
    return { result: undefined, store: { ...store, work: [...store.work, copy(work)] } };
  });

/*** Read a copied run snapshot so callers cannot mutate persisted state in-place. */
const readRunAsync = async (path: string, id: string): Promise<FlowDurableRun | undefined> =>
  copy((await readStoreAsync(path)).runs.find((run) => run.id === id));

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
      store: { ...store, work: replaceWork(store.work, recovered) },
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
    return { result: true, store: { ...store, runs: replaceRuns(store.runs, [copy(run)]) } };
  });

/*** Build a claimed work record with an explicit bounded lease. */
const claimWork = (
  work: FlowDurableWork,
  input: Parameters<FlowPersistencePort['claimDueWorkAsync']>[0],
  fencingToken: number,
): FlowDurableWork => ({
  ...work,
  lease: {
    expiresAt: new Date(input.now.getTime() + input.leaseDurationMs).toISOString(),
    fencingToken,
    workerId: input.workerId,
  },
  status: 'claimed',
});

/*** Replace changed work entries by identity without exposing a mutable adapter collection. */
const replaceWork = (
  work: readonly FlowDurableWork[],
  replacements: readonly FlowDurableWork[],
): readonly FlowDurableWork[] =>
  work.map(
    (candidate) => replacements.find((replacement) => replacement.id === candidate.id) ?? candidate,
  );

/*** Replace changed run entries by identity without exposing a mutable adapter collection. */
const replaceRuns = (
  runs: readonly FlowDurableRun[],
  replacements: readonly FlowDurableRun[],
): readonly FlowDurableRun[] =>
  runs.map(
    (candidate) => replacements.find((replacement) => replacement.id === candidate.id) ?? candidate,
  );

/*** Read persisted state or initialize an empty store when it has not yet been created. */
const readStoreAsync = async (path: string): Promise<FileFlowStore> => {
  try {
    return readFileStore(JSON.parse(await readFile(path, 'utf8')));
  } catch (reason) {
    if (isMissingFile(reason)) return { nextLeaseFencingToken: 1, runs: [], work: [] };
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
    !Array.isArray(value.work)
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
