import type { FlowDefinition, FlowEdge, FlowNode } from '@ankhorage/contracts/flow';

import type { FlowCompiledGraph, FlowNodeRegistry } from '../../../types/execution.js';

/*** Compile a valid acyclic graph into deterministic execution order. */
export const compileFlowGraph = (
  definition: FlowDefinition,
  registry: FlowNodeRegistry,
): FlowCompiledGraph => {
  const nodesById = indexNodes(definition.nodes);
  const edgesBySourceNodeId = indexEdges(definition.edges, nodesById);
  for (const node of definition.nodes) assertNodeIsExecutable(node, registry);
  return {
    definition,
    edgesBySourceNodeId,
    topologicalNodeIds: orderNodes(
      definition.nodes.map(({ id }) => id),
      definition.edges,
    ),
  };
};

/*** Index nodes while rejecting duplicate graph identifiers. */
const indexNodes = (nodes: readonly FlowNode[]): Readonly<Record<string, FlowNode>> => {
  const entries = nodes.map((node) => [node.id, node] as const);
  if (new Set(entries.map(([id]) => id)).size !== entries.length)
    throw new Error('FLOW_GRAPH_DUPLICATE_NODE_ID');
  return Object.fromEntries(entries);
};

/*** Validate and group graph edges by their producing node. */
const indexEdges = (
  edges: readonly FlowEdge[],
  nodesById: Readonly<Record<string, FlowNode>>,
): Readonly<Record<string, readonly FlowEdge[]>> => {
  if (new Set(edges.map(({ id }) => id)).size !== edges.length)
    throw new Error('FLOW_GRAPH_DUPLICATE_EDGE_ID');
  for (const edge of edges) {
    const source = nodesById[edge.source.nodeId];
    const target = nodesById[edge.target.nodeId];
    if (!source || !target) throw new Error(`FLOW_GRAPH_UNKNOWN_EDGE_NODE:${edge.id}`);
    assertPort(source, edge.source.portId, 'output', edge.id);
    assertPort(target, edge.target.portId, 'input', edge.id);
  }
  return edges.reduce<Readonly<Record<string, readonly FlowEdge[]>>>(
    (grouped, edge) => ({
      ...grouped,
      [edge.source.nodeId]: [...(grouped[edge.source.nodeId] ?? []), edge],
    }),
    {},
  );
};

/*** Ensure a graph port exists exactly once with the expected direction. */
const assertPort = (
  node: FlowNode,
  portId: string,
  direction: 'input' | 'output',
  edgeId: string,
): void => {
  if (node.ports.filter((port) => port.id === portId && port.direction === direction).length !== 1)
    throw new Error(`FLOW_GRAPH_INVALID_EDGE_PORT:${edgeId}`);
};

/*** Reject unknown operations and code capabilities before execution can begin. */
const assertNodeIsExecutable = (node: FlowNode, registry: FlowNodeRegistry): void => {
  const { capabilityId } = node.capability;
  if (capabilityId === 'code') throw new Error('FLOW_CODE_EXECUTION_DISABLED');
  if (
    !Object.entries(registry).some(
      ([registeredCapabilityId]) => registeredCapabilityId === capabilityId,
    )
  )
    throw new Error(`FLOW_OPERATION_UNREGISTERED:${capabilityId}`);
  if (
    new Set(node.ports.map(({ direction, id }) => `${direction}:${id}`)).size !== node.ports.length
  )
    throw new Error(`FLOW_GRAPH_DUPLICATE_PORT_ID:${node.id}`);
};

/*** Produce stable topological order and reject cycles without an explicit bounded-loop contract. */
const orderNodes = (nodeIds: readonly string[], edges: readonly FlowEdge[]): readonly string[] => {
  const incomingCounts = new Map(nodeIds.map((nodeId) => [nodeId, 0]));
  for (const edge of edges)
    incomingCounts.set(edge.target.nodeId, (incomingCounts.get(edge.target.nodeId) ?? 0) + 1);
  const pending = nodeIds.filter((nodeId) => incomingCounts.get(nodeId) === 0);
  const ordered: string[] = [];
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId) continue;
    ordered.push(nodeId);
    for (const edge of edges.filter((candidate) => candidate.source.nodeId === nodeId)) {
      const nextCount = (incomingCounts.get(edge.target.nodeId) ?? 0) - 1;
      incomingCounts.set(edge.target.nodeId, nextCount);
      if (nextCount === 0) pending.push(edge.target.nodeId);
    }
  }
  if (ordered.length !== nodeIds.length) throw new Error('FLOW_GRAPH_CYCLE');
  return ordered;
};
