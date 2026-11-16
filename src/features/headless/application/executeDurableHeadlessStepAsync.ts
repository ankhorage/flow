import type { DataSchemaRegistry } from '@ankhorage/contracts/data';
import type { FlowDefinition, FlowNode, FlowStepSnapshot } from '@ankhorage/contracts/flow';

import type {
  FlowDurableEffectResult,
  FlowDurableRun,
  FlowDurableWork,
} from '../../../types/durableExecution.js';
import type { FlowClock, FlowCompiledGraph, FlowNodeRegistry } from '../../../types/execution.js';
import { executeFlowAsync } from '../../execution/application/executeFlowAsync.js';
import { assertFlowGraphSchemasSupported } from '../../execution/domain/assertFlowGraphSchemasSupported.js';
import { compileFlowGraph } from '../../execution/domain/compileFlowGraph.js';
import { planFlowNodeInput } from '../../execution/domain/planFlowNodeInput.js';
import { createDurableHeadlessWork } from './createDurableHeadlessWork.js';

/*** Execute one materialized graph node and persist the exact downstream branch plan with its checkpoint. */
export const executeDurableHeadlessStepAsync = async (
  input: {
    readonly definition: FlowDefinition;
    readonly durableRun: FlowDurableRun;
    readonly registry: FlowNodeRegistry;
    readonly schemaRegistry?: DataSchemaRegistry;
    readonly work: FlowDurableWork;
    readonly reconcile?: boolean;
  },
  clock: FlowClock,
): Promise<FlowDurableEffectResult | 'unknown'> => {
  assertFlowGraphSchemasSupported(input.definition.nodes, input.schemaRegistry);
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
    input.schemaRegistry,
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
  schemaRegistry: DataSchemaRegistry | undefined,
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
      schemaRegistry,
      triggerId: work.triggerId ?? definition.triggers[0]?.id ?? '',
    },
    clock,
  );
  const [step] = result.run.steps;
  if (step === undefined) throw new Error('FLOW_DURABLE_STEP_RESULT_MISSING');
  return step;
};

/** Materialize only nodes that the canonical graph policy declares ready. */
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
      const planned = planFlowNodeInput(graph, node.id, steps);
      return planned.status !== 'ready'
        ? []
        : [
            createDurableHeadlessWork({
              attempt: 1,
              dueAt: now.toISOString(),
              flow: run.flow,
              ...(Object.keys(planned.input).length === 0 ? {} : { input: planned.input }),
              node,
              registry,
              runId: run.id,
              triggerId: completedWork.triggerId ?? '',
            }),
          ];
    });

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
