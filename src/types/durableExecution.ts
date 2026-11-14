import type { DataContractValue } from '@ankhorage/contracts/data';
import type { FlowDataRef, FlowStepSnapshot } from '@ankhorage/contracts/flow';

import type { FlowResourceScope } from './headless.js';
import type { FlowSecurityOperation } from './security.js';

export interface FlowDefinitionRef {
  readonly id: string;
  readonly version: number;
}

export interface FlowDurableRun {
  readonly checkpoint?: FlowRunCheckpoint;
  readonly createdAt: string;
  readonly flow: FlowDefinitionRef;
  readonly id: string;
  readonly revision: number;
  readonly scope?: FlowResourceScope;
  readonly status: 'cancelled' | 'failed' | 'queued' | 'running' | 'succeeded' | 'waiting_approval';
  readonly updatedAt: string;
}

export interface FlowDurableWork {
  readonly attempt: number;
  readonly dueAt: string;
  /** Explicitly separates side-effect-free internal work from a security-protected provider effect. */
  readonly effectKind: 'internal' | 'protected';
  readonly flow: FlowDefinitionRef;
  readonly id: string;
  readonly idempotencyKey?: string;
  /** Materialized typed inputs for exactly one compiled graph node. */
  readonly input?: Readonly<Record<string, FlowDataRef>>;
  readonly lease?: {
    readonly expiresAt: string;
    readonly fencingToken: number;
    readonly workerId: string;
  };
  readonly runId: string;
  readonly securityOperation?: FlowSecurityOperation;
  readonly stepId?: string;
  /** The immutable trigger selected when this run was accepted. */
  readonly triggerId?: string;
  readonly status: 'cancelled' | 'claimed' | 'completed' | 'ready';
}

export interface FlowRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
}

/** A durable step result persisted with its outbox before its checkpoint is finalized. */
export interface FlowDurableEffectResult {
  readonly checkpoint?: FlowRunCheckpoint;
  readonly nextWork?: readonly FlowDurableWork[];
  readonly status?: FlowDurableRun['status'];
}

/** Application-owned effect boundary; adapters apply the supplied stable key at their provider boundary. */
export interface FlowDurableEffectPort {
  readonly compensateAsync?: (input: {
    readonly run: FlowDurableRun;
    readonly work: FlowDurableWork;
  }) => Promise<FlowDurableEffectResult | void>;
  readonly executeAsync: (input: {
    readonly idempotencyKey: string;
    readonly run: FlowDurableRun;
    readonly work: FlowDurableWork;
  }) => Promise<FlowDurableEffectResult | void>;
  readonly reconcileAsync?: (input: {
    readonly idempotencyKey: string;
    readonly run: FlowDurableRun;
    readonly work: FlowDurableWork;
  }) => Promise<FlowDurableEffectResult | 'unknown'>;
}

/** Observable outcome for every delivery claimed by one bounded worker tick. */
export interface FlowWorkerOutcome {
  readonly error?: string;
  readonly status:
    | 'already_completed'
    | 'cancelled'
    | 'failed'
    | 'lost_lease'
    | 'retry_scheduled'
    | 'succeeded'
    | 'waiting_approval';
  readonly workId: string;
}

/** Summary of one worker tick; delivery remains at-least-once until fenced completion. */
export interface FlowWorkerResult {
  readonly claimedWorkIds: readonly string[];
  readonly outcomes: readonly FlowWorkerOutcome[];
  readonly recoveredWorkIds: readonly string[];
}

/** Persisted state for each completed or in-flight Flow step. */
export interface FlowRunCheckpoint {
  readonly completedStepIds: readonly string[];
  readonly data?: DataContractValue;
  readonly failedStepIds: readonly string[];
  /** Redaction-safe node snapshots needed to plan downstream branch work after a restart. */
  readonly steps?: readonly FlowStepSnapshot[];
}

/** A durable outbox record separates at-least-once delivery from an idempotent application effect. */
export interface FlowOutboxRecord {
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly payload?: DataContractValue;
  readonly result?: FlowDurableEffectResult;
  readonly runId: string;
  readonly status: 'delivered' | 'pending';
  readonly workId: string;
}
