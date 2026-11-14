import type { DataContractValue } from '@ankhorage/contracts/data';
import type {
  FlowDataRef,
  FlowEdge,
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
import { structurallyEqual } from '../domain/structurallyEqual.js';
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
  const state: ExecutionState = {
    activatedNodeIds: new Set(
      graph.topologicalNodeIds.filter(
        (nodeId) => !graph.definition.edges.some((edge) => edge.target.nodeId === nodeId),
      ),
    ),
    inputs: {},
    steps: [],
  };
  for (const nodeId of graph.topologicalNodeIds) {
    if (request.signal?.aborted) return { ...state, status: 'cancelled' };
    const node = graph.definition.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`FLOW_GRAPH_UNKNOWN_NODE:${nodeId}`);
    const result = await executeAvailableNodeAsync(node, state, registry, request, clock);
    if (!result) continue;
    state.steps.push(result.step);
    if (result.step.status === 'cancelled') return { ...state, status: 'cancelled' };
    propagateOutput(
      graph.edgesBySourceNodeId[node.id] ?? [],
      result.output,
      result.step.status === 'failed' ? 'failure' : 'success',
      state,
    );
  }
  const failedStep = state.steps.find((step) => step.status === 'failed');
  return { ...state, status: failedStep ? 'failed' : 'succeeded', error: failedStep?.error };
};

interface ExecutionState {
  readonly activatedNodeIds: Set<string>;
  readonly error?: FlowError;
  readonly inputs: Record<string, Record<FlowPortId, FlowDataRef>>;
  readonly status?: FlowRunSnapshot['status'];
  readonly steps: FlowStepSnapshot[];
}

/*** Execute one node only when all of its required inputs were propagated. */
const executeAvailableNodeAsync = async (
  node: FlowNode,
  state: ExecutionState,
  registry: FlowNodeRegistry,
  request: FlowRunRequest,
  clock: FlowClock,
): Promise<
  | { readonly output: Readonly<Record<FlowPortId, FlowDataRef>>; readonly step: FlowStepSnapshot }
  | undefined
> => {
  if (!state.activatedNodeIds.has(node.id)) return undefined;
  const input = state.inputs[node.id] ?? request.input ?? {};
  if (!hasRequiredInput(node, input)) return undefined;
  return executeNodeAsync(node, input, registry, request.signal, clock, request.schemaRegistry);
};

/*** Determine whether every required input port has a propagated value. */
const hasRequiredInput = (
  node: FlowNode,
  input: Readonly<Record<FlowPortId, FlowDataRef>>,
): boolean =>
  node.ports
    .filter((port) => port.direction === 'input' && port.required)
    .every((port) => input[port.id] !== undefined);

/*** Execute one node and convert failures to redaction-safe contract errors. */
const executeNodeAsync = async (
  node: FlowNode,
  input: Readonly<Record<FlowPortId, FlowDataRef>>,
  registry: FlowNodeRegistry,
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

/*** Propagate outputs only over edges whose declared condition matches the output value. */
const propagateOutput = (
  edges: readonly FlowEdge[],
  output: Readonly<Record<FlowPortId, FlowDataRef>>,
  outcome: 'failure' | 'success',
  state: ExecutionState,
): void => {
  for (const edge of edges) {
    const value = output[edge.source.portId];
    if (!matchesEdge(edge, value, outcome)) continue;
    state.activatedNodeIds.add(edge.target.nodeId);
    if (value)
      state.inputs[edge.target.nodeId] = {
        ...state.inputs[edge.target.nodeId],
        [edge.target.portId]: value,
      };
  }
};

/*** Evaluate an edge condition without executing arbitrary expressions. */
const matchesEdge = (
  edge: FlowEdge,
  value: FlowDataRef | undefined,
  outcome: 'failure' | 'success',
): boolean => {
  const condition = edge.condition ?? { kind: 'always' as const };
  if (condition.kind === 'always') return outcome === 'success';
  if (condition.kind === 'outcome') return condition.outcome === outcome;
  if (value?.kind !== 'inline') return false;
  const selected = resolvePointer(value.value, condition.path);
  return selected !== undefined && structurallyEqual(selected, condition.equals);
};

/*** Resolve an RFC 6901 pointer against serializable inline data. */
const resolvePointer = (
  value: DataContractValue,
  pointer: string,
): DataContractValue | undefined => {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .reduce<DataContractValue | undefined>((current, segment) => {
      if (current === undefined || current === null || typeof current !== 'object')
        return undefined;
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      if (isDataArray(current)) return current.find((_item, index) => index === Number(key));
      return isDataRecord(current)
        ? Object.entries(current).find(([candidateKey]) => candidateKey === key)?.[1]
        : undefined;
    }, value);
};

/*** Narrow a serializable object to a keyed data record. */
const isDataRecord = (value: object): value is Readonly<Record<string, DataContractValue>> =>
  !Array.isArray(value);

/*** Narrow a serializable array without losing its element type. */
const isDataArray = (value: object): value is readonly DataContractValue[] => Array.isArray(value);

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
  error?: FlowError,
): FlowRunSnapshot => ({
  id: request.runId,
  flow: { id: graph.definition.id, version: graph.definition.version },
  status,
  trigger: { triggerId: request.triggerId, kind: 'manual' },
  createdAt: startedAt,
  startedAt,
  completedAt,
  steps,
  ...(error === undefined ? {} : { error }),
});
