import type { DataContractValue } from '@ankhorage/contracts/data';

export interface FlowDefinitionRef {
  readonly id: string;
  readonly version: number;
}

export interface FlowDurableRun {
  readonly checkpoint?: DataContractValue;
  readonly createdAt: string;
  readonly flow: FlowDefinitionRef;
  readonly id: string;
  readonly revision: number;
  readonly status: 'cancelled' | 'queued' | 'succeeded';
  readonly updatedAt: string;
}

export interface FlowDurableWork {
  readonly attempt: number;
  readonly dueAt: string;
  readonly flow: FlowDefinitionRef;
  readonly id: string;
  readonly lease?: { readonly expiresAt: string; readonly workerId: string };
  readonly runId: string;
  readonly status: 'claimed' | 'completed' | 'ready';
}

export interface FlowRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}
