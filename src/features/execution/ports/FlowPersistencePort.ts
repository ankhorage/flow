import type {
  FlowDurableEffectResult,
  FlowDurableRun,
  FlowDurableWork,
  FlowOutboxRecord,
} from '../../../types/durableExecution.js';

export interface FlowPersistencePort {
  readonly cancelRunWorkAsync: (runId: string) => Promise<readonly string[]>;
  readonly claimDueWorkAsync: (input: {
    readonly leaseDurationMs: number;
    readonly limit: number;
    readonly now: Date;
    readonly workerId: string;
  }) => Promise<readonly FlowDurableWork[]>;
  readonly completeWorkAsync: (input: {
    readonly id: string;
    readonly leaseFencingToken: number;
    readonly now: Date;
    readonly workerId: string;
  }) => Promise<boolean>;
  /** Atomically finalize one fenced work lease with its run checkpoint and newly materialized work. */
  readonly finalizeWorkAsync: (input: {
    readonly expectedRevision: number;
    readonly nextWork: readonly FlowDurableWork[];
    readonly now: Date;
    readonly run: FlowDurableRun;
    readonly workId: string;
    readonly leaseFencingToken: number;
    readonly workerId: string;
  }) => Promise<boolean>;
  readonly createOutboxAsync: (record: FlowOutboxRecord) => Promise<void>;
  readonly createRunAsync: (run: FlowDurableRun) => Promise<void>;
  readonly enqueueWorkAsync: (work: FlowDurableWork) => Promise<void>;
  readonly markOutboxDeliveredAsync: (
    id: string,
    result?: FlowDurableEffectResult,
  ) => Promise<boolean>;
  readonly readOutboxAsync: (id: string) => Promise<FlowOutboxRecord | undefined>;
  readonly readRunAsync: (id: string) => Promise<FlowDurableRun | undefined>;
  readonly readWorkAsync: (id: string) => Promise<FlowDurableWork | undefined>;
  readonly recoverExpiredClaimsAsync: (now: Date) => Promise<readonly string[]>;
  readonly releaseWorkAsync: (input: {
    readonly dueAt: string;
    readonly id: string;
    readonly leaseFencingToken: number;
    readonly workerId: string;
  }) => Promise<boolean>;
  readonly transitionRunAsync: (input: {
    readonly expectedRevision: number;
    readonly run: FlowDurableRun;
  }) => Promise<boolean>;
  /** Verify that a worker still owns an unexpired fenced claim immediately before delivery. */
  readonly verifyClaimAsync: (input: {
    readonly leaseFencingToken: number;
    readonly now: Date;
    readonly workId: string;
    readonly workerId: string;
  }) => Promise<boolean>;
}
