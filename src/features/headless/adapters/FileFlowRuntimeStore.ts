import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  FlowApprovalRequest,
  FlowDefinition,
  FlowRunSnapshot,
} from '@ankhorage/contracts/flow';

import type {
  FlowResourceScope,
  FlowRunEvent,
  FlowRuntimeStorePort,
  FlowWorkflowRevision,
} from '../../../types/headless.js';

interface FileRuntimeState {
  readonly approvals: readonly {
    readonly approval: FlowApprovalRequest;
    readonly scope: FlowResourceScope;
  }[];
  readonly events: readonly { readonly event: FlowRunEvent; readonly scope: FlowResourceScope }[];
  readonly idempotency: readonly {
    readonly key: string;
    readonly runId: string;
    readonly scope: FlowResourceScope;
  }[];
  readonly runs: readonly { readonly run: FlowRunSnapshot; readonly scope: FlowResourceScope }[];
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
    createDraftAsync: (scope, definition) =>
      calls.runAsync(() => createDraftAsync(storePath, scope, definition)),
    getRunAsync: (scope, runId) =>
      calls.runAsync(async () => findRun(await readAsync(storePath), scope, runId)),
    getWorkflowAsync: (scope, flowId, version) =>
      calls.runAsync(async () => findWorkflow(await readAsync(storePath), scope, flowId, version)),
    listRunsAsync: (scope, flowId) =>
      calls.runAsync(async () => listRuns(await readAsync(storePath), scope, flowId)),
    listWorkflowRevisionsAsync: (scope, flowId) =>
      calls.runAsync(
        async () => findWorkflowEntry(await readAsync(storePath), scope, flowId)?.revisions ?? [],
      ),
    publishAsync: (scope, flowId, version, publishedAt) =>
      calls.runAsync(() => publishAsync(storePath, scope, flowId, version, publishedAt)),
    readEventsAsync: (scope, afterId, runId) =>
      calls.runAsync(async () => listEvents(await readAsync(storePath), scope, afterId, runId)),
    resolveApprovalAsync: (input) => calls.runAsync(() => resolveApprovalAsync(storePath, input)),
    saveApprovalAsync: (scope, approval) =>
      calls.runAsync(() => saveApprovalAsync(storePath, scope, approval)),
    saveRunAsync: (scope, run, key) =>
      calls.runAsync(() => saveRunAsync(storePath, scope, run, key)),
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
  scope: FlowResourceScope,
  definition: FlowDefinition,
): Promise<FlowWorkflowRevision> =>
  updateAsync(path, (state) => {
    const revisions = findWorkflowEntry(state, scope, definition.id)?.revisions ?? [];
    if (revisions.some((revision) => revision.definition.version === definition.version))
      throw new Error('FLOW_WORKFLOW_VERSION_EXISTS');
    const revision = { definition, scope };
    return {
      result: revision,
      state: replaceWorkflow(state, scope, definition.id, [...revisions, revision]),
    };
  });
/** Publish a known immutable revision without changing its graph. */
const publishAsync = async (
  path: string,
  scope: FlowResourceScope,
  flowId: string,
  version: number,
  publishedAt: string,
): Promise<FlowWorkflowRevision | undefined> =>
  updateAsync(path, (state) => {
    const revision = findWorkflow(state, scope, flowId, version);
    if (revision === undefined) return { result: undefined, state };
    const published = { ...revision, publishedAt };
    const revisions = (findWorkflowEntry(state, scope, flowId)?.revisions ?? []).map((candidate) =>
      candidate.definition.version === version ? published : candidate,
    );
    return { result: published, state: replaceWorkflow(state, scope, flowId, revisions) };
  });
/** Persist one approval by its stable identity. */
const saveApprovalAsync = async (
  path: string,
  scope: FlowResourceScope,
  approval: FlowApprovalRequest,
): Promise<void> =>
  updateAsync(path, (state) => ({
    result: undefined,
    state: {
      ...state,
      approvals: replaceApproval(state.approvals, scope, approval),
    },
  }));
/** Resolve a pending approval exactly once. */
const resolveApprovalAsync = async (
  path: string,
  input: Parameters<FlowRuntimeStorePort['resolveApprovalAsync']>[0],
): Promise<FlowApprovalRequest | undefined> =>
  updateAsync(path, (state) => {
    const current = state.approvals.find(
      (entry) => sameScope(entry.scope, input.scope) && entry.approval.id === input.approvalId,
    )?.approval;
    if (current?.status !== 'pending') return { result: undefined, state };
    const approval = {
      ...current,
      resolvedAt: input.now,
      resolvedBy: input.actorId,
      status: input.approved ? ('approved' as const) : ('rejected' as const),
    };
    return {
      result: approval,
      state: {
        ...state,
        approvals: replaceApproval(state.approvals, input.scope, approval),
      },
    };
  });
/** Save a run or return the original delivery for the same idempotency key. */
const saveRunAsync = async (
  path: string,
  scope: FlowResourceScope,
  run: FlowRunSnapshot,
  key?: string,
): Promise<FlowRunSnapshot> =>
  updateAsync(path, (state) => {
    const runId =
      key === undefined
        ? undefined
        : state.idempotency.find((entry) => sameScope(entry.scope, scope) && entry.key === key)
            ?.runId;
    const existing = runId === undefined ? undefined : findRun(state, scope, runId);
    if (existing !== undefined) return { result: existing, state };
    if (findRun(state, scope, run.id) !== undefined) throw new Error('FLOW_RUN_EXISTS');
    return {
      result: run,
      state: {
        ...state,
        idempotency:
          key === undefined
            ? state.idempotency
            : [...state.idempotency, { key, runId: run.id, scope }],
        runs: [...state.runs, { run, scope }],
      },
    };
  });
/** Guard a durable transition by current status and append its matching event. */
const transitionRunAsync = async (
  path: string,
  input: Parameters<FlowRuntimeStorePort['transitionRunAsync']>[0],
): Promise<boolean> =>
  updateAsync(path, (state) => {
    const current = findRun(state, input.scope, input.run.id);
    if (current?.status !== input.expectedStatus) return { result: false, state };
    return {
      result: true,
      state: {
        ...state,
        events: [
          ...state.events,
          {
            event: { ...input.event, id: listEvents(state, input.scope, 0).length + 1 },
            scope: input.scope,
          },
        ],
        runs: replaceRun(state.runs, input.scope, input.run),
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
const findRun = (
  state: FileRuntimeState,
  scope: FlowResourceScope,
  runId: string,
): FlowRunSnapshot | undefined =>
  state.runs.find((entry) => sameScope(entry.scope, scope) && entry.run.id === runId)?.run;
const findWorkflowEntry = (state: FileRuntimeState, scope: FlowResourceScope, flowId: string) =>
  state.workflows.find((entry) => entry.flowId === workflowKey(scope, flowId));
const findWorkflow = (
  state: FileRuntimeState,
  scope: FlowResourceScope,
  flowId: string,
  version?: number,
): FlowWorkflowRevision | undefined => {
  const revisions = findWorkflowEntry(state, scope, flowId)?.revisions ?? [];
  return version === undefined
    ? revisions.at(-1)
    : revisions.find((revision) => revision.definition.version === version);
};
const listRuns = (
  state: FileRuntimeState,
  scope: FlowResourceScope,
  flowId?: string,
): readonly FlowRunSnapshot[] =>
  state.runs
    .filter(
      (entry) =>
        sameScope(entry.scope, scope) && (flowId === undefined || entry.run.flow.id === flowId),
    )
    .map((entry) => entry.run);
const listEvents = (
  state: FileRuntimeState,
  scope: FlowResourceScope,
  afterId: number,
  runId?: string,
): readonly FlowRunEvent[] =>
  state.events
    .filter((entry) => sameScope(entry.scope, scope))
    .map((entry) => entry.event)
    .filter((event) => event.id > afterId && (runId === undefined || event.runId === runId));
const replaceWorkflow = (
  state: FileRuntimeState,
  scope: FlowResourceScope,
  flowId: string,
  revisions: readonly FlowWorkflowRevision[],
): FileRuntimeState => ({
  ...state,
  workflows: [
    ...state.workflows.filter((entry) => entry.flowId !== workflowKey(scope, flowId)),
    { flowId: workflowKey(scope, flowId), revisions },
  ],
});
const replaceApproval = (
  values: FileRuntimeState['approvals'],
  scope: FlowResourceScope,
  approval: FlowApprovalRequest,
): FileRuntimeState['approvals'] => [
  ...values.filter((value) => !sameScope(value.scope, scope) || value.approval.id !== approval.id),
  { approval, scope },
];
const replaceRun = (
  values: FileRuntimeState['runs'],
  scope: FlowResourceScope,
  run: FlowRunSnapshot,
): FileRuntimeState['runs'] => [
  ...values.filter((value) => !sameScope(value.scope, scope) || value.run.id !== run.id),
  { run, scope },
];
const sameScope = (left: FlowResourceScope, right: FlowResourceScope): boolean =>
  left.tenantId === right.tenantId && left.projectId === right.projectId;
const workflowKey = (scope: FlowResourceScope, flowId: string): string =>
  `${scope.tenantId}:${scope.projectId}:${flowId}`;
