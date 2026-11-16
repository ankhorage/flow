import type { DataSchemaRegistry } from '@ankhorage/contracts/data';
import type {
  FlowDataRef,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowNodeConfig,
  FlowPortId,
  FlowRunSnapshot,
} from '@ankhorage/contracts/flow';

import type { FlowResolvedSecrets, FlowSecurityOperation } from './security.js';

export interface FlowClock {
  readonly now: () => Date;
}
export interface FlowNodeOperationResult {
  readonly output?: Readonly<Record<FlowPortId, FlowDataRef>>;
}
/** A stable execution-owner identity for one logical node effect, independent of delivery attempts. */
export interface FlowNodeEffectIdentity {
  readonly idempotencyKey: string;
}
/** Trusted provider metadata that determines whether a node can cross a security boundary. */
export type FlowNodeEffect =
  | { readonly kind: 'internal' }
  | {
      readonly kind: 'protected';
      readonly createSecurityOperation: (input: {
        readonly effect: FlowNodeEffectIdentity;
        readonly node: FlowNode;
        readonly runId: string;
      }) => FlowSecurityOperation;
    };
export interface FlowNodeOperation {
  readonly effect: FlowNodeEffect;
  readonly executeAsync: (input: {
    readonly config: FlowNodeConfig | undefined;
    readonly effect: FlowNodeEffectIdentity;
    readonly input: Readonly<Record<FlowPortId, FlowDataRef>>;
    readonly node: FlowNode;
    /** Server-only credentials supplied by the one canonical protected-effect permit. */
    readonly secrets?: FlowResolvedSecrets;
    readonly signal: AbortSignal;
  }) => Promise<FlowNodeOperationResult>;
  /**
   * Reconstruct the original result from the provider's stable idempotency receipt without
   * performing the provider effect again. Protected durable operations require this boundary.
   */
  readonly reconcileAsync?: (input: {
    readonly config: FlowNodeConfig | undefined;
    readonly effect: FlowNodeEffectIdentity;
    readonly input: Readonly<Record<FlowPortId, FlowDataRef>>;
    readonly node: FlowNode;
    /** Server-only credentials supplied only while reconciling a protected delivery. */
    readonly secrets?: FlowResolvedSecrets;
  }) => Promise<FlowNodeOperationResult | 'unknown'>;
}
export type FlowNodeRegistry = Readonly<Record<string, FlowNodeOperation>>;
export interface FlowCompiledGraph {
  readonly definition: FlowDefinition;
  readonly edgesBySourceNodeId: Readonly<Record<string, readonly FlowEdge[]>>;
  readonly topologicalNodeIds: readonly string[];
}
export interface FlowRunRequest {
  readonly effectIdentity?: FlowNodeEffectIdentity;
  readonly input?: Readonly<Record<FlowPortId, FlowDataRef>>;
  readonly runId: string;
  /** Server-only credentials supplied by a durable protected-effect permit. */
  readonly secrets?: FlowResolvedSecrets;
  readonly schemaRegistry?: DataSchemaRegistry;
  readonly signal?: AbortSignal;
  readonly triggerId: string;
}
export interface FlowExecutionResult {
  readonly run: FlowRunSnapshot;
}
