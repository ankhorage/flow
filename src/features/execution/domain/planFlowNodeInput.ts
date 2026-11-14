import type { DataContractValue } from '@ankhorage/contracts/data';
import type {
  FlowDataRef,
  FlowEdge,
  FlowPortId,
  FlowStepSnapshot,
} from '@ankhorage/contracts/flow';

import type { FlowCompiledGraph } from '../../../types/execution.js';
import { structurallyEqual } from './structurallyEqual.js';

type FlowNodePlan =
  | { readonly input: Readonly<Record<FlowPortId, FlowDataRef>>; readonly status: 'ready' }
  | { readonly status: 'inactive' | 'pending' };

/*** Determine one node's canonical branch activation and typed input from completed graph steps. */
export const planFlowNodeInput = (
  graph: FlowCompiledGraph,
  nodeId: string,
  steps: readonly FlowStepSnapshot[],
  rootInput: Readonly<Record<FlowPortId, FlowDataRef>> = {},
): FlowNodePlan => {
  const plans = new Map<string, FlowNodePlan>();
  const stepsByNodeId = new Map(steps.map((step) => [step.nodeId, step]));
  return planNode(graph, nodeId, rootInput, plans, stepsByNodeId);
};

/*** Resolve predecessor state recursively so inactive branches cannot strand a durable join. */
const planNode = (
  graph: FlowCompiledGraph,
  nodeId: string,
  rootInput: Readonly<Record<FlowPortId, FlowDataRef>>,
  plans: Map<string, FlowNodePlan>,
  stepsByNodeId: ReadonlyMap<string, FlowStepSnapshot>,
): FlowNodePlan => {
  const cached = plans.get(nodeId);
  if (cached !== undefined) return cached;
  const node = graph.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`FLOW_GRAPH_UNKNOWN_NODE:${nodeId}`);
  const completed = stepsByNodeId.get(nodeId);
  if (completed !== undefined) return { input: completed.input ?? {}, status: 'ready' };
  const incoming = graph.definition.edges.filter((edge) => edge.target.nodeId === nodeId);
  const plan =
    incoming.length === 0
      ? planActivatedNode(node, rootInput)
      : planIncomingNode(graph, node, incoming, rootInput, plans, stepsByNodeId);
  plans.set(nodeId, plan);
  return plan;
};

/*** Wait only for predecessors which are canonically active but have not completed yet. */
const planIncomingNode = (
  graph: FlowCompiledGraph,
  node: FlowCompiledGraph['definition']['nodes'][number],
  incoming: readonly FlowEdge[],
  rootInput: Readonly<Record<FlowPortId, FlowDataRef>>,
  plans: Map<string, FlowNodePlan>,
  stepsByNodeId: ReadonlyMap<string, FlowStepSnapshot>,
): FlowNodePlan => {
  const predecessorPlans = incoming.map((edge) => ({
    edge,
    plan: planNode(graph, edge.source.nodeId, rootInput, plans, stepsByNodeId),
    step: stepsByNodeId.get(edge.source.nodeId),
  }));
  if (
    predecessorPlans.some(
      ({ plan, step }) =>
        plan.status === 'pending' || (plan.status === 'ready' && step === undefined),
    )
  )
    return { status: 'pending' };
  const matching = predecessorPlans.filter(
    ({ edge, step }) =>
      step !== undefined &&
      edgeMatches(
        edge,
        step.output?.[edge.source.portId],
        step.status === 'failed' ? 'failure' : 'success',
      ),
  );
  if (matching.length === 0) return { status: 'inactive' };
  return planActivatedNode(
    node,
    Object.fromEntries(
      matching.flatMap(({ edge, step }) => {
        const value = step?.output?.[edge.source.portId];
        return value === undefined ? [] : [[edge.target.portId, value]];
      }),
    ),
  );
};

/*** Reject activation when a matched branch cannot satisfy the node's required typed ports. */
const planActivatedNode = (
  node: FlowCompiledGraph['definition']['nodes'][number],
  input: Readonly<Record<FlowPortId, FlowDataRef>>,
): FlowNodePlan =>
  node.ports
    .filter((port) => port.direction === 'input' && port.required)
    .every((port) => input[port.id] !== undefined)
    ? { input, status: 'ready' }
    : { status: 'inactive' };

/*** Evaluate a portable declarative edge condition without executing user expressions. */
const edgeMatches = (
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

/*** Resolve RFC 6901 data pointers over portable inline values. */
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
      return Object.entries(current).find(([candidate]) => candidate === key)?.[1];
    }, value);
};

/*** Narrow an inline JSON array without losing its portable element type. */
const isDataArray = (value: object): value is readonly DataContractValue[] => Array.isArray(value);
