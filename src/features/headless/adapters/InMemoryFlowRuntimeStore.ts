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

/*** Create a deterministic in-memory store for embedded hosts and boundary tests. */
export const InMemoryFlowRuntimeStore = (): FlowRuntimeStorePort => {
  const workflows = new Map<string, FlowWorkflowRevision[]>();
  const runs = new Map<string, FlowRunSnapshot>();
  const approvals = new Map<string, FlowApprovalRequest>();
  const events = new Map<string, FlowRunEvent[]>();
  const idempotency = new Map<string, string>();
  return {
    createDraftAsync: (scope, definition) =>
      Promise.resolve(createDraft(workflows, scope, definition)),
    getRunAsync: (scope, runId) => Promise.resolve(runs.get(runKey(scope, runId))),
    getWorkflowAsync: (scope, flowId, version) =>
      Promise.resolve(getWorkflow(workflows, scope, flowId, version)),
    listRunsAsync: (scope, flowId) =>
      Promise.resolve(
        [...runs.entries()]
          .filter(
            ([key, run]) =>
              key.startsWith(`${scopeKey(scope)}:`) &&
              (flowId === undefined || run.flow.id === flowId),
          )
          .map(([, run]) => run),
      ),
    listWorkflowRevisionsAsync: (scope, flowId) =>
      Promise.resolve(workflows.get(workflowKey(scope, flowId)) ?? []),
    publishAsync: (scope, flowId, version, publishedAt) =>
      Promise.resolve(publish(workflows, scope, flowId, version, publishedAt)),
    readEventsAsync: (scope, afterId, runId) =>
      Promise.resolve(
        (events.get(scopeKey(scope)) ?? []).filter(
          (event) => event.id > afterId && (runId === undefined || event.runId === runId),
        ),
      ),
    resolveApprovalAsync: (input) => Promise.resolve(resolveApproval(approvals, input)),
    saveApprovalAsync: (scope, approval) => {
      approvals.set(approvalKey(scope, approval.id), approval);
      return Promise.resolve();
    },
    saveRunAsync: (scope, run, key) => Promise.resolve(saveRun(runs, idempotency, scope, run, key)),
    transitionRunAsync: (input) => Promise.resolve(transitionRun(runs, events, input)),
  };
};

/*** Create exactly one immutable draft version for a workflow identifier. */
const createDraft = (
  workflows: Map<string, FlowWorkflowRevision[]>,
  scope: FlowResourceScope,
  definition: FlowDefinition,
): FlowWorkflowRevision => {
  const key = workflowKey(scope, definition.id);
  const revisions = workflows.get(key) ?? [];
  if (revisions.some((revision) => revision.definition.version === definition.version))
    throw new Error('FLOW_WORKFLOW_VERSION_EXISTS');
  const revision = { definition, scope };
  workflows.set(key, [...revisions, revision]);
  return revision;
};

/*** Resolve an exact version or the newest immutable revision. */
const getWorkflow = (
  workflows: Map<string, FlowWorkflowRevision[]>,
  scope: FlowResourceScope,
  flowId: string,
  version?: number,
): FlowWorkflowRevision | undefined => {
  const revisions = workflows.get(workflowKey(scope, flowId)) ?? [];
  return version === undefined
    ? revisions.at(-1)
    : revisions.find((revision) => revision.definition.version === version);
};

/*** Mark one revision published without changing its immutable graph. */
const publish = (
  workflows: Map<string, FlowWorkflowRevision[]>,
  scope: FlowResourceScope,
  flowId: string,
  version: number,
  publishedAt: string,
): FlowWorkflowRevision | undefined => {
  const revision = getWorkflow(workflows, scope, flowId, version);
  if (!revision) return undefined;
  const published = { ...revision, publishedAt };
  workflows.set(
    workflowKey(scope, flowId),
    (workflows.get(workflowKey(scope, flowId)) ?? []).map((candidate) =>
      candidate.definition.version === version ? published : candidate,
    ),
  );
  return published;
};

/*** Make idempotent triggers return their original run without duplicate execution. */
const saveRun = (
  runs: Map<string, FlowRunSnapshot>,
  idempotency: Map<string, string>,
  scope: FlowResourceScope,
  run: FlowRunSnapshot,
  key?: string,
): FlowRunSnapshot => {
  const existingId = key === undefined ? undefined : idempotency.get(idempotencyKey(scope, key));
  const existing = existingId === undefined ? undefined : runs.get(runKey(scope, existingId));
  if (existing !== undefined) return existing;
  if (runs.has(runKey(scope, run.id))) throw new Error('FLOW_RUN_EXISTS');
  runs.set(runKey(scope, run.id), run);
  if (key !== undefined) idempotency.set(idempotencyKey(scope, key), run.id);
  return run;
};

/*** Apply a guarded status transition and append the matching event atomically in this adapter. */
const transitionRun = (
  runs: Map<string, FlowRunSnapshot>,
  events: Map<string, FlowRunEvent[]>,
  input: Parameters<FlowRuntimeStorePort['transitionRunAsync']>[0],
): boolean => {
  const key = runKey(input.scope, input.run.id);
  const current = runs.get(key);
  if (current?.status !== input.expectedStatus) return false;
  runs.set(key, input.run);
  const scopedEvents = events.get(scopeKey(input.scope)) ?? [];
  events.set(scopeKey(input.scope), [
    ...scopedEvents,
    { ...input.event, id: scopedEvents.length + 1 },
  ]);
  return true;
};

/*** Resolve a pending approval once, binding the decision to the trusted actor. */
const resolveApproval = (
  approvals: Map<string, FlowApprovalRequest>,
  input: Parameters<FlowRuntimeStorePort['resolveApprovalAsync']>[0],
): FlowApprovalRequest | undefined => {
  const current = approvals.get(approvalKey(input.scope, input.approvalId));
  if (current?.status !== 'pending') return undefined;
  const approval = {
    ...current,
    resolvedAt: input.now,
    resolvedBy: input.actorId,
    status: input.approved ? ('approved' as const) : ('rejected' as const),
  };
  approvals.set(approvalKey(input.scope, approval.id), approval);
  return approval;
};

const scopeKey = (scope: FlowResourceScope): string => `${scope.tenantId}:${scope.projectId}`;
const workflowKey = (scope: FlowResourceScope, flowId: string): string =>
  `${scopeKey(scope)}:${flowId}`;
const runKey = (scope: FlowResourceScope, runId: string): string => `${scopeKey(scope)}:${runId}`;
const approvalKey = (scope: FlowResourceScope, approvalId: string): string =>
  `${scopeKey(scope)}:${approvalId}`;
const idempotencyKey = (scope: FlowResourceScope, key: string): string =>
  `${scopeKey(scope)}:${key}`;
