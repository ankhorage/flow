import type {
  FlowDataRef,
  FlowError,
  FlowNode,
  FlowPortId,
  FlowRunSnapshot,
  FlowStepSnapshot,
} from '@ankhorage/contracts/flow';

import type {
  FlowClock,
  FlowCompiledGraph,
  FlowExecutionResult,
  FlowNodeRegistry,
  FlowRunRequest,
} from '../../../types/execution.js';
import { assertFlowGraphSchemasSupported } from '../domain/assertFlowGraphSchemasSupported.js';
import { planFlowNodeInput } from '../domain/planFlowNodeInput.js';
import { validateFlowDataSchema } from '../domain/validateFlowDataSchema.js';
/*** Execute a compiled graph in deterministic order within one process. */
export const executeFlowAsync = async (
  graph: FlowCompiledGraph,
  registry: FlowNodeRegistry,
  request: FlowRunRequest,
  clock: FlowClock = { now: () => new Date() },
): Promise<FlowExecutionResult> => {
  const trigger = graph.definition.triggers.find(({ id }) => id === request.triggerId);
  if (trigger?.kind !== 'manual' && trigger?.kind !== 'webhook')
    throw new Error('FLOW_TRIGGER_NOT_EXECUTABLE');
  assertFlowGraphSchemasSupported(graph.definition.nodes, request.schemaRegistry);
  const startedAt = clock.now().toISOString();
  const state = await executeNodesAsync(graph, registry, request, clock);
  return {
    run: createRun(
      graph,
      request,
      state.steps,
      startedAt,
      clock.now().toISOString(),
      state.status ?? 'succeeded',
      state.error,
      trigger.kind,
    ),
  };
};

/*** Iterate compiled nodes in deterministic order until completion or cancellation. */
const executeNodesAsync = async (
  graph: FlowCompiledGraph,
  registry: FlowNodeRegistry,
  request: FlowRunRequest,
  clock: FlowClock,
): Promise<ExecutionState> => {
  const state: ExecutionState = { steps: [] };
  for (const nodeId of graph.topologicalNodeIds) {
    if (request.signal?.aborted) return { ...state, status: 'cancelled' };
    const node = graph.definition.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`FLOW_GRAPH_UNKNOWN_NODE:${nodeId}`);
    const result = await executeAvailableNodeAsync(graph, node, state, registry, request, clock);
    if (!result) continue;
    state.steps.push(result.step);
    if (result.step.status === 'cancelled') return { ...state, status: 'cancelled' };
  }
  const failedStep = state.steps.find((step) => step.status === 'failed');
  return { ...state, status: failedStep ? 'failed' : 'succeeded', error: failedStep?.error };
};

interface ExecutionState {
  readonly error?: FlowError;
  readonly status?: FlowRunSnapshot['status'];
  readonly steps: FlowStepSnapshot[];
}

/*** Execute one node only when all of its required inputs were propagated. */
const executeAvailableNodeAsync = async (
  graph: FlowCompiledGraph,
  node: FlowNode,
  state: ExecutionState,
  registry: FlowNodeRegistry,
  request: FlowRunRequest,
  clock: FlowClock,
): Promise<
  | { readonly output: Readonly<Record<FlowPortId, FlowDataRef>>; readonly step: FlowStepSnapshot }
  | undefined
> => {
  const plan = planFlowNodeInput(graph, node.id, state.steps, request.input);
  if (plan.status !== 'ready') return undefined;
  return executeNodeAsync(
    node,
    plan.input,
    registry,
    request.effectIdentity ?? { idempotencyKey: `${request.runId}:step:${node.id}` },
    request.signal,
    clock,
    request.schemaRegistry,
  );
};

/*** Execute one node and convert failures to redaction-safe contract errors. */
const executeNodeAsync = async (
  node: FlowNode,
  input: Readonly<Record<FlowPortId, FlowDataRef>>,
  registry: FlowNodeRegistry,
  effect: { readonly idempotencyKey: string },
  signal: AbortSignal | undefined,
  clock: FlowClock,
  schemas: FlowRunRequest['schemaRegistry'],
): Promise<{
  readonly output: Readonly<Record<FlowPortId, FlowDataRef>>;
  readonly step: FlowStepSnapshot;
}> => {
  const startedAt = clock.now().toISOString();
  try {
    assertPortSchemas(node, input, 'input', schemas);
    const operationId = `${node.capability.providerId}:${node.capability.capabilityId}`;
    const operation = Object.entries(registry).find(([id]) => id === operationId)?.[1];
    if (!operation) throw new Error(`FLOW_OPERATION_UNREGISTERED:${operationId}`);
    const output =
      (
        await operation.executeAsync({
          config: node.config,
          effect,
          input,
          node,
          signal: signal ?? new AbortController().signal,
        })
      ).output ?? {};
    if (signal?.aborted)
      return { output: {}, step: createCancelledStep(node, input, startedAt, clock) };
    assertOutputPorts(node, output);
    assertPortSchemas(node, output, 'output', schemas);
    return { output, step: createSucceededStep(node, input, output, startedAt, clock) };
  } catch (reason) {
    const error = asFlowError(reason);
    return {
      output: {},
      step: {
        id: `${node.id}:1`,
        nodeId: node.id,
        status: 'failed',
        attempt: 1,
        startedAt,
        completedAt: clock.now().toISOString(),
        input,
        error,
      },
    };
  }
};

/*** Create an immutable successful step snapshot. */
const createSucceededStep = (
  node: FlowNode,
  input: Readonly<Record<FlowPortId, FlowDataRef>>,
  output: Readonly<Record<FlowPortId, FlowDataRef>>,
  startedAt: string,
  clock: FlowClock,
): FlowStepSnapshot => ({
  id: `${node.id}:1`,
  nodeId: node.id,
  status: 'succeeded',
  attempt: 1,
  startedAt,
  completedAt: clock.now().toISOString(),
  input,
  output,
});

/*** Create a terminal snapshot when cancellation occurs during asynchronous node execution. */
const createCancelledStep = (
  node: FlowNode,
  input: Readonly<Record<FlowPortId, FlowDataRef>>,
  startedAt: string,
  clock: FlowClock,
): FlowStepSnapshot => ({
  id: `${node.id}:1`,
  nodeId: node.id,
  status: 'cancelled',
  attempt: 1,
  startedAt,
  completedAt: clock.now().toISOString(),
  input,
});

/*** Reject operation outputs that do not correspond to declared output ports. */
const assertOutputPorts = (
  node: FlowNode,
  output: Readonly<Record<FlowPortId, FlowDataRef>>,
): void => {
  const outputIds = new Set(
    node.ports.filter((port) => port.direction === 'output').map(({ id }) => id),
  );
  if (Object.keys(output).some((portId) => !outputIds.has(portId)))
    throw new Error(`FLOW_OUTPUT_UNDECLARED_PORT:${node.id}`);
  const missingRequired = node.ports.some(
    (port) => port.direction === 'output' && port.required && output[port.id] === undefined,
  );
  if (missingRequired) throw new Error(`FLOW_OUTPUT_REQUIRED_PORT_MISSING:${node.id}`);
};

/*** Validate inline port values against their declared portable schemas. */
const assertPortSchemas = (
  node: FlowNode,
  values: Readonly<Record<FlowPortId, FlowDataRef>>,
  direction: 'input' | 'output',
  schemas: FlowRunRequest['schemaRegistry'],
): void => {
  for (const port of node.ports.filter((candidate) => candidate.direction === direction)) {
    const value = values[port.id];
    const schema =
      port.data?.schema ?? (port.data?.schemaRef ? { ref: port.data.schemaRef } : undefined);
    if (value?.kind === 'inline' && schema && !validateFlowDataSchema(value.value, schema, schemas))
      throw new Error(`FLOW_PORT_SCHEMA_MISMATCH:${node.id}:${port.id}`);
  }
};

/*** Translate host failures to structured contract errors without exposing arbitrary objects. */
const asFlowError = (reason: unknown): FlowError => ({
  code:
    reason instanceof Error && /^FLOW_[A-Z0-9_]+(?::|$)/.test(reason.message)
      ? (reason.message.split(':')[0] ?? 'FLOW_OPERATION_FAILED')
      : 'FLOW_OPERATION_FAILED',
  message: 'The operation failed.',
  retryable: false,
});

/*** Build the immutable run result emitted by the single-process executor. */
const createRun = (
  graph: FlowCompiledGraph,
  request: FlowRunRequest,
  steps: readonly FlowStepSnapshot[],
  startedAt: string,
  completedAt: string,
  status: FlowRunSnapshot['status'],
  error: FlowError | undefined,
  triggerKind: 'manual' | 'webhook',
): FlowRunSnapshot => ({
  id: request.runId,
  flow: { id: graph.definition.id, version: graph.definition.version },
  status,
  trigger: {
    triggerId: request.triggerId,
    kind: triggerKind,
  },
  createdAt: startedAt,
  startedAt,
  completedAt,
  steps,
  ...(error === undefined ? {} : { error }),
});
