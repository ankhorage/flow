import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  calculateRetryDueAt,
  createFlowSecurityPort,
  createDurableRunAsync,
  createRetryWork,
  isCronDueAt,
} from '../src/index.js';
import type {
  FlowDurableRun,
  FlowDurableWork,
  FlowPersistencePort,
  FlowSecurityOperation,
} from '../src/index.js';
import {
  cancelDurableRunAsync,
  FileFlowPersistenceAdapter,
  runDurableWorkerAsync,
} from '../src/execution.js';

const now = new Date('2026-11-14T12:00:00.000Z');
const flow = { id: 'published-flow', version: 4 };
const executionModuleUrl = new URL('../src/execution.ts', import.meta.url).href;

describe('durable execution state', () => {
  test('pins a durable run to an immutable revision and rejects stale transitions', async () => {
    const persistence = createFakePersistence();
    const run = await createDurableRunAsync(
      { flow, id: 'run-1' },
      { clock: { now: () => now }, persistence },
    );
    expect(run).toMatchObject({ flow, revision: 0, status: 'queued' });
    const transitioned: FlowDurableRun = {
      ...run,
      revision: 1,
      status: 'succeeded',
      updatedAt: now.toISOString(),
    };
    expect(await persistence.transitionRunAsync({ expectedRevision: 0, run: transitioned })).toBe(
      true,
    );
    expect(await persistence.transitionRunAsync({ expectedRevision: 0, run: transitioned })).toBe(
      false,
    );
    expect(
      await persistence.transitionRunAsync({
        expectedRevision: 1,
        run: { ...transitioned, flow: { id: 'other-flow', version: 1 }, revision: 2 },
      }),
    ).toBe(false);
  });

  test('calculates deterministic capped exponential retry work from persisted attempts', () => {
    const completed: FlowDurableWork = {
      attempt: 3,
      dueAt: now.toISOString(),
      effectKind: 'internal',
      flow,
      id: 'run-1:attempt:3',
      runId: 'run-1',
      status: 'completed',
    };
    expect(
      calculateRetryDueAt(now, 3, { baseDelayMs: 1_000, maxAttempts: 4, maxDelayMs: 3_000 }),
    ).toBe('2026-11-14T12:00:03.000Z');
    expect(
      createRetryWork(completed, now, { baseDelayMs: 1_000, maxAttempts: 4, maxDelayMs: 3_000 }),
    ).toEqual({
      attempt: 4,
      dueAt: '2026-11-14T12:00:03.000Z',
      effectKind: 'internal',
      flow,
      id: 'run-1:attempt:4',
      runId: 'run-1',
      status: 'ready',
    });
  });

  test('matches real IANA wall-clock instants across skipped and repeated DST times', () => {
    expect(
      isCronDueAt({
        cron: '30 2 * * *',
        now: new Date('2026-03-29T00:30:00.000Z'),
        timezone: 'Europe/Zurich',
      }),
    ).toBe(false);
    expect(
      isCronDueAt({
        cron: '30 2 * * *',
        now: new Date('2026-03-29T01:30:00.000Z'),
        timezone: 'Europe/Zurich',
      }),
    ).toBe(false);
    expect(
      isCronDueAt({
        cron: '30 2 * * *',
        now: new Date('2026-10-25T00:30:00.000Z'),
        timezone: 'Europe/Zurich',
      }),
    ).toBe(true);
    expect(
      isCronDueAt({
        cron: '30 2 * * *',
        now: new Date('2026-10-25T01:30:00.000Z'),
        timezone: 'Europe/Zurich',
      }),
    ).toBe(true);
  });

  test('recovers a crashed lease and prevents duplicate delivery after completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-durable-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const work: FlowDurableWork = {
      attempt: 1,
      dueAt: now.toISOString(),
      effectKind: 'internal',
      flow,
      id: 'run-1:attempt:1',
      runId: 'run-1',
      status: 'ready',
    };
    try {
      await persistence.enqueueWorkAsync(work);
      const claims = await Promise.all([
        persistence.claimDueWorkAsync({
          leaseDurationMs: 1_000,
          limit: 1,
          now,
          workerId: 'worker-a',
        }),
        persistence.claimDueWorkAsync({
          leaseDurationMs: 1_000,
          limit: 1,
          now,
          workerId: 'worker-b',
        }),
      ]);
      expect(claims.flat()).toEqual([
        expect.objectContaining({
          id: work.id,
          lease: expect.objectContaining({ fencingToken: 1, workerId: 'worker-a' }),
        }),
      ]);
      expect(
        await persistence.recoverExpiredClaimsAsync(new Date('2026-11-14T12:00:01.000Z')),
      ).toEqual([work.id]);
      const [reclaimed] = await persistence.claimDueWorkAsync({
        leaseDurationMs: 1_000,
        limit: 1,
        now: new Date('2026-11-14T12:00:01.000Z'),
        workerId: 'worker-b',
      });
      expect(reclaimed?.lease?.fencingToken).toBe(2);
      expect(
        await persistence.completeWorkAsync({
          id: work.id,
          leaseFencingToken: reclaimed!.lease!.fencingToken,
          now: new Date('2026-11-14T12:00:01.500Z'),
          workerId: 'worker-b',
        }),
      ).toBe(true);
      expect(
        await persistence.completeWorkAsync({
          id: work.id,
          leaseFencingToken: reclaimed!.lease!.fencingToken,
          now: new Date('2026-11-14T12:00:01.500Z'),
          workerId: 'worker-b',
        }),
      ).toBe(false);
      expect(
        await persistence.claimDueWorkAsync({
          leaseDurationMs: 1_000,
          limit: 1,
          now: new Date('2026-11-14T12:00:02.000Z'),
          workerId: 'worker-c',
        }),
      ).toHaveLength(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('serializes adapter instances across persisted writes and fences an expired reused-worker claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-durable-'));
    const path = join(directory, 'flow.json');
    const firstAdapter = FileFlowPersistenceAdapter(path);
    const reloadedAdapter = FileFlowPersistenceAdapter(path);
    const firstWork: FlowDurableWork = {
      attempt: 1,
      dueAt: now.toISOString(),
      effectKind: 'internal',
      flow,
      id: 'run-2:attempt:1',
      runId: 'run-2',
      status: 'ready',
    };
    const secondWork: FlowDurableWork = {
      ...firstWork,
      id: 'run-3:attempt:1',
      runId: 'run-3',
    };
    const fencedWork: FlowDurableWork = {
      ...firstWork,
      id: 'run-4:attempt:1',
      runId: 'run-4',
    };
    try {
      await Promise.all([
        firstAdapter.enqueueWorkAsync(firstWork),
        reloadedAdapter.enqueueWorkAsync(secondWork),
      ]);
      const concurrentWrites = await reloadedAdapter.claimDueWorkAsync({
        leaseDurationMs: 1_000,
        limit: 2,
        now,
        workerId: 'batch-worker',
      });
      expect(concurrentWrites.map((work) => work.id)).toEqual([firstWork.id, secondWork.id]);
      await Promise.all(
        concurrentWrites.map((work) =>
          reloadedAdapter.completeWorkAsync({
            id: work.id,
            leaseFencingToken: work.lease!.fencingToken,
            now: new Date('2026-11-14T12:00:00.500Z'),
            workerId: 'batch-worker',
          }),
        ),
      );
      await firstAdapter.enqueueWorkAsync(fencedWork);
      const [firstClaim, competingClaim] = await Promise.all([
        firstAdapter.claimDueWorkAsync({
          leaseDurationMs: 1_000,
          limit: 1,
          now: new Date('2026-11-14T12:00:01.000Z'),
          workerId: 'reused-worker',
        }),
        reloadedAdapter.claimDueWorkAsync({
          leaseDurationMs: 1_000,
          limit: 1,
          now: new Date('2026-11-14T12:00:01.000Z'),
          workerId: 'competing-worker',
        }),
      ]);
      expect([firstClaim, competingClaim].flat()).toHaveLength(1);
      const staleClaim = firstClaim[0]!;
      expect(
        await reloadedAdapter.completeWorkAsync({
          id: fencedWork.id,
          leaseFencingToken: staleClaim.lease!.fencingToken,
          now: new Date('2026-11-14T12:00:02.000Z'),
          workerId: 'reused-worker',
        }),
      ).toBe(false);
      expect(
        await reloadedAdapter.recoverExpiredClaimsAsync(new Date('2026-11-14T12:00:02.000Z')),
      ).toEqual([fencedWork.id]);
      const [reclaimed] = await reloadedAdapter.claimDueWorkAsync({
        leaseDurationMs: 1_000,
        limit: 1,
        now: new Date('2026-11-14T12:00:02.000Z'),
        workerId: 'reused-worker',
      });
      expect(reclaimed!.lease!.fencingToken).toBeGreaterThan(staleClaim.lease!.fencingToken);
      expect(
        await firstAdapter.completeWorkAsync({
          id: fencedWork.id,
          leaseFencingToken: staleClaim.lease!.fencingToken,
          now: new Date('2026-11-14T12:00:02.500Z'),
          workerId: 'reused-worker',
        }),
      ).toBe(false);
      expect(
        await reloadedAdapter.completeWorkAsync({
          id: fencedWork.id,
          leaseFencingToken: reclaimed!.lease!.fencingToken,
          now: new Date('2026-11-14T12:00:02.500Z'),
          workerId: 'reused-worker',
        }),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('fails closed when its persistence envelope is corrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-durable-'));
    const path = join(directory, 'flow.json');
    try {
      await writeFile(path, JSON.stringify({ runs: [], work: [] }));
      await expect(FileFlowPersistenceAdapter(path).readRunAsync('run-1')).rejects.toThrow(
        'FLOW_PERSISTENCE_INVALID',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('recovers a persisted lease after a sequential worker-process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-durable-'));
    const path = join(directory, 'flow.json');
    try {
      const firstLease = runWorkerProcess(path, now, 'first-worker', false);
      const recoveredLease = runWorkerProcess(
        path,
        new Date('2026-11-14T12:00:01.000Z'),
        'restarted-worker',
        true,
      );
      expect(recoveredLease.fencingToken).toBeGreaterThan(firstLease.fencingToken);
      expect(recoveredLease.workerId).toBe('restarted-worker');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('persists an outbox before a bounded worker effect and resumes retries without duplicating a completed step', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-worker-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const clock = { now: () => new Date('2026-11-14T12:00:00.000Z') };
    const calls: string[] = [];
    try {
      await createDurableRunAsync({ flow, id: 'worker-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync({
        attempt: 1,
        dueAt: clock.now().toISOString(),
        effectKind: 'internal',
        flow,
        id: 'worker-run:attempt:1',
        idempotencyKey: 'effect-1',
        runId: 'worker-run',
        status: 'ready',
        stepId: 'step-1',
      });
      const result = await runDurableWorkerAsync(
        {
          approvalPollIntervalMs: 1_000,
          concurrency: 1,
          leaseDurationMs: 1_000,
          limit: 10,
          retry: { baseDelayMs: 1_000, maxAttempts: 2, maxDelayMs: 1_000 },
          workerId: 'worker',
        },
        {
          clock,
          effects: { executeAsync: async ({ idempotencyKey }) => void calls.push(idempotencyKey) },
          persistence,
        },
      );
      expect(result.outcomes).toEqual([{ status: 'succeeded', workId: 'worker-run:attempt:1' }]);
      expect(calls).toEqual(['effect-1']);
      expect(await persistence.readOutboxAsync('worker-run:attempt:1')).toMatchObject({
        status: 'delivered',
      });
      expect((await persistence.readRunAsync('worker-run'))?.checkpoint).toMatchObject({
        completedStepIds: ['step-1'],
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('cancels queued durable work before a worker can deliver it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-cancel-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const clock = { now: () => now };
    try {
      await createDurableRunAsync({ flow, id: 'cancel-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync({
        attempt: 1,
        dueAt: now.toISOString(),
        effectKind: 'internal',
        flow,
        id: 'cancel-run:attempt:1',
        runId: 'cancel-run',
        status: 'ready',
      });
      expect(await cancelDurableRunAsync('cancel-run', { clock, persistence })).toBe(true);
      const result = await runDurableWorkerAsync(
        {
          approvalPollIntervalMs: 1_000,
          concurrency: 1,
          leaseDurationMs: 1_000,
          limit: 1,
          retry: { baseDelayMs: 1_000, maxAttempts: 1, maxDelayMs: 1_000 },
          workerId: 'worker',
        },
        {
          clock,
          effects: {
            executeAsync: async () => {
              throw new Error('must not execute');
            },
          },
          persistence,
        },
      );
      expect(result.claimedWorkIds).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('exhausts retries through worker ticks and records one terminal compensation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-retry-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const clock = controlledClock(now);
    const calls: string[] = [];
    const compensated: string[] = [];
    try {
      await createDurableRunAsync({ flow, id: 'retry-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync(workOf('retry-run', 'retry-run:attempt:1', clock.now()));
      for (const time of [
        now,
        new Date('2026-11-14T12:00:01.000Z'),
        new Date('2026-11-14T12:00:03.000Z'),
      ]) {
        clock.set(time);
        await runWorkerAsync('retry-worker', clock, persistence, {
          compensateAsync: async ({ work }) => void compensated.push(work.id),
          executeAsync: async ({ work }) => {
            calls.push(work.id);
            throw new Error('provider unavailable');
          },
        });
      }
      expect(calls).toEqual(['retry-run:attempt:1', 'retry-run:attempt:2', 'retry-run:attempt:3']);
      expect(compensated).toEqual(['retry-run:attempt:3']);
      expect(await persistence.readRunAsync('retry-run')).toMatchObject({
        checkpoint: { failedStepIds: ['step-1'] },
        status: 'failed',
      });
      expect(
        (await runWorkerAsync('retry-worker', clock, persistence, failingEffects())).claimedWorkIds,
      ).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('deduplicates concurrent callback deliveries with one fenced claim and one provider key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-duplicate-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const clock = controlledClock(now);
    const providerKeys: string[] = [];
    try {
      await createDurableRunAsync({ flow, id: 'duplicate-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync(workOf('duplicate-run', 'duplicate-run:attempt:1', now));
      const results = await Promise.all([
        runWorkerAsync('callback-a', clock, persistence, {
          executeAsync: async ({ idempotencyKey }) => void providerKeys.push(idempotencyKey),
        }),
        runWorkerAsync('callback-b', clock, persistence, {
          executeAsync: async ({ idempotencyKey }) => void providerKeys.push(idempotencyKey),
        }),
      ]);
      expect(results.flatMap((result) => result.claimedWorkIds)).toEqual([
        'duplicate-run:attempt:1',
      ]);
      expect(providerKeys).toEqual(['duplicate-run:attempt:1']);
      expect(
        (await persistence.readRunAsync('duplicate-run'))?.checkpoint?.completedStepIds,
      ).toEqual(['step-1']);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('recovers an actually terminated protected worker by reconciling the provider idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-abort-'));
    const path = join(directory, 'flow.json');
    const providerLog = join(directory, 'provider.log');
    const clock = controlledClock(now);
    const operation = protectedOperation('abort-key');
    try {
      const persistence = FileFlowPersistenceAdapter(path);
      await createDurableRunAsync({ flow, id: 'abort-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync(protectedWorkOf('abort-run', operation, now));
      const child = Bun.spawnSync([
        process.execPath,
        '--eval',
        terminatedWorkerScript(path, providerLog, now, operation),
      ]);
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(await readFile(providerLog, 'utf8')).toBe('abort-key\n');
      clock.set(new Date('2026-11-14T12:00:01.000Z'));
      const resumed = await runWorkerAsync(
        'restart-worker',
        clock,
        FileFlowPersistenceAdapter(path),
        {
          executeAsync: async () => {
            throw new Error('provider must reconcile instead of redelivering');
          },
          reconcileAsync: async ({ idempotencyKey }) =>
            (await readFile(providerLog, 'utf8')).includes(`${idempotencyKey}\n`)
              ? 'delivered'
              : 'unknown',
        },
        createWorkerSecurity({ status: 'approved' }),
      );
      expect(resumed).toMatchObject({
        outcomes: [{ status: 'succeeded', workId: 'abort-run:attempt:1' }],
        recoveredWorkIds: ['abort-run:attempt:1'],
      });
      expect(await persistence.readOutboxAsync('abort-run:attempt:1')).toMatchObject({
        idempotencyKey: 'abort-key',
        status: 'delivered',
      });
      expect((await persistence.readRunAsync('abort-run'))?.checkpoint?.completedStepIds).toEqual([
        'step-1',
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('persists a long-lived approval wait and resumes only after canonical approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-approval-'));
    const path = join(directory, 'flow.json');
    const clock = controlledClock(now);
    const approval = { status: 'pending' as 'approved' | 'pending' | 'rejected' | undefined };
    const operation = protectedOperation('approval-key');
    const effects: string[] = [];
    try {
      const persistence = FileFlowPersistenceAdapter(path);
      await createDurableRunAsync({ flow, id: 'approval-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync(protectedWorkOf('approval-run', operation, clock.now()));
      expect(
        (
          await runWorkerAsync(
            'approval-a',
            clock,
            persistence,
            {
              executeAsync: async ({ idempotencyKey }) => void effects.push(idempotencyKey),
              reconcileAsync: async () => 'unknown',
            },
            createWorkerSecurity(approval),
          )
        ).outcomes,
      ).toEqual([{ status: 'waiting_approval', workId: 'approval-run:attempt:1' }]);
      expect(effects).toEqual([]);
      expect((await persistence.readRunAsync('approval-run'))?.status).toBe('waiting_approval');
      clock.set(new Date('2026-11-17T12:00:01.000Z'));
      approval.status = 'approved';
      const restarted = FileFlowPersistenceAdapter(path);
      expect(
        (
          await runWorkerAsync(
            'approval-b',
            clock,
            restarted,
            {
              executeAsync: async ({ idempotencyKey }) => void effects.push(idempotencyKey),
              reconcileAsync: async () => 'unknown',
            },
            createWorkerSecurity(approval),
          )
        ).outcomes,
      ).toEqual([{ status: 'succeeded', workId: 'approval-run:attempt:1' }]);
      expect(effects).toEqual(['approval-key']);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('fails closed for missing protected authorization and expired approvals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-security-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const clock = controlledClock(now);
    try {
      await createDurableRunAsync({ flow, id: 'security-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync(
        protectedWorkOf('security-run', protectedOperation('expired'), now),
      );
      const missingSecurity = await runWorkerAsync(
        'missing-security',
        clock,
        persistence,
        {
          executeAsync: async () => {
            throw new Error('must not execute');
          },
          reconcileAsync: async () => 'unknown',
        },
        undefined,
        1,
      );
      expect(missingSecurity.outcomes).toMatchObject([
        { error: 'FLOW_SECURITY_PORT_REQUIRED', status: 'failed' },
      ]);
      await createDurableRunAsync({ flow, id: 'expired-run' }, { clock, persistence });
      await persistence.enqueueWorkAsync(
        protectedWorkOf('expired-run', protectedOperation('expired-approval'), now),
      );
      const result = await runWorkerAsync(
        'security-worker',
        clock,
        persistence,
        {
          executeAsync: async () => {
            throw new Error('must not execute');
          },
          reconcileAsync: async () => 'unknown',
        },
        createWorkerSecurity({ status: undefined }),
        1,
      );
      expect(result.outcomes).toMatchObject([
        { error: 'The Flow approval gate rejected this operation.', status: 'failed' },
      ]);
      expect((await persistence.readRunAsync('security-run'))?.status).toBe('failed');
      expect((await persistence.readRunAsync('expired-run'))?.status).toBe('failed');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

/** Create a mutable deterministic clock for persisted worker ticks. */
const controlledClock = (initial: Date) => {
  let current = initial;
  return {
    now: () => current,
    set: (next: Date) => {
      current = next;
    },
  };
};

/** Build one internal durable delivery with a stable step identity. */
const workOf = (runId: string, id: string, dueAt: Date): FlowDurableWork => ({
  attempt: Number(id.split(':').at(-1)),
  dueAt: dueAt.toISOString(),
  effectKind: 'internal',
  flow,
  id,
  runId,
  status: 'ready',
  stepId: 'step-1',
});

/** Build one protected provider delivery that carries the exact authorization idempotency identity. */
const protectedWorkOf = (
  runId: string,
  securityOperation: FlowSecurityOperation,
  dueAt: Date,
): FlowDurableWork => ({
  attempt: 1,
  dueAt: dueAt.toISOString(),
  effectKind: 'protected',
  flow,
  id: `${runId}:attempt:1`,
  idempotencyKey: securityOperation.idempotencyKey,
  runId,
  securityOperation,
  status: 'ready',
  stepId: 'step-1',
});

/** Create the canonical security operation used by protected worker fixtures. */
const protectedOperation = (idempotencyKey: string): FlowSecurityOperation => ({
  actor: { environment: 'test', id: 'operator', projectId: 'project', tenantId: 'tenant' },
  capability: 'provider:write',
  idempotencyKey,
  operationId: idempotencyKey,
});

/** Create the released Flow security port with controlled durable approval state. */
const createWorkerSecurity = (approval: {
  readonly status: 'approved' | 'pending' | 'rejected' | undefined;
}) => {
  const claimed = new Set<string>();
  const consumed = new Set<string>();
  return createFlowSecurityPort({
    approvalStore: {
      getAsync: async (operation) =>
        approval.status === undefined ? undefined : { operation, status: approval.status },
    },
    audit: { writeAsync: async () => undefined },
    grants: [
      {
        actorId: 'operator',
        capability: 'provider:write',
        environment: 'test',
        projectId: 'project',
        tenantId: 'tenant',
      },
    ],
    operationStore: {
      claimAsync: async (operation) => {
        if (claimed.has(operation.idempotencyKey)) return false;
        claimed.add(operation.idempotencyKey);
        return true;
      },
      consumeAsync: async (operation) => {
        if (!claimed.has(operation.idempotencyKey) || consumed.has(operation.idempotencyKey))
          return false;
        consumed.add(operation.idempotencyKey);
        return true;
      },
      releaseAsync: async (operation) => {
        if (!consumed.has(operation.idempotencyKey)) claimed.delete(operation.idempotencyKey);
      },
    },
    rateLimit: { acquireAsync: async () => true },
    secretStore: {
      create: async () => ({
        error: { code: 'unavailable', message: 'unused' },
        ok: false as const,
      }),
      getMetadata: async () => ({
        error: { code: 'not_found', message: 'unused' },
        ok: false as const,
      }),
      list: async () => ({ data: [], ok: true as const }),
      remove: async () => ({ ok: true as const }),
      replace: async () => ({
        error: { code: 'unavailable', message: 'unused' },
        ok: false as const,
      }),
      resolve: async () => ({ data: {}, ok: true as const }),
    },
  });
};

/** Run one bounded worker tick with the same production worker boundary used by every fixture. */
const runWorkerAsync = (
  workerId: string,
  clock: { readonly now: () => Date },
  persistence: FlowPersistencePort,
  effects: Parameters<typeof runDurableWorkerAsync>[1]['effects'],
  security?: ReturnType<typeof createWorkerSecurity>,
  maxAttempts = 3,
) =>
  runDurableWorkerAsync(
    {
      approvalPollIntervalMs: 1_000,
      concurrency: 1,
      leaseDurationMs: 1_000,
      limit: 1,
      retry: { baseDelayMs: 1_000, maxAttempts, maxDelayMs: 2_000 },
      workerId,
    },
    { clock, effects, persistence, ...(security === undefined ? {} : { security }) },
  );

/** Make an accidental worker delivery fail visibly in a fixture. */
const failingEffects = (): Parameters<typeof runDurableWorkerAsync>[1]['effects'] => ({
  executeAsync: async () => {
    throw new Error('unexpected delivery');
  },
});

/** Start a real worker process whose provider adapter persists one effect then terminates before its commit. */
const terminatedWorkerScript = (
  persistencePath: string,
  providerLog: string,
  current: Date,
  operation: FlowSecurityOperation,
): string =>
  [
    "import { appendFile } from 'node:fs/promises';",
    `import { FileFlowPersistenceAdapter, runDurableWorkerAsync } from ${JSON.stringify(executionModuleUrl)};`,
    `import { createFlowSecurityPort } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};`,
    `const operation = ${JSON.stringify(operation)};`,
    'const claimed = new Set();',
    'const consumed = new Set();',
    'const security = createFlowSecurityPort({',
    "approvalStore: { getAsync: async (identity) => ({ operation: identity, status: 'approved' }) },",
    'audit: { writeAsync: async () => undefined },',
    "grants: [{ actorId: 'operator', capability: 'provider:write', environment: 'test', projectId: 'project', tenantId: 'tenant' }],",
    'operationStore: { claimAsync: async (identity) => { if (claimed.has(identity.idempotencyKey)) return false; claimed.add(identity.idempotencyKey); return true; }, consumeAsync: async (identity) => { if (consumed.has(identity.idempotencyKey)) return false; consumed.add(identity.idempotencyKey); return true; }, releaseAsync: async () => undefined },',
    'rateLimit: { acquireAsync: async () => true },',
    'secretStore: { create: async () => ({ ok: false }), getMetadata: async () => ({ ok: false }), list: async () => ({ ok: true, data: [] }), remove: async () => ({ ok: true }), replace: async () => ({ ok: false }), resolve: async () => ({ ok: true, data: {} }) },',
    '});',
    `await runDurableWorkerAsync({ approvalPollIntervalMs: 1000, concurrency: 1, leaseDurationMs: 1000, limit: 1, retry: { baseDelayMs: 1000, maxAttempts: 3, maxDelayMs: 2000 }, workerId: 'terminated-worker' }, {`,
    `clock: { now: () => new Date(${JSON.stringify(current.toISOString())}) },`,
    "effects: { reconcileAsync: async () => 'unknown', executeAsync: async ({ idempotencyKey }) => { await appendFile(" +
      JSON.stringify(providerLog) +
      ', `${idempotencyKey}\\n`); process.exit(0); } },',
    `persistence: FileFlowPersistenceAdapter(${JSON.stringify(persistencePath)}), security });`,
  ].join('\n');

/*** Run one deterministic file-adapter claim in an isolated worker process. */
const runWorkerProcess = (
  path: string,
  claimTime: Date,
  workerId: string,
  recover: boolean,
): { readonly fencingToken: number; readonly workerId: string } => {
  const script = [
    `import { FileFlowPersistenceAdapter } from ${JSON.stringify(executionModuleUrl)};`,
    `const adapter = FileFlowPersistenceAdapter(${JSON.stringify(path)});`,
    `const now = new Date(${JSON.stringify(claimTime.toISOString())});`,
    recover ? 'await adapter.recoverExpiredClaimsAsync(now);' : '',
    recover
      ? ''
      : `await adapter.enqueueWorkAsync(${JSON.stringify({
          attempt: 1,
          dueAt: now.toISOString(),
          flow,
          id: 'restart:attempt:1',
          runId: 'restart',
          status: 'ready',
        })});`,
    `const [claimed] = await adapter.claimDueWorkAsync({ leaseDurationMs: 1000, limit: 1, now, workerId: ${JSON.stringify(workerId)} });`,
    "if (claimed === undefined || claimed.lease === undefined) throw new Error('FLOW_TEST_CLAIM_MISSING');",
    'console.log(JSON.stringify(claimed.lease));',
  ].join('\n');
  const result = Bun.spawnSync([process.execPath, '--eval', script]);
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
  return JSON.parse(result.stdout.toString()) as {
    readonly fencingToken: number;
    readonly workerId: string;
  };
};

/*** Provide an in-memory test double that preserves the persistence port's revision invariant. */
const createFakePersistence = (): FlowPersistencePort => {
  const runs = new Map<string, FlowDurableRun>();
  return {
    cancelRunWorkAsync: () => Promise.resolve([]),
    claimDueWorkAsync: () => Promise.resolve([]),
    completeWorkAsync: () => Promise.resolve(false),
    createOutboxAsync: () => Promise.resolve(),
    createRunAsync: (run) => {
      if (runs.has(run.id)) return Promise.reject(new Error(`FLOW_RUN_EXISTS:${run.id}`));
      runs.set(run.id, structuredClone(run));
      return Promise.resolve();
    },
    enqueueWorkAsync: () => Promise.resolve(),
    markOutboxDeliveredAsync: () => Promise.resolve(false),
    readOutboxAsync: () => Promise.resolve(undefined),
    readRunAsync: (id) => Promise.resolve(structuredClone(runs.get(id))),
    recoverExpiredClaimsAsync: () => Promise.resolve([]),
    releaseWorkAsync: () => Promise.resolve(false),
    transitionRunAsync: ({ expectedRevision, run }) => {
      const current = runs.get(run.id);
      if (
        !current ||
        current.revision !== expectedRevision ||
        current.flow.id !== run.flow.id ||
        current.flow.version !== run.flow.version
      )
        return Promise.resolve(false);
      runs.set(run.id, structuredClone(run));
      return Promise.resolve(true);
    },
  };
};
