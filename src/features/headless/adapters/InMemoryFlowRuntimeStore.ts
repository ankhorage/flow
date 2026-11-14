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

/*** Create a deterministic in-memory store for embedded hosts and boundary tests. */
export const InMemoryFlowRuntimeStore = (): FlowRuntimeStorePort => {
  const workflows = new Map<string, FlowWorkflowRevision[]>();
  const runs = new Map<string, FlowRunSnapshot>();
  const approvals = new Map<string, FlowApprovalRequest>();
  const events: FlowRunEvent[] = [];
  const idempotency = new Map<string, string>();
  return {
    createDraftAsync: (definition) => Promise.resolve(createDraft(workflows, definition)),
    getRunAsync: (runId) => Promise.resolve(runs.get(runId)),
    getWorkflowAsync: (flowId, version) => Promise.resolve(getWorkflow(workflows, flowId, version)),
    listRunsAsync: (flowId) =>
      Promise.resolve(
        [...runs.values()].filter((run) => flowId === undefined || run.flow.id === flowId),
      ),
    listWorkflowRevisionsAsync: (flowId) => Promise.resolve(workflows.get(flowId) ?? []),
    publishAsync: (flowId, version, publishedAt) =>
      Promise.resolve(publish(workflows, flowId, version, publishedAt)),
    readEventsAsync: (afterId, runId) =>
      Promise.resolve(
        events.filter(
          (event) => event.id > afterId && (runId === undefined || event.runId === runId),
        ),
      ),
    resolveApprovalAsync: (input) => Promise.resolve(resolveApproval(approvals, input)),
    saveApprovalAsync: (approval) => {
      approvals.set(approval.id, approval);
      return Promise.resolve();
    },
    saveRunAsync: (run, key) => Promise.resolve(saveRun(runs, idempotency, run, key)),
    transitionRunAsync: (input) => Promise.resolve(transitionRun(runs, events, input)),
  };
};

/*** Create exactly one immutable draft version for a workflow identifier. */
const createDraft = (
  workflows: Map<string, FlowWorkflowRevision[]>,
  definition: FlowDefinition,
): FlowWorkflowRevision => {
  const revisions = workflows.get(definition.id) ?? [];
  if (revisions.some((revision) => revision.definition.version === definition.version))
    throw new Error('FLOW_WORKFLOW_VERSION_EXISTS');
  const revision = { definition };
  workflows.set(definition.id, [...revisions, revision]);
  return revision;
};

/*** Resolve an exact version or the newest immutable revision. */
const getWorkflow = (
  workflows: Map<string, FlowWorkflowRevision[]>,
  flowId: string,
  version?: number,
): FlowWorkflowRevision | undefined => {
  const revisions = workflows.get(flowId) ?? [];
  return version === undefined
    ? revisions.at(-1)
    : revisions.find((revision) => revision.definition.version === version);
};

/*** Mark one revision published without changing its immutable graph. */
const publish = (
  workflows: Map<string, FlowWorkflowRevision[]>,
  flowId: string,
  version: number,
  publishedAt: string,
): FlowWorkflowRevision | undefined => {
  const revision = getWorkflow(workflows, flowId, version);
  if (!revision) return undefined;
  const published = { ...revision, publishedAt };
  workflows.set(
    flowId,
    (workflows.get(flowId) ?? []).map((candidate) =>
      candidate.definition.version === version ? published : candidate,
    ),
  );
  return published;
};

/*** Make idempotent triggers return their original run without duplicate execution. */
const saveRun = (
  runs: Map<string, FlowRunSnapshot>,
  idempotency: Map<string, string>,
  run: FlowRunSnapshot,
  key?: string,
): FlowRunSnapshot => {
  const existingId = key === undefined ? undefined : idempotency.get(key);
  const existing = existingId === undefined ? undefined : runs.get(existingId);
  if (existing !== undefined) return existing;
  if (runs.has(run.id)) throw new Error('FLOW_RUN_EXISTS');
  runs.set(run.id, run);
  if (key !== undefined) idempotency.set(key, run.id);
  return run;
};

/*** Apply a guarded status transition and append the matching event atomically in this adapter. */
const transitionRun = (
  runs: Map<string, FlowRunSnapshot>,
  events: FlowRunEvent[],
  input: Parameters<FlowRuntimeStorePort['transitionRunAsync']>[0],
): boolean => {
  const current = runs.get(input.run.id);
  if (current?.status !== input.expectedStatus) return false;
  runs.set(input.run.id, input.run);
  events.push({ ...input.event, id: events.length + 1 });
  return true;
};

/*** Resolve a pending approval once, binding the decision to the trusted actor. */
const resolveApproval = (
  approvals: Map<string, FlowApprovalRequest>,
  input: Parameters<FlowRuntimeStorePort['resolveApprovalAsync']>[0],
): FlowApprovalRequest | undefined => {
  const current = approvals.get(input.approvalId);
  if (current?.status !== 'pending') return undefined;
  const approval = {
    ...current,
    resolvedAt: input.now,
    resolvedBy: input.actorId,
    status: input.approved ? ('approved' as const) : ('rejected' as const),
  };
  approvals.set(approval.id, approval);
  return approval;
};
