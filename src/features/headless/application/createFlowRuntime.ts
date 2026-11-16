import { randomUUID } from 'node:crypto';

import type { FlowDefinition, FlowRunSnapshot } from '@ankhorage/contracts/flow';

import type { FlowDurableRun, FlowDurableWork } from '../../../types/durableExecution.js';
import type {
  FlowResourceScope,
  FlowRuntime,
  FlowRuntimeDependencies,
  FlowWorkflowRevision,
} from '../../../types/headless.js';
import type { FlowResolvedSecrets } from '../../../types/security.js';
import { createDurableRunAsync } from '../../execution/application/createDurableRunAsync.js';
import { runDurableWorkerAsync } from '../../execution/application/runDurableWorkerAsync.js';
import { assertFlowGraphSchemasSupported } from '../../execution/domain/assertFlowGraphSchemasSupported.js';
import { compileFlowGraph } from '../../execution/domain/compileFlowGraph.js';
import { createDurableHeadlessWork } from './createDurableHeadlessWork.js';
import { createHeadlessRunControl } from './createHeadlessRunControl.js';
import { executeDurableHeadlessStepAsync as executeDurableHeadlessGraphStepAsync } from './executeDurableHeadlessStepAsync.js';
import { observeFlowRuntimeAsync } from './observeFlowRuntimeAsync.js';
import { reconcileDurableHeadlessStepAsync } from './reconcileDurableHeadlessStepAsync.js';
import { synchronizeHeadlessRunAsync } from './synchronizeHeadlessRunAsync.js';

/*** Compose the canonical versioned workflow API and client-independent worker boundary. */
export const createFlowRuntime = (dependencies: FlowRuntimeDependencies): FlowRuntime => {
  const clock = dependencies.clock ?? { now: () => new Date() };
  const control = createHeadlessRunControl(dependencies, clock);
  return {
    cancelRunAsync: async (scope, runId) => {
      const cancelled = await control.cancelRunAsync(scope, runId);
      if (cancelled !== undefined)
        await observeFlowRuntimeAsync(
          dependencies,
          'execution',
          'run_cancelled',
          cancelled.completedAt,
          runId,
        );
      return cancelled;
    },
    createDraftAsync: async (scope, definition) =>
      createDraftAsync(scope, definition, dependencies),
    getRunAsync: async (scope, runId) => dependencies.store.getRunAsync(scope, runId),
    getWorkflowAsync: async (scope, flowId, version) =>
      dependencies.store.getWorkflowAsync(scope, flowId, version),
    listRunsAsync: async (scope, flowId) => dependencies.store.listRunsAsync(scope, flowId),
    listWorkflowRevisionsAsync: async (scope, flowId) =>
      dependencies.store.listWorkflowRevisionsAsync(scope, flowId),
    publishAsync: async (scope, flowId, version) =>
      dependencies.store.publishAsync(scope, flowId, version, clock.now().toISOString()),
    readEventsAsync: async (scope, afterId, runId) =>
      dependencies.store.readEventsAsync(scope, afterId, runId),
    requestApprovalAsync: async ({ approval, scope }) =>
      dependencies.store.saveApprovalAsync(scope, approval),
    resolveApprovalAsync: async (input) =>
      dependencies.store.resolveApprovalAsync({ ...input, now: clock.now().toISOString() }),
    retryRunAsync: async (scope, runId) => {
      const retry = await control.retryRunAsync(scope, runId);
      if (retry !== undefined)
        await queueRunAsync(scope, retry, clock.now().toISOString(), dependencies, clock);
      return retry;
    },
    runWorkerTickAsync: async () => runWorkerTickAsync(dependencies, clock),
    triggerAsync: async (input) => triggerAsync(input, dependencies, clock),
  };
};

/*** Validate graph invariants before persisting an immutable draft revision. */
const createDraftAsync = async (
  scope: FlowResourceScope,
  definition: FlowDefinition,
  dependencies: FlowRuntimeDependencies,
): Promise<FlowWorkflowRevision> => {
  compileFlowGraph(definition, dependencies.nodeRegistry);
  return dependencies.store.createDraftAsync(scope, definition);
};

/*** Queue an exact published revision once per caller-provided idempotency key. */
const triggerAsync = async (
  input: Parameters<FlowRuntime['triggerAsync']>[0],
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot> => {
  const revision = (await dependencies.store.listWorkflowRevisionsAsync(input.scope, input.flowId))
    .filter((candidate) => candidate.publishedAt !== undefined)
    .at(-1);
  if (!revision?.publishedAt)
    return rejectedTriggerAsync(dependencies, 'FLOW_WORKFLOW_NOT_PUBLISHED');
  const trigger = revision.definition.triggers.find(
    (candidate) => candidate.id === input.triggerId,
  );
  if (!trigger || (trigger.kind !== 'manual' && trigger.kind !== 'webhook'))
    return rejectedTriggerAsync(dependencies, 'FLOW_TRIGGER_NOT_SUPPORTED');
  assertFlowGraphSchemasSupported(revision.definition.nodes, dependencies.schemaRegistry);
  const now = clock.now().toISOString();
  const run: FlowRunSnapshot = {
    createdAt: now,
    flow: { id: revision.definition.id, version: revision.definition.version },
    id: randomUUID(),
    ...(input.input === undefined ? {} : { input: input.input }),
    status: 'pending',
    steps: [],
    trigger: { kind: trigger.kind, triggerId: trigger.id },
  };
  const saved = await dependencies.store.saveRunAsync(
    input.scope,
    run,
    `${revision.definition.id}:${revision.definition.version}:${input.triggerId}:${input.idempotencyKey}`,
  );
  if (saved.id === run.id) await queueRunAsync(input.scope, saved, now, dependencies, clock);
  await observeFlowRuntimeAsync(dependencies, 'execution', 'run_triggered', now, saved.id);
  return saved;
};

/*** Mirror a newly accepted API trigger into the canonical durable worker queue. */
const queueRunAsync = async (
  scope: FlowResourceScope,
  run: FlowRunSnapshot,
  now: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<void> => {
  await ensureQueuedRunAsync(scope, run, now, dependencies, clock);
  await dependencies.store.transitionRunAsync({
    event: { id: 0, runId: run.id, timestamp: now, type: 'run_queued' },
    expectedStatus: 'pending',
    run: { ...run, status: 'pending' },
    scope,
  });
};

/** Repair or create the durable half of an accepted headless run without duplicating its event. */
const ensureQueuedRunAsync = async (
  scope: FlowResourceScope,
  run: FlowRunSnapshot,
  now: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<void> => {
  if ((await dependencies.persistence.readRunAsync(run.id)) === undefined)
    await createDurableRunAsync(
      { flow: run.flow, id: run.id, scope },
      { clock, persistence: dependencies.persistence },
    );
  const revision = await dependencies.store.getWorkflowAsync(scope, run.flow.id, run.flow.version);
  if (revision === undefined) throw new Error('FLOW_WORKFLOW_VERSION_MISSING');
  assertFlowGraphSchemasSupported(revision.definition.nodes, dependencies.schemaRegistry);
  const graph = compileFlowGraph(revision.definition, dependencies.nodeRegistry);
  const work = initialWork(graph, run, now, dependencies);
  await Promise.all(
    work.map(async (candidate) => {
      if ((await dependencies.persistence.readWorkAsync(candidate.id)) === undefined)
        await dependencies.persistence.enqueueWorkAsync(candidate);
    }),
  );
};

/** Materialize exactly the root graph steps; all later steps are atomically planned by their predecessor. */
const initialWork = (
  graph: ReturnType<typeof compileFlowGraph>,
  run: FlowRunSnapshot,
  now: string,
  dependencies: FlowRuntimeDependencies,
): readonly FlowDurableWork[] => {
  if (graph.topologicalNodeIds.length === 0)
    return [
      {
        attempt: 1,
        dueAt: now,
        effectKind: 'internal',
        flow: run.flow,
        id: `${run.id}:step:__flow_complete__:attempt:1`,
        idempotencyKey: `${run.id}:step:__flow_complete__`,
        runId: run.id,
        status: 'ready',
        stepId: '__flow_complete__',
        triggerId: run.trigger.triggerId,
      },
    ];
  return graph.topologicalNodeIds
    .filter((nodeId) => !graph.definition.edges.some((edge) => edge.target.nodeId === nodeId))
    .map((nodeId) => {
      const node = graph.definition.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) throw new Error(`FLOW_GRAPH_UNKNOWN_NODE:${nodeId}`);
      return createDurableHeadlessWork({
        attempt: 1,
        dueAt: now,
        flow: run.flow,
        ...(run.input === undefined ? {} : { input: run.input }),
        node,
        registry: dependencies.nodeRegistry,
        runId: run.id,
        triggerId: run.trigger.triggerId,
      });
    });
};

/** Record a rejected request without retaining client-supplied values. */
const rejectedTriggerAsync = async (
  dependencies: FlowRuntimeDependencies,
  code: string,
): Promise<never> => {
  await observeFlowRuntimeAsync(dependencies, 'validation', code, new Date().toISOString());
  throw new Error(code);
};

/*** Delegate all headless execution, recovery, leases and checkpoints to the canonical durable worker. */
const runWorkerTickAsync = async (
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<readonly string[]> => {
  await Promise.all(
    (await dependencies.store.listPendingRunsAsync()).map(({ run, scope }) =>
      ensureQueuedRunAsync(scope, run, clock.now().toISOString(), dependencies, clock),
    ),
  );
  const result = await runDurableWorkerAsync(
    {
      approvalPollIntervalMs: 1_000,
      concurrency: 1,
      leaseDurationMs: 30_000,
      limit: 10,
      retry: { baseDelayMs: 1_000, maxAttempts: 3, maxDelayMs: 60_000 },
      workerId: `headless-${randomUUID()}`,
    },
    {
      clock,
      effects: {
        executeAsync: async (input) => {
          const result = await executeDurableHeadlessStepAsync(input, dependencies, clock);
          if (result === 'unknown') throw new Error('FLOW_HEADLESS_EFFECT_RESULT_UNKNOWN');
          return result;
        },
        reconcileAsync: (input) => reconcileDurableHeadlessStepAsync(input, dependencies, clock),
      },
      persistence: dependencies.persistence,
      ...(dependencies.security === undefined ? {} : { security: dependencies.security }),
    },
  );
  await Promise.all(
    result.outcomes.map((outcome) =>
      synchronizeHeadlessRunAsync(outcome.workId, dependencies, clock),
    ),
  );
  return result.outcomes
    .filter((outcome) => outcome.status === 'succeeded' || outcome.status === 'already_completed')
    .map((outcome) => outcome.workId.split(':step:')[0] ?? outcome.workId);
};

/** Execute one claimed graph step only after an atomically guarded headless pending-to-running claim. */
const executeDurableHeadlessStepAsync = async (
  input: {
    readonly run: FlowDurableRun;
    readonly secrets?: FlowResolvedSecrets;
    readonly work: FlowDurableWork;
  },
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
) => {
  if (input.run.scope === undefined) throw new Error('FLOW_DURABLE_SCOPE_MISSING');
  const run = await dependencies.store.getRunAsync(input.run.scope, input.run.id);
  if (run === undefined) throw new Error('FLOW_RUN_MISSING');
  if (run.status === 'pending') {
    const startedAt = clock.now().toISOString();
    const started = { ...run, startedAt, status: 'running' as const };
    const claimed = await dependencies.store.transitionRunAsync({
      event: { id: 0, runId: run.id, timestamp: startedAt, type: 'run_started' },
      expectedStatus: 'pending',
      run: started,
      scope: input.run.scope,
    });
    if (!claimed) throw new Error('FLOW_HEADLESS_RUN_CLAIM_LOST');
  } else if (run.status !== 'running' && run.status !== 'waiting_for_approval') {
    throw new Error('FLOW_HEADLESS_RUN_NOT_EXECUTABLE');
  }
  const revision = await dependencies.store.getWorkflowAsync(
    input.run.scope,
    input.run.flow.id,
    input.run.flow.version,
  );
  if (revision === undefined) throw new Error('FLOW_WORKFLOW_VERSION_MISSING');
  return executeDurableHeadlessGraphStepAsync(
    {
      definition: revision.definition,
      durableRun: input.run,
      registry: dependencies.nodeRegistry,
      schemaRegistry: dependencies.schemaRegistry,
      work: input.work,
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    },
    clock,
  );
};
