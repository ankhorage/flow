import type { FlowDurableRun, FlowDurableWork } from '../../../types/durableExecution.js';

export interface FlowPersistencePort {
  readonly claimDueWorkAsync: (input: {
    readonly leaseDurationMs: number;
    readonly limit: number;
    readonly now: Date;
    readonly workerId: string;
  }) => Promise<readonly FlowDurableWork[]>;
  readonly completeWorkAsync: (input: {
    readonly id: string;
    readonly workerId: string;
  }) => Promise<boolean>;
  readonly createRunAsync: (run: FlowDurableRun) => Promise<void>;
  readonly enqueueWorkAsync: (work: FlowDurableWork) => Promise<void>;
  readonly readRunAsync: (id: string) => Promise<FlowDurableRun | undefined>;
  readonly recoverExpiredClaimsAsync: (now: Date) => Promise<readonly string[]>;
  readonly transitionRunAsync: (input: {
    readonly expectedRevision: number;
    readonly run: FlowDurableRun;
  }) => Promise<boolean>;
}
