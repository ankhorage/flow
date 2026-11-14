import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  FlowApprovalRequest,
  FlowDefinition,
  FlowRunSnapshot,
} from '@ankhorage/contracts/flow';

import type {
  FlowRunEvent,
  FlowRuntimeStorePort,
  FlowWorkflowRevision,
} from '../../../types/headless.js';

interface FileRuntimeState {
  readonly approvals: readonly FlowApprovalRequest[];
  readonly events: readonly FlowRunEvent[];
  readonly idempotency: readonly { readonly key: string; readonly runId: string }[];
  readonly runs: readonly FlowRunSnapshot[];
  readonly workflows: readonly {
    readonly flowId: string;
    readonly revisions: readonly FlowWorkflowRevision[];
  }[];
}
const emptyState = (): FileRuntimeState => ({
  approvals: [],
  events: [],
  idempotency: [],
  runs: [],
  workflows: [],
});

/** Create a self-hostable JSON runtime store with serialized, atomic state transitions. */
export const FileFlowRuntimeStore = (path: string): FlowRuntimeStorePort => {
  const storePath = resolve(path);
  const calls = createSerializedCall();
  return {
    createDraftAsync: (definition) => calls.runAsync(() => createDraftAsync(storePath, definition)),
    getRunAsync: (runId) => calls.runAsync(async () => findRun(await readAsync(storePath), runId)),
    getWorkflowAsync: (flowId, version) =>
      calls.runAsync(async () => findWorkflow(await readAsync(storePath), flowId, version)),
    listRunsAsync: (flowId) =>
      calls.runAsync(async () => listRuns(await readAsync(storePath), flowId)),
    listWorkflowRevisionsAsync: (flowId) =>
      calls.runAsync(
        async () => findWorkflowEntry(await readAsync(storePath), flowId)?.revisions ?? [],
      ),
    publishAsync: (flowId, version, publishedAt) =>
      calls.runAsync(() => publishAsync(storePath, flowId, version, publishedAt)),
    readEventsAsync: (afterId, runId) =>
      calls.runAsync(async () => listEvents(await readAsync(storePath), afterId, runId)),
    resolveApprovalAsync: (input) => calls.runAsync(() => resolveApprovalAsync(storePath, input)),
    saveApprovalAsync: (approval) => calls.runAsync(() => saveApprovalAsync(storePath, approval)),
    saveRunAsync: (run, key) => calls.runAsync(() => saveRunAsync(storePath, run, key)),
    transitionRunAsync: (input) => calls.runAsync(() => transitionRunAsync(storePath, input)),
  };
};

/** Serialize local file mutations so a worker cannot lose a completed transition. */
const createSerializedCall = () => {
  let previous: Promise<void> = Promise.resolve();
  return {
    runAsync: async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const current = previous.then(operation, operation);
      previous = current.then(
        () => undefined,
        () => undefined,
      );
      return current;
    },
  };
};

/** Create one immutable definition revision. */
const createDraftAsync = async (
  path: string,
  definition: FlowDefinition,
): Promise<FlowWorkflowRevision> =>
  updateAsync(path, (state) => {
    const revisions = findWorkflowEntry(state, definition.id)?.revisions ?? [];
    if (revisions.some((revision) => revision.definition.version === definition.version))
      throw new Error('FLOW_WORKFLOW_VERSION_EXISTS');
    const revision = { definition };
    return {
      result: revision,
      state: replaceWorkflow(state, definition.id, [...revisions, revision]),
    };
  });
/** Publish a known immutable revision without changing its graph. */
const publishAsync = async (
  path: string,
  flowId: string,
  version: number,
  publishedAt: string,
): Promise<FlowWorkflowRevision | undefined> =>
  updateAsync(path, (state) => {
    const revision = findWorkflow(state, flowId, version);
    if (revision === undefined) return { result: undefined, state };
    const published = { ...revision, publishedAt };
    const revisions = (findWorkflowEntry(state, flowId)?.revisions ?? []).map((candidate) =>
      candidate.definition.version === version ? published : candidate,
    );
    return { result: published, state: replaceWorkflow(state, flowId, revisions) };
  });
/** Persist one approval by its stable identity. */
const saveApprovalAsync = async (path: string, approval: FlowApprovalRequest): Promise<void> =>
  updateAsync(path, (state) => ({
    result: undefined,
    state: { ...state, approvals: replaceById(state.approvals, approval) },
  }));
/** Resolve a pending approval exactly once. */
const resolveApprovalAsync = async (
  path: string,
  input: Parameters<FlowRuntimeStorePort['resolveApprovalAsync']>[0],
): Promise<FlowApprovalRequest | undefined> =>
  updateAsync(path, (state) => {
    const current = state.approvals.find((approval) => approval.id === input.approvalId);
    if (current?.status !== 'pending') return { result: undefined, state };
    const approval = {
      ...current,
      resolvedAt: input.now,
      resolvedBy: input.actorId,
      status: input.approved ? ('approved' as const) : ('rejected' as const),
    };
    return {
      result: approval,
      state: { ...state, approvals: replaceById(state.approvals, approval) },
    };
  });
/** Save a run or return the original delivery for the same idempotency key. */
const saveRunAsync = async (
  path: string,
  run: FlowRunSnapshot,
  key?: string,
): Promise<FlowRunSnapshot> =>
  updateAsync(path, (state) => {
    const runId =
      key === undefined ? undefined : state.idempotency.find((entry) => entry.key === key)?.runId;
    const existing = runId === undefined ? undefined : findRun(state, runId);
    if (existing !== undefined) return { result: existing, state };
    if (findRun(state, run.id) !== undefined) throw new Error('FLOW_RUN_EXISTS');
    return {
      result: run,
      state: {
        ...state,
        idempotency:
          key === undefined ? state.idempotency : [...state.idempotency, { key, runId: run.id }],
        runs: [...state.runs, run],
      },
    };
  });
/** Guard a durable transition by current status and append its matching event. */
const transitionRunAsync = async (
  path: string,
  input: Parameters<FlowRuntimeStorePort['transitionRunAsync']>[0],
): Promise<boolean> =>
  updateAsync(path, (state) => {
    const current = findRun(state, input.run.id);
    if (current?.status !== input.expectedStatus) return { result: false, state };
    return {
      result: true,
      state: {
        ...state,
        events: [...state.events, { ...input.event, id: state.events.length + 1 }],
        runs: replaceById(state.runs, input.run),
      },
    };
  });
/** Read one snapshot, treating an uninitialized path as an empty installation. */
const readAsync = async (path: string): Promise<FileRuntimeState> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as FileRuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
};
/** Atomically replace a complete JSON snapshot after one state transition. */
const updateAsync = async <Result>(
  path: string,
  operation: (state: FileRuntimeState) => {
    readonly result: Result;
    readonly state: FileRuntimeState;
  },
): Promise<Result> => {
  const { result, state } = operation(await readAsync(path));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state), 'utf8');
  await rename(temporary, path);
  return result;
};
/** Find a run without indexing an untrusted identifier into a plain object. */
const findRun = (state: FileRuntimeState, runId: string): FlowRunSnapshot | undefined =>
  state.runs.find((run) => run.id === runId);
const findWorkflowEntry = (state: FileRuntimeState, flowId: string) =>
  state.workflows.find((entry) => entry.flowId === flowId);
const findWorkflow = (
  state: FileRuntimeState,
  flowId: string,
  version?: number,
): FlowWorkflowRevision | undefined => {
  const revisions = findWorkflowEntry(state, flowId)?.revisions ?? [];
  return version === undefined
    ? revisions.at(-1)
    : revisions.find((revision) => revision.definition.version === version);
};
const listRuns = (state: FileRuntimeState, flowId?: string): readonly FlowRunSnapshot[] =>
  state.runs.filter((run) => flowId === undefined || run.flow.id === flowId);
const listEvents = (
  state: FileRuntimeState,
  afterId: number,
  runId?: string,
): readonly FlowRunEvent[] =>
  state.events.filter(
    (event) => event.id > afterId && (runId === undefined || event.runId === runId),
  );
const replaceWorkflow = (
  state: FileRuntimeState,
  flowId: string,
  revisions: readonly FlowWorkflowRevision[],
): FileRuntimeState => ({
  ...state,
  workflows: [...state.workflows.filter((entry) => entry.flowId !== flowId), { flowId, revisions }],
});
const replaceById = <Value extends { readonly id: string }>(
  values: readonly Value[],
  replacement: Value,
): readonly Value[] => [...values.filter((value) => value.id !== replacement.id), replacement];
