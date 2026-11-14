import type { DataContractValue } from '@ankhorage/contracts/data';

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
  readonly lease?: {
    readonly expiresAt: string;
    readonly fencingToken: number;
    readonly workerId: string;
  };
  readonly runId: string;
  readonly securityOperation?: FlowSecurityOperation;
  readonly stepId?: string;
  readonly status: 'cancelled' | 'claimed' | 'completed' | 'ready';
}

export interface FlowRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
}

/** Persisted state for each completed or in-flight Flow step. */
export interface FlowRunCheckpoint {
  readonly completedStepIds: readonly string[];
  readonly data?: DataContractValue;
  readonly failedStepIds: readonly string[];
}

/** A durable outbox record separates at-least-once delivery from an idempotent application effect. */
export interface FlowOutboxRecord {
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly payload?: DataContractValue;
  readonly runId: string;
  readonly status: 'delivered' | 'pending';
  readonly workId: string;
}
