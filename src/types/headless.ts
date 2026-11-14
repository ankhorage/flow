import type { DataContractValue } from '@ankhorage/contracts/data';
import type {
  FlowApprovalRequest,
  FlowDefinition,
  FlowExecutionStatus,
  FlowRunSnapshot,
  FlowTraceEvent,
} from '@ankhorage/contracts/flow';

import type { FlowClock, FlowNodeRegistry } from './execution.js';
import type { FlowSecurityActor } from './security.js';

/** A persisted, immutable workflow revision with its publication state. */
export interface FlowWorkflowRevision {
  readonly definition: FlowDefinition;
  readonly publishedAt?: string;
}

/** A redaction-safe event emitted whenever a run changes state. */
export interface FlowRunEvent {
  readonly id: number;
  readonly runId: string;
  readonly timestamp: string;
  readonly type:
    'approval_resolved' | 'run_cancelled' | 'run_completed' | 'run_queued' | 'run_started';
  readonly trace?: FlowTraceEvent;
}

/** Durable ownership boundary for headless Flow definitions, runs, approvals, and events. */
export interface FlowRuntimeStorePort {
  createDraftAsync(definition: FlowDefinition): Promise<FlowWorkflowRevision>;
  getRunAsync(runId: string): Promise<FlowRunSnapshot | undefined>;
  getWorkflowAsync(flowId: string, version?: number): Promise<FlowWorkflowRevision | undefined>;
  listRunsAsync(flowId?: string): Promise<readonly FlowRunSnapshot[]>;
  listWorkflowRevisionsAsync(flowId: string): Promise<readonly FlowWorkflowRevision[]>;
  publishAsync(
    flowId: string,
    version: number,
    publishedAt: string,
  ): Promise<FlowWorkflowRevision | undefined>;
  readEventsAsync(afterId: number, runId?: string): Promise<readonly FlowRunEvent[]>;
  resolveApprovalAsync(input: {
    readonly approvalId: string;
    readonly actorId: string;
    readonly approved: boolean;
    readonly now: string;
  }): Promise<FlowApprovalRequest | undefined>;
  saveApprovalAsync(approval: FlowApprovalRequest): Promise<void>;
  saveRunAsync(run: FlowRunSnapshot, idempotencyKey?: string): Promise<FlowRunSnapshot>;
  transitionRunAsync(input: {
    readonly expectedStatus: FlowExecutionStatus;
    readonly run: FlowRunSnapshot;
    readonly event: FlowRunEvent;
  }): Promise<boolean>;
}

/** One trusted server-owned request identity, never derived from client JSON. */
export interface FlowHttpAuthenticatorPort {
  authenticateAsync(request: Request): Promise<FlowSecurityActor | undefined>;
}

/** HTTP authorization and rate-limit gates are owned by the embedding server. */
export interface FlowHttpAccessPort {
  authorizeAsync(input: {
    readonly actor: FlowSecurityActor;
    readonly capability: string;
  }): Promise<boolean>;
  acquireAsync(input: {
    readonly actor: FlowSecurityActor;
    readonly capability: string;
  }): Promise<boolean>;
}

/** Dependencies selected at composition time for the client-independent runtime. */
export interface FlowRuntimeDependencies {
  readonly clock?: FlowClock;
  readonly nodeRegistry: FlowNodeRegistry;
  readonly observability?: FlowObservabilityPort;
  readonly store: FlowRuntimeStorePort;
}

/** A redaction-safe audit fact retained by the host for a bounded period. */
export interface FlowAuditRecord {
  readonly action: string;
  readonly category: 'approval' | 'execution' | 'validation';
  readonly occurredAt: string;
  readonly runId?: string;
}

/** Host-owned observability boundary; it accepts metadata only, never run payloads. */
export interface FlowObservabilityPort {
  recordAsync(record: FlowAuditRecord): Promise<void>;
  snapshotAsync(): Promise<{
    readonly audit: readonly FlowAuditRecord[];
    readonly metrics: Readonly<Record<string, number>>;
  }>;
}

/** Headless workflow command boundary shared by HTTP, CLI, and generated applications. */
export interface FlowRuntime {
  cancelRunAsync(runId: string): Promise<FlowRunSnapshot | undefined>;
  createDraftAsync(definition: FlowDefinition): Promise<FlowWorkflowRevision>;
  getRunAsync(runId: string): Promise<FlowRunSnapshot | undefined>;
  getWorkflowAsync(flowId: string, version?: number): Promise<FlowWorkflowRevision | undefined>;
  listRunsAsync(flowId?: string): Promise<readonly FlowRunSnapshot[]>;
  listWorkflowRevisionsAsync(flowId: string): Promise<readonly FlowWorkflowRevision[]>;
  publishAsync(flowId: string, version: number): Promise<FlowWorkflowRevision | undefined>;
  readEventsAsync(afterId: number, runId?: string): Promise<readonly FlowRunEvent[]>;
  requestApprovalAsync(input: { readonly approval: FlowApprovalRequest }): Promise<void>;
  resolveApprovalAsync(input: {
    readonly actorId: string;
    readonly approvalId: string;
    readonly approved: boolean;
  }): Promise<FlowApprovalRequest | undefined>;
  retryRunAsync(runId: string): Promise<FlowRunSnapshot | undefined>;
  runWorkerTickAsync(): Promise<readonly string[]>;
  triggerAsync(input: {
    readonly flowId: string;
    readonly idempotencyKey: string;
    readonly input?: Readonly<
      Record<string, { readonly kind: 'inline'; readonly value: DataContractValue }>
    >;
    readonly triggerId: string;
  }): Promise<FlowRunSnapshot>;
}
