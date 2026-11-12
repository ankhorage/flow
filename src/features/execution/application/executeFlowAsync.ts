import type {
  DataContractValue,
  DataSchema,
  DataSchemaPrimitiveType,
} from '@ankhorage/contracts/data';
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

/*** Execute a compiled graph in deterministic order within one process. */
export const executeFlowAsync = async (
  graph: FlowCompiledGraph,
  registry: FlowNodeRegistry,
  request: FlowRunRequest,
  clock: FlowClock = { now: () => new Date() },
): Promise<FlowExecutionResult> => {
  const trigger = graph.definition.triggers.find(({ id }) => id === request.triggerId);
  if (trigger?.kind !== 'manual') throw new Error('FLOW_TRIGGER_NOT_MANUAL');
  const startedAt = clock.now().toISOString();
  const state: ExecutionState = { inputs: {}, steps: [] };
  for (const nodeId of graph.topologicalNodeIds) {
    if (request.signal?.aborted)
      return {
        run: createRun(
          graph,
          request,
          state.steps,
          startedAt,
          clock.now().toISOString(),
          'cancelled',
        ),
      };
    const node = graph.definition.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`FLOW_GRAPH_UNKNOWN_NODE:${nodeId}`);
    const input = state.inputs[node.id] ?? request.input ?? {};
    if (!hasRequiredInput(node, input)) continue;
    assertPortSchemas(node, input, 'input');
    const result = await executeNodeAsync(node, input, registry, request.signal, clock);
    state.steps.push(result.step);
    if (result.step.status === 'failed')
      return {
        run: createRun(
          graph,
          request,
          state.steps,
          startedAt,
          clock.now().toISOString(),
          'failed',
          result.step.error,
        ),
      };
    propagateOutput(graph.edgesBySourceNodeId[node.id] ?? [], result.output, state.inputs);
  }
  return {
    run: createRun(graph, request, state.steps, startedAt, clock.now().toISOString(), 'succeeded'),
  };
};

interface ExecutionState {
  readonly inputs: Record<string, Record<FlowPortId, FlowDataRef>>;
  readonly steps: FlowStepSnapshot[];
}

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
): Promise<{
  readonly output: Readonly<Record<FlowPortId, FlowDataRef>>;
  readonly step: FlowStepSnapshot;
}> => {
  const startedAt = clock.now().toISOString();
  try {
    const operation = Object.entries(registry).find(
      ([capabilityId]) => capabilityId === node.capability.capabilityId,
    )?.[1];
    if (!operation) throw new Error(`FLOW_OPERATION_UNREGISTERED:${node.capability.capabilityId}`);
    const output =
      (
        await operation.executeAsync({
          config: node.config,
          input,
          node,
          signal: signal ?? new AbortController().signal,
        })
      ).output ?? {};
    assertOutputPorts(node, output);
    assertPortSchemas(node, output, 'output');
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
};

/*** Validate inline port values against their declared portable schemas. */
const assertPortSchemas = (
  node: FlowNode,
  values: Readonly<Record<FlowPortId, FlowDataRef>>,
  direction: 'input' | 'output',
): void => {
  for (const port of node.ports.filter((candidate) => candidate.direction === direction)) {
    const value = values[port.id];
    if (
      value?.kind === 'inline' &&
      port.data?.schema &&
      !matchesSchema(value.value, port.data.schema)
    )
      throw new Error(`FLOW_PORT_SCHEMA_MISMATCH:${node.id}:${port.id}`);
  }
};

/*** Match primitive portable schema types without coercing values. */
const matchesSchema = (value: DataContractValue, schema: DataSchema): boolean => {
  const types: readonly DataSchemaPrimitiveType[] = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) return false;
  if (schema.const !== undefined && !structurallyEqual(value, schema.const)) return false;
  return !schema.enum || schema.enum.some((candidate) => structurallyEqual(value, candidate));
};

/*** Determine whether a value has the declared JSON primitive type. */
const matchesType = (value: DataContractValue, type: DataSchemaPrimitiveType): boolean => {
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'null') return value === null;
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
};

/*** Propagate outputs only over edges whose declared condition matches the output value. */
const propagateOutput = (
  edges: readonly FlowEdge[],
  output: Readonly<Record<FlowPortId, FlowDataRef>>,
  inputs: Record<string, Record<FlowPortId, FlowDataRef>>,
): void => {
  for (const edge of edges) {
    const value = output[edge.source.portId];
    if (value && matchesEdge(edge, value))
      inputs[edge.target.nodeId] = { ...inputs[edge.target.nodeId], [edge.target.portId]: value };
  }
};

/*** Evaluate an edge condition without executing arbitrary expressions. */
const matchesEdge = (edge: FlowEdge, value: FlowDataRef): boolean => {
  const condition = edge.condition ?? { kind: 'always' as const };
  if (condition.kind === 'always') return true;
  if (condition.kind === 'outcome') return condition.outcome === 'success';
  if (value.kind !== 'inline') return false;
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

/*** Compare JSON-compatible values with object-key-order independence. */
const structurallyEqual = (left: DataContractValue, right: DataContractValue): boolean =>
  JSON.stringify(normalizeValue(left)) === JSON.stringify(normalizeValue(right));

/*** Canonicalize object member ordering for structural equality. */
const normalizeValue = (value: DataContractValue): DataContractValue => {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  return value;
};

/*** Narrow a serializable non-array object to an indexable data record. */
const isDataRecord = (value: object): value is Readonly<Record<string, DataContractValue>> =>
  !Array.isArray(value);

/*** Narrow a serializable array without losing its element type. */
const isDataArray = (value: object): value is readonly DataContractValue[] => Array.isArray(value);

/*** Translate host failures to structured contract errors without exposing arbitrary objects. */
const asFlowError = (reason: unknown): FlowError => ({
  code:
    reason instanceof Error
      ? (reason.message.split(':')[0] ?? 'FLOW_OPERATION_FAILED')
      : 'FLOW_OPERATION_FAILED',
  message: reason instanceof Error ? reason.message : 'The operation failed.',
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
  error,
});
