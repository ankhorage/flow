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
