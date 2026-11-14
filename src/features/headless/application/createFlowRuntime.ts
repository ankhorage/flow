import { randomUUID } from 'node:crypto';

import type { FlowDefinition, FlowRunSnapshot } from '@ankhorage/contracts/flow';

import type {
  FlowRuntime,
  FlowRuntimeDependencies,
  FlowWorkflowRevision,
} from '../../../types/headless.js';
import { executeFlowAsync } from '../../execution/application/executeFlowAsync.js';
import { compileFlowGraph } from '../../execution/domain/compileFlowGraph.js';

/*** Compose the canonical versioned workflow API and client-independent worker boundary. */
export const createFlowRuntime = (dependencies: FlowRuntimeDependencies): FlowRuntime => {
  const clock = dependencies.clock ?? { now: () => new Date() };
  return {
    cancelRunAsync: async (runId) => cancelRunAsync(runId, dependencies, clock),
    createDraftAsync: async (definition) => createDraftAsync(definition, dependencies),
    getRunAsync: async (runId) => dependencies.store.getRunAsync(runId),
    getWorkflowAsync: async (flowId, version) =>
      dependencies.store.getWorkflowAsync(flowId, version),
    listRunsAsync: async (flowId) => dependencies.store.listRunsAsync(flowId),
    listWorkflowRevisionsAsync: async (flowId) =>
      dependencies.store.listWorkflowRevisionsAsync(flowId),
    publishAsync: async (flowId, version) =>
      dependencies.store.publishAsync(flowId, version, clock.now().toISOString()),
    readEventsAsync: async (afterId, runId) => dependencies.store.readEventsAsync(afterId, runId),
    requestApprovalAsync: async ({ approval }) => dependencies.store.saveApprovalAsync(approval),
    resolveApprovalAsync: async (input) => resolveApprovalAsync(input, dependencies, clock),
    retryRunAsync: async (runId) => retryRunAsync(runId, dependencies, clock),
    runWorkerTickAsync: async () => runWorkerTickAsync(dependencies, clock),
    triggerAsync: async (input) => triggerAsync(input, dependencies, clock),
  };
};

/*** Validate graph invariants before persisting an immutable draft revision. */
const createDraftAsync = async (
  definition: FlowDefinition,
  dependencies: FlowRuntimeDependencies,
): Promise<FlowWorkflowRevision> => {
  compileFlowGraph(definition, dependencies.nodeRegistry);
  return dependencies.store.createDraftAsync(definition);
};

/*** Queue an exact published revision once per caller-provided idempotency key. */
const triggerAsync = async (
  input: Parameters<FlowRuntime['triggerAsync']>[0],
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot> => {
  const revision = await dependencies.store.getWorkflowAsync(input.flowId);
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
    run,
    idempotencyKey(revision.definition, input),
  );
  if (saved.id === run.id)
    await dependencies.store.transitionRunAsync({
      event: { id: 0, runId: saved.id, timestamp: now, type: 'run_queued' },
      expectedStatus: 'pending',
      run: { ...saved, status: 'pending' },
    });
  await observeAsync(dependencies, 'execution', 'run_triggered', now, saved.id);
  return saved;
};

/** Record a rejected request without retaining client-supplied values. */
const rejectedTriggerAsync = async (
  dependencies: FlowRuntimeDependencies,
  code: string,
): Promise<never> => {
  await observeAsync(dependencies, 'validation', code, new Date().toISOString());
  throw new Error(code);
};

/*** Run each pending workflow exactly once per tick; worker ownership is independent of HTTP clients. */
const runWorkerTickAsync = async (
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<readonly string[]> => {
  const pending = (await dependencies.store.listRunsAsync()).filter(
    (run) => run.status === 'pending',
  );
  const completed: string[] = [];
  for (const run of pending) {
    const startedAt = clock.now().toISOString();
    const started = { ...run, startedAt, status: 'running' as const };
    const claimed = await dependencies.store.transitionRunAsync({
      event: { id: 0, runId: run.id, timestamp: startedAt, type: 'run_started' },
      expectedStatus: 'pending',
      run: started,
    });
    if (!claimed) continue;
    const result = await executeRunAsync(started, dependencies, clock);
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
    });
    if (transitioned) completed.push(run.id);
    if (transitioned)
      await observeAsync(dependencies, 'execution', `run_${terminal.status}`, completedAt, run.id);
  }
  return completed;
};

/*** Execute the immutable graph revision and retain only redaction-safe contract snapshots. */
const executeRunAsync = async (
  run: FlowRunSnapshot,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot> => {
  const revision = await dependencies.store.getWorkflowAsync(run.flow.id, run.flow.version);
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
  runId: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot | undefined> => {
  const run = await dependencies.store.getRunAsync(runId);
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
  });
  if (transitioned)
    await observeAsync(dependencies, 'execution', 'run_cancelled', cancelled.completedAt, runId);
  return transitioned ? cancelled : undefined;
};

/*** Retry by preserving the original immutable workflow version and trigger identity. */
const retryRunAsync = async (
  runId: string,
  dependencies: FlowRuntimeDependencies,
  clock: { readonly now: () => Date },
): Promise<FlowRunSnapshot | undefined> => {
  const previous = await dependencies.store.getRunAsync(runId);
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
  const saved = await dependencies.store.saveRunAsync(retry);
  await dependencies.store.transitionRunAsync({
    event: { id: 0, runId: saved.id, timestamp: now, type: 'run_queued' },
    expectedStatus: 'pending',
    run: saved,
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
