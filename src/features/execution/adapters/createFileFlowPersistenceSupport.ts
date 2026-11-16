import type {
  FlowDurableRun,
  FlowDurableWork,
  FlowOutboxRecord,
} from '../../../types/durableExecution.js';
import type { FlowPersistencePort } from '../ports/FlowPersistencePort.js';

interface SerializedCall {
  readonly runAsync: <Result>(operation: () => Promise<Result>) => Promise<Result>;
}

const serializedCallsByPath = new Map<string, SerializedCall>();

/** Create the per-store serialization and identity replacement support used by file persistence. */
export const createFileFlowPersistenceSupport = (path: string) => ({
  runAsync: getSerializedCall(path).runAsync,
});

export const replaceFileFlowWork = (
  work: readonly FlowDurableWork[],
  replacements: readonly FlowDurableWork[],
): readonly FlowDurableWork[] =>
  work.map(
    (candidate) => replacements.find((replacement) => replacement.id === candidate.id) ?? candidate,
  );

export const replaceFileFlowRuns = (
  runs: readonly FlowDurableRun[],
  replacements: readonly FlowDurableRun[],
): readonly FlowDurableRun[] =>
  runs.map(
    (candidate) => replacements.find((replacement) => replacement.id === candidate.id) ?? candidate,
  );

export const replaceFileFlowOutbox = (
  records: readonly FlowOutboxRecord[],
  replacements: readonly FlowOutboxRecord[],
): readonly FlowOutboxRecord[] =>
  records.map(
    (candidate) => replacements.find((replacement) => replacement.id === candidate.id) ?? candidate,
  );

export const claimFileFlowWork = (
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

/** Share serialization for every adapter instance targeting the same normalized persistence path. */
const getSerializedCall = (path: string): SerializedCall => {
  const existing = serializedCallsByPath.get(path);
  if (existing !== undefined) return existing;
  const serializedCall = createSerializedCall();
  serializedCallsByPath.set(path, serializedCall);
  return serializedCall;
};

/** Serialize mutations so concurrent callbacks cannot claim or overwrite the same snapshot. */
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
