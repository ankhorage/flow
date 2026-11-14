import type {
  FlowDataRef,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowStepSnapshot,
} from '@ankhorage/contracts/flow';

import type {
  FlowDurableEffectResult,
  FlowDurableRun,
  FlowDurableWork,
} from '../../../types/durableExecution.js';
import type { FlowClock, FlowCompiledGraph, FlowNodeRegistry } from '../../../types/execution.js';
import { executeFlowAsync } from '../../execution/application/executeFlowAsync.js';
import { compileFlowGraph } from '../../execution/domain/compileFlowGraph.js';
import { createDurableHeadlessWork } from './createDurableHeadlessWork.js';

/*** Execute one materialized graph node and persist the exact downstream branch plan with its checkpoint. */
export const executeDurableHeadlessStepAsync = async (
  input: {
    readonly definition: FlowDefinition;
    readonly durableRun: FlowDurableRun;
    readonly registry: FlowNodeRegistry;
    readonly work: FlowDurableWork;
    readonly reconcile?: boolean;
  },
  clock: FlowClock,
): Promise<FlowDurableEffectResult | 'unknown'> => {
  const nodeId = input.work.stepId;
  if (nodeId === undefined) throw new Error('FLOW_DURABLE_STEP_ID_MISSING');
  if (nodeId === '__flow_complete__') return completedFlow(input.durableRun);
  const graph = compileFlowGraph(input.definition, input.registry);
  const node = input.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error('FLOW_DURABLE_STEP_NODE_MISSING');
  const step = await executeStepAsync(
    input.definition,
    node,
    input.work,
    input.registry,
    clock,
    input.reconcile === true,
  );
  if (step === 'unknown') return 'unknown';
  const steps = mergeSteps(input.durableRun.checkpoint?.steps, step);
  const checkpoint = {
    completedStepIds: input.durableRun.checkpoint?.completedStepIds ?? [],
    failedStepIds: input.durableRun.checkpoint?.failedStepIds ?? [],
    steps,
  };
  const nextWork = planReadyWork(
    graph,
    input.durableRun,
    input.work,
    steps,
    clock.now(),
    input.registry,
  );
  return {
    checkpoint,
    nextWork,
    status: nextWork.length === 0 ? terminalStatus(steps) : 'running',
  };
};

/** Execute the one compiled node through the existing typed executor rather than a parallel node engine. */
const executeStepAsync = async (
  definition: FlowDefinition,
  node: FlowNode,
  work: FlowDurableWork,
  registry: FlowNodeRegistry,
  clock: FlowClock,
  reconcile: boolean,
): Promise<FlowStepSnapshot | 'unknown'> => {
  const operationId = `${node.capability.providerId}:${node.capability.capabilityId}`;
  const operation = Object.entries(registry).find(([id]) => id === operationId)?.[1];
  if (operation === undefined) throw new Error(`FLOW_OPERATION_UNREGISTERED:${operationId}`);
  const effect = { idempotencyKey: work.idempotencyKey ?? `${work.runId}:step:${node.id}` };
  const reconciled = reconcile
    ? await operation.reconcileAsync?.({
        config: node.config,
        effect,
        input: work.input ?? {},
        node,
      })
    : undefined;
  if (reconcile && reconciled === undefined) return 'unknown';
  if (reconciled === 'unknown') return 'unknown';
  const result = await executeFlowAsync(
    compileFlowGraph({ ...definition, edges: [], nodes: [node] }, registry),
    {
      ...registry,
      ...(reconciled === undefined
        ? {}
        : { [operationId]: { ...operation, executeAsync: () => Promise.resolve(reconciled) } }),
    },
    {
      effectIdentity: effect,
      input: work.input,
      runId: work.runId,
      triggerId: work.triggerId ?? definition.triggers[0]?.id ?? '',
    },
    clock,
  );
  const [step] = result.run.steps;
  if (step === undefined) throw new Error('FLOW_DURABLE_STEP_RESULT_MISSING');
  return step;
};

/** Materialize only nodes whose complete predecessor set makes their typed input and branch activation known. */
const planReadyWork = (
  graph: FlowCompiledGraph,
  run: FlowDurableRun,
  completedWork: FlowDurableWork,
  steps: readonly FlowStepSnapshot[],
  now: Date,
  registry: FlowNodeRegistry,
): readonly FlowDurableWork[] =>
  graph.topologicalNodeIds
    .filter((nodeId) => !steps.some((step) => step.nodeId === nodeId))
    .flatMap((nodeId) => {
      const node = graph.definition.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return [];
      const planned = planNodeInput(graph, node, steps);
      return planned === undefined
        ? []
        : [
            createDurableHeadlessWork({
              attempt: 1,
              dueAt: now.toISOString(),
              flow: run.flow,
              ...(Object.keys(planned).length === 0 ? {} : { input: planned }),
              node,
              registry,
              runId: run.id,
              triggerId: completedWork.triggerId ?? '',
            }),
          ];
    });

/** Return an input only after every upstream result is known and every required port was activated. */
const planNodeInput = (
  graph: FlowCompiledGraph,
  node: FlowNode,
  steps: readonly FlowStepSnapshot[],
): Readonly<Record<string, FlowDataRef>> | undefined => {
  const incoming = graph.definition.edges.filter((edge) => edge.target.nodeId === node.id);
  if (incoming.length === 0) return {};
  const sourceSteps = incoming.map(
    (edge) => [edge, steps.find((step) => step.nodeId === edge.source.nodeId)] as const,
  );
  if (sourceSteps.some(([, step]) => step === undefined)) return undefined;
  const input = Object.fromEntries(
    sourceSteps.flatMap(([edge, step]) => {
      const value = step?.output?.[edge.source.portId];
      return edgeMatches(edge, value, step?.status === 'failed' ? 'failure' : 'success') &&
        value !== undefined
        ? [[edge.target.portId, value]]
        : [];
    }),
  );
  const activated = sourceSteps.some(([edge, step]) =>
    edgeMatches(
      edge,
      step?.output?.[edge.source.portId],
      step?.status === 'failed' ? 'failure' : 'success',
    ),
  );
  const hasRequired = node.ports
    .filter((port) => port.direction === 'input' && port.required)
    .every((port) => input[port.id] !== undefined);
  return activated && hasRequired ? input : undefined;
};

/** Apply the same declarative branch conditions as the compiled executor. */
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
  return selected !== undefined && JSON.stringify(selected) === JSON.stringify(condition.equals);
};

/** Resolve a portable JSON pointer without evaluating user-provided expressions. */
const resolvePointer = (value: unknown, pointer: string): unknown =>
  pointer === ''
    ? value
    : !pointer.startsWith('/')
      ? undefined
      : pointer
          .slice(1)
          .split('/')
          .reduce<unknown>((current, segment) => {
            if (current === null || typeof current !== 'object') return undefined;
            const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
            return Array.isArray(current)
              ? current[Number(key)]
              : Object.entries(current).find(([candidate]) => candidate === key)?.[1];
          }, value);

/** Complete an empty graph without inventing a synthetic provider effect. */
const completedFlow = (run: FlowDurableRun): FlowDurableEffectResult => ({
  checkpoint: {
    completedStepIds: run.checkpoint?.completedStepIds ?? [],
    failedStepIds: run.checkpoint?.failedStepIds ?? [],
    steps: run.checkpoint?.steps ?? [],
  },
  nextWork: [],
  status: 'succeeded',
});

/** Keep each node's latest persisted step snapshot exactly once. */
const mergeSteps = (
  steps: readonly FlowStepSnapshot[] | undefined,
  step: FlowStepSnapshot,
): readonly FlowStepSnapshot[] => [
  ...(steps ?? []).filter((candidate) => candidate.nodeId !== step.nodeId),
  step,
];

/** Expose terminal graph failure without leaking provider failure values. */
const terminalStatus = (steps: readonly FlowStepSnapshot[]): 'failed' | 'succeeded' =>
  steps.some((step) => step.status === 'failed') ? 'failed' : 'succeeded';
