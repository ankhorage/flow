import { randomUUID } from 'node:crypto';

import type { FlowDefinition, FlowRunSnapshot } from '@ankhorage/contracts/flow';

import type {
  FlowResourceScope,
  FlowRuntime,
  FlowRuntimeDependencies,
  FlowWorkflowRevision,
} from '../../../types/headless.js';
import { cancelDurableRunAsync } from '../../execution/application/cancelDurableRunAsync.js';
import { createDurableRunAsync } from '../../execution/application/createDurableRunAsync.js';
import { executeFlowAsync } from '../../execution/application/executeFlowAsync.js';
import { runDurableWorkerAsync } from '../../execution/application/runDurableWorkerAsync.js';
import { compileFlowGraph } from '../../execution/domain/compileFlowGraph.js';

/*** Compose the canonical versioned workflow API and client-independent worker boundary. */
export const createFlowRuntime = (dependencies: FlowRuntimeDependencies): FlowRuntime => {
  const clock = dependencies.clock ?? { now: () => new Date() };
  return {
    cancelRunAsync: async (scope, runId) => cancelRunAsync(scope, runId, dependencies, clock),
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
    resolveApprovalAsync: async (input) => resolveApprovalAsync(input, dependencies, clock),
    retryRunAsync: async (scope, runId) => retryRunAsync(scope, runId, dependencies, clock),
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
    idempotencyKey(revision.definition, input),
  );
  if (saved.id === run.id) await queueRunAsync(input.scope, saved, now, dependencies, clock);
  await observeAsync(dependencies, 'execution', 'run_triggered', now, saved.id);
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
  await dependencies.store.transitionRunAsync({
    event: { id: 0, runId: run.id, timestamp: now, type: 'run_queued' },
    expectedStatus: 'pending',
    run: { ...run, status: 'pending' },
    scope,
  });
  await createDurableRunAsync(
    { flow: run.flow, id: run.id, scope },
    { clock, persistence: dependencies.persistence },
  );
  await dependencies.persistence.enqueueWorkAsync({
    attempt: 1,
    dueAt: now,
    effectKind: 'internal',
    flow: run.flow,
    id: `${run.id}:headless`,
    idempotencyKey: `${run.id}:headless`,
    runId: run.id,
    status: 'ready',
    stepId: 'headless',
  });
};

/** Record a rejected request without retaining client-supplied values. */
const rejectedTriggerAsync = async (
  dependencies: FlowRuntimeDependencies,
  code: string,
): Promise<never> => {
  await observeAsync(dependencies, 'validation', code, new Date().toISOString());
  throw new Error(code);
};

/*** Delegate all headless execution, recovery, leases and checkpoints to the canonical durable worker. */
const runWorkerTickAsync = async (
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<readonly string[]> => {
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
        executeAsync: (input) => executeDurableHeadlessRunAsync(input.run, dependencies, clock),
      },
      persistence: dependencies.persistence,
    },
  );
  return result.outcomes
    .filter((outcome) => outcome.status === 'succeeded' || outcome.status === 'already_completed')
    .map((outcome) => outcome.workId.replace(/:headless$/u, ''));
};

/** Execute a claimed persisted run and expose only redacted lifecycle facts through the runtime store. */
const executeDurableHeadlessRunAsync = async (
  durableRun: { readonly id: string; readonly scope?: FlowResourceScope },
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<void> => {
  if (durableRun.scope === undefined) throw new Error('FLOW_DURABLE_SCOPE_MISSING');
  const run = await dependencies.store.getRunAsync(durableRun.scope, durableRun.id);
  if (run === undefined) throw new Error('FLOW_RUN_MISSING');
  const startedAt = clock.now().toISOString();
  const started = { ...run, startedAt, status: 'running' as const };
  await dependencies.store.transitionRunAsync({
    event: { id: 0, runId: run.id, timestamp: startedAt, type: 'run_started' },
    expectedStatus: 'pending',
    run: started,
    scope: durableRun.scope,
  });
  const result = await executeRunAsync(started, durableRun.scope, dependencies, clock);
  const completedAt = clock.now().toISOString();
  const terminal = { ...result, completedAt };
  const transitioned = await dependencies.store.transitionRunAsync({
    event: {
      id: 0,
      runId: run.id,
      timestamp: completedAt,
      trace: {
        level: terminal.status === 'succeeded' ? 'info' : 'error',
        message: `Run ${terminal.status}.`,
        timestamp: completedAt,
      },
      type: 'run_completed',
    },
    expectedStatus: 'running',
    run: terminal,
    scope: durableRun.scope,
  });
  if (transitioned)
    await observeAsync(dependencies, 'execution', `run_${terminal.status}`, completedAt, run.id);
};

/*** Execute the immutable graph revision and retain only redaction-safe contract snapshots. */
const executeRunAsync = async (
  run: FlowRunSnapshot,
  scope: FlowResourceScope,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot> => {
  const revision = await dependencies.store.getWorkflowAsync(scope, run.flow.id, run.flow.version);
  if (!revision) return failedRun(run, 'FLOW_WORKFLOW_VERSION_MISSING');
  try {
    const result = await executeFlowAsync(
      compileFlowGraph(revision.definition, dependencies.nodeRegistry),
      dependencies.nodeRegistry,
      { input: run.input, runId: run.id, triggerId: run.trigger.triggerId },
      clock,
    );
    return {
      ...result.run,
      createdAt: run.createdAt,
      flow: run.flow,
      id: run.id,
      trigger: run.trigger,
    };
  } catch (error) {
    return failedRun(run, error instanceof Error ? error.message : 'FLOW_RUN_FAILED');
  }
};

/*** Cancel only work that has not entered a terminal state. */
const cancelRunAsync = async (
  scope: FlowResourceScope,
  runId: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot | undefined> => {
  const run = await dependencies.store.getRunAsync(scope, runId);
  if (!run || isTerminal(run)) return undefined;
  const cancelled = {
    ...run,
    completedAt: clock.now().toISOString(),
    status: 'cancelled' as const,
  };
  const transitioned = await dependencies.store.transitionRunAsync({
    event: { id: 0, runId, timestamp: cancelled.completedAt, type: 'run_cancelled' },
    expectedStatus: run.status,
    run: cancelled,
    scope,
  });
  if (transitioned)
    await observeAsync(dependencies, 'execution', 'run_cancelled', cancelled.completedAt, runId);
  if (transitioned)
    await cancelDurableRunAsync(runId, { clock, persistence: dependencies.persistence });
  return transitioned ? cancelled : undefined;
};

/*** Retry by preserving the original immutable workflow version and trigger identity. */
const retryRunAsync = async (
  scope: FlowResourceScope,
  runId: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot | undefined> => {
  const previous = await dependencies.store.getRunAsync(scope, runId);
  if (!previous || !isTerminal(previous)) return undefined;
  const now = clock.now().toISOString();
  const retry: FlowRunSnapshot = {
    createdAt: now,
    flow: previous.flow,
    id: randomUUID(),
    ...(previous.input === undefined ? {} : { input: previous.input }),
    status: 'pending',
    steps: [],
    trigger: previous.trigger,
  };
  const saved = await dependencies.store.saveRunAsync(scope, retry);
  await dependencies.store.transitionRunAsync({
    event: { id: 0, runId: saved.id, timestamp: now, type: 'run_queued' },
    expectedStatus: 'pending',
    run: saved,
    scope,
  });
  await createDurableRunAsync(
    { flow: saved.flow, id: saved.id, scope },
    { clock, persistence: dependencies.persistence },
  );
  await dependencies.persistence.enqueueWorkAsync({
    attempt: 1,
    dueAt: now,
    effectKind: 'internal',
    flow: saved.flow,
    id: `${saved.id}:headless`,
    idempotencyKey: `${saved.id}:headless`,
    runId: saved.id,
    status: 'ready',
    stepId: 'headless',
  });
  return saved;
};

/*** Resolve an approval once without exposing approval context or secrets in the event stream. */
const resolveApprovalAsync = async (
  input: Parameters<FlowRuntime['resolveApprovalAsync']>[0],
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
) => dependencies.store.resolveApprovalAsync({ ...input, now: clock.now().toISOString() });

/*** Keep retry idempotency scoped to the exact published revision and trigger request. */
const idempotencyKey = (
  definition: FlowDefinition,
  input: Parameters<FlowRuntime['triggerAsync']>[0],
): string => `${definition.id}:${definition.version}:${input.triggerId}:${input.idempotencyKey}`;

/*** Preserve portable errors without serializing host stack traces or provider details. */
const failedRun = (run: FlowRunSnapshot, code: string): FlowRunSnapshot => ({
  ...run,
  error: { code, message: 'Workflow execution failed.', retryable: false },
  status: 'failed',
});

/*** Identify statuses that cannot be cancelled or retried in place. */
const isTerminal = (run: FlowRunSnapshot): boolean =>
  ['cancelled', 'failed', 'succeeded', 'timed_out'].includes(run.status);

/** Emit only fixed action names and identifiers to the host-owned telemetry boundary. */
const observeAsync = async (
  dependencies: FlowRuntimeDependencies,
  category: 'approval' | 'execution' | 'validation',
  action: string,
  occurredAt: string,
  runId?: string,
): Promise<void> =>
  dependencies.observability?.recordAsync({
    action,
    category,
    occurredAt,
    ...(runId === undefined ? {} : { runId }),
  }) ?? Promise.resolve();
