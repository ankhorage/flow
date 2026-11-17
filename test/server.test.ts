import { expect, test } from 'bun:test';

import {
  InMemoryFlowPersistenceAdapter,
  InMemoryFlowRuntimeStore,
  createDefaultNodeRegistry,
  createFlowRuntime,
} from '../src/index.js';
import { startFlowApiServerAsync, startFlowWorkerAsync } from '../src/server.js';

test('starts and stops isolated local API and worker boundaries using one host-owned runtime', async () => {
  const runtime = createFlowRuntime({
    nodeRegistry: createDefaultNodeRegistry(),
    persistence: InMemoryFlowPersistenceAdapter(),
    store: InMemoryFlowRuntimeStore(),
  });
  const api = startFlowApiServerAsync({ localDemo: true, port: 0, runtime });
  const worker = startFlowWorkerAsync({ runtime, workerIntervalMs: 5 });

  try {
    const response = await fetch(`http://127.0.0.1:${api.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    await worker.stop();
    await api.stop();
  }
});

test('refuses to start an uncomposed worker', () => {
  expect(() => startFlowWorkerAsync()).toThrow('FLOW_PERSISTENCE_PATH_REQUIRED');
});

test('serializes worker ticks, retains failures, fences shutdown, and restarts cleanly', async () => {
  let calls = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  let releaseTick: (() => void) | undefined;
  const base = createFlowRuntime({
    nodeRegistry: createDefaultNodeRegistry(),
    persistence: InMemoryFlowPersistenceAdapter(),
    store: InMemoryFlowRuntimeStore(),
  });
  const runtime = {
    ...base,
    runWorkerTickAsync: async () => {
      calls += 1;
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
      concurrent -= 1;
      if (calls === 1) throw new Error('expected tick failure');
      return [];
    },
  };
  const errors: unknown[] = [];
  const worker = startFlowWorkerAsync({
    onError: (error) => errors.push(error),
    runtime,
    workerIntervalMs: 1,
  });

  await Bun.sleep(5);
  expect(calls).toBe(1);
  expect(maximumConcurrent).toBe(1);
  const stopping = worker.stop();
  releaseTick?.();
  await stopping;
  await Bun.sleep(5);
  expect(calls).toBe(1);
  expect(errors).toHaveLength(1);

  const restarted = startFlowWorkerAsync({ runtime, workerIntervalMs: 1 });
  await Bun.sleep(5);
  expect(calls).toBe(2);
  const restartStopping = restarted.stop();
  releaseTick?.();
  await restartStopping;
  expect(maximumConcurrent).toBe(1);
});

test('redacts worker and shutdown errors before process stderr', () => {
  const fixture = new URL('./fixtures/processLogRedaction.ts', import.meta.url).pathname;
  const worker = Bun.spawnSync([process.execPath, fixture, 'worker']);
  const shutdown = Bun.spawnSync([process.execPath, fixture, 'shutdown']);

  const workerOutput = `${worker.stdout.toString()}${worker.stderr.toString()}`;
  const shutdownOutput = `${shutdown.stdout.toString()}${shutdown.stderr.toString()}`;
  expect(worker.exitCode, workerOutput).toBe(0);
  expect(shutdown.exitCode, shutdownOutput).toBe(1);
  expect(`${workerOutput}${shutdownOutput}`).not.toContain('SENTINEL_SECRET');
  expect(workerOutput).toContain('FLOW_WORKER_TICK_FAILED');
  expect(shutdownOutput).toContain('FLOW_PROCESS_STOP_FAILED');
});
