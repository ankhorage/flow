import type { DataContractValue, DataSchemaRegistry } from '@ankhorage/contracts/data';
import type {
  FlowApprovalRequest,
  FlowApprovalStatus,
  FlowDefinition,
  FlowExecutionStatus,
  FlowRunSnapshot,
  FlowTraceEvent,
} from '@ankhorage/contracts/flow';

import type { FlowPersistencePort } from '../features/execution/ports/FlowPersistencePort.js';
import type { FlowClock, FlowNodeRegistry } from './execution.js';
import type { FlowSecurityActor } from './security.js';
import type { FlowSecurityPort } from './security.js';

/** A trusted tenant/project boundary derived by the embedding authenticator. */
export interface FlowResourceScope {
  readonly projectId: string;
  readonly tenantId: string;
}

/** A persisted, immutable workflow revision with its publication state. */
export interface FlowWorkflowRevision {
  readonly definition: FlowDefinition;
  readonly publishedAt?: string;
  readonly scope: FlowResourceScope;
}

/** A redaction-safe, server-authoritative approval state for one exact Flow run revision. */
export interface FlowApprovalAvailability {
  readonly approvalId: string;
  readonly expiresAt?: string;
  readonly flowId: string;
  readonly flowVersion: number;
  readonly runId: string;
  readonly status: 'approved' | 'cancelled' | 'expired' | 'pending' | 'rejected';
}

/** Internal store projection that prevents approval context and identities crossing the read port. */
interface FlowApprovalAvailabilityRecord {
  readonly expiresAt?: string;
  readonly id: string;
  readonly runId: string;
  readonly status: FlowApprovalStatus;
}

/** A redaction-safe event emitted whenever a run changes state. */
export interface FlowRunEvent {
  readonly id: number;
  readonly runId: string;
  readonly timestamp: string;
  readonly type:
    | 'approval_resolved'
    | 'run_cancelled'
    | 'run_completed'
    | 'run_progressed'
    | 'run_queued'
    | 'run_started';
  readonly trace?: FlowTraceEvent;
}

/** Durable ownership boundary for headless Flow definitions, runs, approvals, and events. */
export interface FlowRuntimeStorePort {
  createDraftAsync(
    scope: FlowResourceScope,
    definition: FlowDefinition,
  ): Promise<FlowWorkflowRevision>;
  getRunAsync(scope: FlowResourceScope, runId: string): Promise<FlowRunSnapshot | undefined>;
  getApprovalAsync(
    scope: FlowResourceScope,
    approvalId: string,
  ): Promise<FlowApprovalAvailabilityRecord | undefined>;
  getWorkflowAsync(
    scope: FlowResourceScope,
    flowId: string,
    version?: number,
  ): Promise<FlowWorkflowRevision | undefined>;
  listRunsAsync(scope: FlowResourceScope, flowId?: string): Promise<readonly FlowRunSnapshot[]>;
  /** Enumerate accepted but not yet started runs so a restarted worker can repair queue handoff. */
  listPendingRunsAsync(): Promise<
    readonly { readonly run: FlowRunSnapshot; readonly scope: FlowResourceScope }[]
  >;
  listWorkflowRevisionsAsync(
    scope: FlowResourceScope,
    flowId: string,
  ): Promise<readonly FlowWorkflowRevision[]>;
  publishAsync(
    scope: FlowResourceScope,
    flowId: string,
    version: number,
    publishedAt: string,
  ): Promise<FlowWorkflowRevision | undefined>;
  readEventsAsync(
    scope: FlowResourceScope,
    afterId: number,
    runId?: string,
  ): Promise<readonly FlowRunEvent[]>;
  resolveApprovalAsync(input: {
    readonly approvalId: string;
    readonly actorId: string;
    readonly approved: boolean;
    readonly now: string;
    readonly scope: FlowResourceScope;
  }): Promise<FlowApprovalRequest | undefined>;
  saveApprovalAsync(scope: FlowResourceScope, approval: FlowApprovalRequest): Promise<void>;
  saveRunAsync(
    scope: FlowResourceScope,
    run: FlowRunSnapshot,
    idempotencyKey?: string,
  ): Promise<FlowRunSnapshot>;
  transitionRunAsync(input: {
    readonly expectedStatus: FlowExecutionStatus;
    readonly run: FlowRunSnapshot;
    readonly event: FlowRunEvent;
    readonly scope: FlowResourceScope;
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
  readonly persistence: FlowPersistencePort;
  /** Canonical registry used to resolve every declared revision schema before durable delivery. */
  readonly schemaRegistry?: DataSchemaRegistry;
  readonly security?: FlowSecurityPort;
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
  cancelRunAsync(scope: FlowResourceScope, runId: string): Promise<FlowRunSnapshot | undefined>;
  createDraftAsync(
    scope: FlowResourceScope,
    definition: FlowDefinition,
  ): Promise<FlowWorkflowRevision>;
  getRunAsync(scope: FlowResourceScope, runId: string): Promise<FlowRunSnapshot | undefined>;
  getApprovalAvailabilityAsync(input: {
    readonly approvalId: string;
    readonly flowId: string;
    readonly flowVersion: number;
    readonly runId: string;
    readonly scope: FlowResourceScope;
  }): Promise<FlowApprovalAvailability | undefined>;
  getWorkflowAsync(
    scope: FlowResourceScope,
    flowId: string,
    version?: number,
  ): Promise<FlowWorkflowRevision | undefined>;
  listRunsAsync(scope: FlowResourceScope, flowId?: string): Promise<readonly FlowRunSnapshot[]>;
  listWorkflowRevisionsAsync(
    scope: FlowResourceScope,
    flowId: string,
  ): Promise<readonly FlowWorkflowRevision[]>;
  publishAsync(
    scope: FlowResourceScope,
    flowId: string,
    version: number,
  ): Promise<FlowWorkflowRevision | undefined>;
  readEventsAsync(
    scope: FlowResourceScope,
    afterId: number,
    runId?: string,
  ): Promise<readonly FlowRunEvent[]>;
  requestApprovalAsync(input: {
    readonly approval: FlowApprovalRequest;
    readonly scope: FlowResourceScope;
  }): Promise<void>;
  resolveApprovalAsync(input: {
    readonly actorId: string;
    readonly approvalId: string;
    readonly approved: boolean;
    readonly scope: FlowResourceScope;
  }): Promise<FlowApprovalRequest | undefined>;
  retryRunAsync(scope: FlowResourceScope, runId: string): Promise<FlowRunSnapshot | undefined>;
  runWorkerTickAsync(): Promise<readonly string[]>;
  triggerAsync(input: {
    readonly flowId: string;
    readonly idempotencyKey: string;
    readonly input?: Readonly<
      Record<string, { readonly kind: 'inline'; readonly value: DataContractValue }>
    >;
    readonly scope: FlowResourceScope;
    readonly triggerId: string;
  }): Promise<FlowRunSnapshot>;
}
