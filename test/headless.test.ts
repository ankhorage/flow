import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FlowDefinition } from '@ankhorage/contracts/flow';
import { describe, expect, it } from 'bun:test';

import {
  FileFlowPersistenceAdapter,
  FileFlowRuntimeStore,
  InMemoryFlowObservability,
  InMemoryFlowPersistenceAdapter,
  InMemoryFlowRuntimeStore,
  createDefaultNodeRegistry,
  createFlowRuntime,
} from '../src/index.js';
import { createFlowHttpHandler } from '../src/features/headless/adapters/createFlowHttpHandler.js';

const definition: FlowDefinition = {
  edges: [],
  id: 'demo',
  nodes: [],
  title: 'Demo',
  triggers: [
    { id: 'manual', kind: 'manual' },
    { id: 'hook', kind: 'webhook', path: '/demo' },
  ],
  version: 1,
};
const scope = { projectId: 'project', tenantId: 'tenant' };

/*** Exercise version pinning, idempotent webhook delivery, worker independence, and redacted HTTP state. */
describe('headless Flow runtime', () => {
  it('publishes immutable revisions and executes one idempotent webhook run after the client returns', async () => {
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, 'demo', 1);
    const first = await runtime.triggerAsync({
      flowId: 'demo',
      idempotencyKey: 'same-request',
      scope,
      triggerId: 'hook',
    });
    const duplicate = await runtime.triggerAsync({
      flowId: 'demo',
      idempotencyKey: 'same-request',
      scope,
      triggerId: 'hook',
    });
    expect(duplicate.id).toBe(first.id);
    expect(await runtime.runWorkerTickAsync()).toEqual([first.id]);
    expect((await runtime.getRunAsync(scope, first.id))?.status).toBe('succeeded');
    expect((await runtime.readEventsAsync(scope, 0, first.id)).map((event) => event.type)).toEqual([
      'run_queued',
      'run_started',
      'run_completed',
    ]);
  });

  it('enforces HTTP auth, stable rate-limit errors, and redacted run data', async () => {
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    const handler = createFlowHttpHandler({
      access: { acquireAsync: async () => true, authorizeAsync: async () => true },
      authenticator: {
        authenticateAsync: async (request) =>
          request.headers.get('authorization') === 'Bearer test'
            ? { environment: 'test', id: 'actor', projectId: 'project', tenantId: 'tenant' }
            : undefined,
      },
      runtime,
    });
    expect(
      (
        await handler(
          new Request('http://flow/v1/workflows', {
            body: JSON.stringify(definition),
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request('http://flow/v1/workflows', {
            body: JSON.stringify(definition),
            headers: { authorization: 'Bearer test' },
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await handler(
          new Request('http://flow/v1/workflows/demo/1/publish', {
            headers: { authorization: 'Bearer test' },
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(200);
    const triggered = await handler(
      new Request('http://flow/v1/webhooks/demo/hook', {
        body: JSON.stringify({ idempotencyKey: 'http-hook' }),
        headers: { authorization: 'Bearer test' },
        method: 'POST',
      }),
    );
    expect(triggered.status).toBe(202);
    const run = (await triggered.json()) as { readonly id: string };
    await runtime.runWorkerTickAsync();
    const response = await handler(
      new Request(`http://flow/v1/runs/${run.id}`, { headers: { authorization: 'Bearer test' } }),
    );
    expect(
      ((await response.json()) as { readonly input?: unknown; readonly status: string }).input,
    ).toBeUndefined();
    const openApi = await handler(new Request('http://flow/openapi.json'));
    expect(
      Object.keys(((await openApi.json()) as { readonly paths: Record<string, unknown> }).paths),
    ).toContain('/v1/workflows/{flowId}/triggers/{triggerId}');
  });

  it('recovers published workflow and queued run state from the standalone file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-runtime-'));
    const path = join(directory, 'runtime.json');
    try {
      const first = createFlowRuntime({
        nodeRegistry: createDefaultNodeRegistry(),
        persistence: FileFlowPersistenceAdapter(`${path}.durable`),
        store: FileFlowRuntimeStore(path),
      });
      await first.createDraftAsync(scope, definition);
      await first.publishAsync(scope, 'demo', 1);
      const queued = await first.triggerAsync({
        flowId: 'demo',
        idempotencyKey: 'persistent',
        scope,
        triggerId: 'manual',
      });
      const second = createFlowRuntime({
        nodeRegistry: createDefaultNodeRegistry(),
        persistence: FileFlowPersistenceAdapter(`${path}.durable`),
        store: FileFlowRuntimeStore(path),
      });
      expect((await second.getRunAsync(scope, queued.id))?.status).toBe('pending');
      expect(await second.runWorkerTickAsync()).toEqual([queued.id]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('retains bounded, redaction-safe execution audit and metric observations', async () => {
    const observability = InMemoryFlowObservability(1);
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      observability,
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, 'demo', 1);
    const run = await runtime.triggerAsync({
      flowId: 'demo',
      idempotencyKey: 'observed',
      scope,
      triggerId: 'manual',
    });
    await runtime.runWorkerTickAsync();
    const snapshot = await observability.snapshotAsync();
    expect(snapshot.audit).toEqual([
      expect.objectContaining({ action: 'run_succeeded', category: 'execution', runId: run.id }),
    ]);
    expect(snapshot.metrics.run_triggered).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('observed');
  });

  it('pins triggers to the newest published revision and denies another tenant every run surface', async () => {
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    const otherScope = { projectId: 'other-project', tenantId: 'other-tenant' };
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, 'demo', 1);
    await runtime.createDraftAsync(scope, { ...definition, title: 'Unpublished v2', version: 2 });
    const run = await runtime.triggerAsync({
      flowId: 'demo',
      idempotencyKey: 'published-before-draft',
      scope,
      triggerId: 'manual',
    });
    expect(run.flow.version).toBe(1);
    expect(await runtime.getRunAsync(otherScope, run.id)).toBeUndefined();
    expect(await runtime.cancelRunAsync(otherScope, run.id)).toBeUndefined();
    expect(await runtime.retryRunAsync(otherScope, run.id)).toBeUndefined();
    expect(await runtime.readEventsAsync(otherScope, 0, run.id)).toEqual([]);
    expect(await runtime.getWorkflowAsync(otherScope, 'demo', 1)).toBeUndefined();
  });
});
