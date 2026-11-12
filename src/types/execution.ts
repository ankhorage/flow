import type {
  FlowDataRef,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowNodeConfig,
  FlowPortId,
  FlowRunSnapshot,
} from '@ankhorage/contracts/flow';

export interface FlowClock {
  readonly now: () => Date;
}
export interface FlowNodeOperationResult {
  readonly output?: Readonly<Record<FlowPortId, FlowDataRef>>;
}
export interface FlowNodeOperation {
  readonly executeAsync: (input: {
    readonly config: FlowNodeConfig | undefined;
    readonly input: Readonly<Record<FlowPortId, FlowDataRef>>;
    readonly node: FlowNode;
    readonly signal: AbortSignal;
  }) => Promise<FlowNodeOperationResult>;
}
export type FlowNodeRegistry = Readonly<Record<string, FlowNodeOperation>>;
export interface FlowCompiledGraph {
  readonly definition: FlowDefinition;
  readonly edgesBySourceNodeId: Readonly<Record<string, readonly FlowEdge[]>>;
  readonly topologicalNodeIds: readonly string[];
}
export interface FlowRunRequest {
  readonly input?: Readonly<Record<FlowPortId, FlowDataRef>>;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly triggerId: string;
}
export interface FlowExecutionResult {
  readonly run: FlowRunSnapshot;
}
