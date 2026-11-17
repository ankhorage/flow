import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const auth = { authorization: 'Bearer test-token' };

test('runs API and worker as separate processes through one durable runtime, shutdown, restart, recovery, and health', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'flow-cli-process-'));
  const port = availablePort();
  const environment = {
    ...process.env,
    FLOW_API_TOKEN: 'test-token',
    FLOW_RUNTIME_MODULE: new URL('./fixtures/fileRuntimeModule.ts', import.meta.url).pathname,
    FLOW_TEST_STATE_DIRECTORY: stateDirectory,
  };
  const api = Bun.spawn([process.execPath, 'src/cli/standalone.ts', 'api', '--port', `${port}`], {
    cwd: process.cwd(),
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });

  try {
    await waitForAsync(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);
    await createAndPublishAsync(port);

    const firstRun = await triggerAsync(port, 'first');
    const firstWorker = startWorker(environment);
    await waitForRunAsync(port, firstRun);
    await stopAsync(firstWorker);

    const recoveredRun = await triggerAsync(port, 'recovered-after-stop');
    const health = Bun.spawnSync([process.execPath, 'src/cli/standalone.ts', 'worker', 'health'], {
      cwd: process.cwd(),
      env: environment,
    });
    expect(health.exitCode, health.stderr.toString()).toBe(0);
    expect(health.stdout.toString()).toContain('Flow worker runtime ready');

    const restartedWorker = startWorker(environment);
    await waitForRunAsync(port, recoveredRun);
    await stopAsync(restartedWorker);
  } finally {
    await stopAsync(api);
    await rm(stateDirectory, { force: true, recursive: true });
  }
}, 30_000);

/** Reserve a currently available local port for the short-lived API test process. */
const availablePort = (): number => {
  const probe = Bun.serve({ fetch: () => new Response(), port: 0 });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) throw new Error('FLOW_TEST_PORT_UNAVAILABLE');
  return port;
};

/** Start one CLI worker process against the fixture-owned durable runtime. */
const startWorker = (environment: Record<string, string | undefined>): Bun.Subprocess =>
  Bun.spawn([process.execPath, 'src/cli/standalone.ts', 'worker'], {
    cwd: process.cwd(),
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });

/** Create and publish one empty workflow through the independently running API process. */
const createAndPublishAsync = async (port: number): Promise<void> => {
  const definition = {
    edges: [],
    id: 'process-flow',
    nodes: [],
    title: 'Process Flow',
    triggers: [{ id: 'manual', kind: 'manual' }],
    version: 1,
  };
  const created = await fetch(`http://127.0.0.1:${port}/v1/workflows`, {
    body: JSON.stringify(definition),
    headers: auth,
    method: 'POST',
  });
  expect(created.status).toBe(201);
  const published = await fetch(`http://127.0.0.1:${port}/v1/workflows/process-flow/1/publish`, {
    headers: auth,
    method: 'POST',
  });
  expect(published.status).toBe(200);
};

/** Queue one API-authenticated manual run for an independent worker process to recover and execute. */
const triggerAsync = async (port: number, idempotencyKey: string): Promise<string> => {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/workflows/process-flow/triggers/manual`,
    {
      body: JSON.stringify({ idempotencyKey }),
      headers: auth,
      method: 'POST',
    },
  );
  expect(response.status).toBe(202);
  return ((await response.json()) as { readonly id: string }).id;
};

/** Verify that API process observes the durable completion made by a separate worker process. */
const waitForRunAsync = (port: number, runId: string): Promise<void> =>
  waitForAsync(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/runs/${runId}`, { headers: auth });
    if (!response.ok) return false;
    return ((await response.json()) as { readonly status: string }).status === 'succeeded';
  });

/** Poll a process boundary until the expected lifecycle observation becomes available. */
const waitForAsync = async (conditionAsync: () => Promise<boolean>): Promise<void> => {
  for (const _attempt of Array.from({ length: 100 })) {
    if (await conditionAsync().catch(() => false)) return;
    await Bun.sleep(25);
  }
  throw new Error('FLOW_TEST_TIMEOUT');
};

/** Request graceful shutdown and require a clean process exit. */
const stopAsync = async (process: Bun.Subprocess): Promise<void> => {
  if (process.exitCode === null) process.kill('SIGTERM');
  const exitCode = await process.exited;
  expect(exitCode).toBe(0);
};
