import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { calculateRetryDueAt, createDurableRunAsync, createRetryWork } from '../src/index.js';
import type { FlowDurableRun, FlowDurableWork, FlowPersistencePort } from '../src/index.js';
import { FileFlowPersistenceAdapter } from '../src/execution.js';

const now = new Date('2026-11-14T12:00:00.000Z');
const flow = { id: 'published-flow', version: 4 };

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
      flow,
      id: 'run-1:attempt:3',
      runId: 'run-1',
      status: 'completed',
    };
    expect(calculateRetryDueAt(now, 3, { baseDelayMs: 1_000, maxDelayMs: 3_000 })).toBe(
      '2026-11-14T12:00:03.000Z',
    );
    expect(createRetryWork(completed, now, { baseDelayMs: 1_000, maxDelayMs: 3_000 })).toEqual({
      attempt: 4,
      dueAt: '2026-11-14T12:00:03.000Z',
      flow,
      id: 'run-1:attempt:4',
      runId: 'run-1',
      status: 'ready',
    });
  });

  test('recovers a crashed lease and prevents duplicate delivery after completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-durable-'));
    const persistence = FileFlowPersistenceAdapter(join(directory, 'flow.json'));
    const work: FlowDurableWork = {
      attempt: 1,
      dueAt: now.toISOString(),
      flow,
      id: 'run-1:attempt:1',
      runId: 'run-1',
      status: 'ready',
    };
    try {
      await persistence.enqueueWorkAsync(work);
      expect(
        await Promise.all([
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
        ]),
      ).toEqual([
        [
          expect.objectContaining({
            id: work.id,
            lease: expect.objectContaining({ workerId: 'worker-a' }),
          }),
        ],
        [],
      ]);
      expect(
        await persistence.recoverExpiredClaimsAsync(new Date('2026-11-14T12:00:01.000Z')),
      ).toEqual([work.id]);
      expect(
        await persistence.claimDueWorkAsync({
          leaseDurationMs: 1_000,
          limit: 1,
          now: new Date('2026-11-14T12:00:01.000Z'),
          workerId: 'worker-b',
        }),
      ).toHaveLength(1);
      expect(await persistence.completeWorkAsync({ id: work.id, workerId: 'worker-b' })).toBe(true);
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
});

/*** Provide an in-memory test double that preserves the persistence port's revision invariant. */
const createFakePersistence = (): FlowPersistencePort => {
  const runs = new Map<string, FlowDurableRun>();
  return {
    claimDueWorkAsync: () => Promise.resolve([]),
    completeWorkAsync: () => Promise.resolve(false),
    createRunAsync: (run) => {
      if (runs.has(run.id)) return Promise.reject(new Error(`FLOW_RUN_EXISTS:${run.id}`));
      runs.set(run.id, structuredClone(run));
      return Promise.resolve();
    },
    enqueueWorkAsync: () => Promise.resolve(),
    readRunAsync: (id) => Promise.resolve(structuredClone(runs.get(id))),
    recoverExpiredClaimsAsync: () => Promise.resolve([]),
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
