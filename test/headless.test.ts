import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DataContractValue } from '@ankhorage/contracts/data';
import type { FlowDefinition } from '@ankhorage/contracts/flow';
import { describe, expect, it } from 'bun:test';

import {
  FileFlowPersistenceAdapter,
  FileFlowRuntimeStore,
  InMemoryFlowObservability,
  InMemoryFlowPersistenceAdapter,
  InMemoryFlowRuntimeStore,
  createFlowSecurityPort,
  createDefaultNodeRegistry,
  createFlowRuntime,
  compileFlowGraph,
  executeFlowAsync,
} from '../src/index.js';
import type { FlowNodeRegistry, FlowSecurityPort } from '../src/index.js';
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

  it('returns only a capability-gated, run-and-revision-bound approval availability projection', async () => {
    const clock = { now: () => new Date('2026-11-18T10:00:00.000Z') };
    const runtime = createFlowRuntime({
      clock,
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, definition.id, definition.version);
    const run = await runtime.triggerAsync({
      flowId: definition.id,
      idempotencyKey: 'approval-availability',
      scope,
      triggerId: 'manual',
    });
    await runtime.requestApprovalAsync({
      approval: {
        context: { kind: 'inline', value: 'SENTINEL_APPROVAL_CONTEXT' },
        expiresAt: '2026-11-18T11:00:00.000Z',
        id: 'approval-availability',
        message: 'SENTINEL_APPROVAL_MESSAGE',
        requestedAt: '2026-11-18T09:00:00.000Z',
        requestedBy: 'SENTINEL_REQUESTED_BY',
        runId: run.id,
        status: 'pending',
      },
      scope,
    });
    const capabilities: string[] = [];
    const handler = createFlowHttpHandler({
      access: {
        acquireAsync: async ({ capability }) => {
          capabilities.push(capability);
          return true;
        },
        authorizeAsync: async ({ capability }) => {
          capabilities.push(capability);
          return capability === 'approval:read';
        },
      },
      authenticator: {
        authenticateAsync: async (request) =>
          request.headers.get('authorization') === 'Bearer reader'
            ? { environment: 'test', id: 'reader', ...scope }
            : request.headers.get('authorization') === 'Bearer other-tenant'
              ? { environment: 'test', id: 'reader', projectId: 'project', tenantId: 'other' }
              : undefined,
      },
      runtime,
    });
    const path = `/v1/workflows/${definition.id}/${definition.version}/runs/${run.id}/approvals/approval-availability`;
    const unauthenticated = await handler(new Request(`http://flow${path}`));
    expect(unauthenticated.status).toBe(401);
    const response = await handler(
      new Request(`http://flow${path}`, { headers: { authorization: 'Bearer reader' } }),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      approvalId: 'approval-availability',
      expiresAt: '2026-11-18T11:00:00.000Z',
      flowId: definition.id,
      flowVersion: definition.version,
      runId: run.id,
      status: 'pending',
    });
    expect(text).not.toContain('SENTINEL');
    expect(capabilities).toEqual(['approval:read', 'approval:read']);
    expect(
      (
        await handler(
          new Request(`http://flow${path}`, { headers: { authorization: 'Bearer other-tenant' } }),
        )
      ).status,
    ).toBe(404);
    const openApi = (await (await handler(new Request('http://flow/openapi.json'))).json()) as {
      readonly paths: Record<
        string,
        { readonly get?: { readonly parameters?: readonly { readonly name: string }[] } }
      >;
    };
    expect(
      openApi.paths[
        '/v1/workflows/{flowId}/{version}/runs/{runId}/approvals/{approvalId}'
      ]?.get?.parameters?.map(({ name }) => name),
    ).toEqual(['flowId', 'version', 'runId', 'approvalId']);
    expect(
      (
        await handler(
          new Request(
            `http://flow/v1/workflows/${definition.id}/2/runs/${run.id}/approvals/approval-availability`,
            { headers: { authorization: 'Bearer reader' } },
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(
          new Request(
            `http://flow/v1/workflows/${definition.id}/${definition.version}/runs/${run.id}/approvals/missing`,
            { headers: { authorization: 'Bearer reader' } },
          ),
        )
      ).status,
    ).toBe(404);
  });

  it('projects expired approval availability without changing the stored approval state', async () => {
    const clock = { now: () => new Date('2026-11-18T12:00:00.000Z') };
    const runtime = createFlowRuntime({
      clock,
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, definition.id, definition.version);
    const run = await runtime.triggerAsync({
      flowId: definition.id,
      idempotencyKey: 'expired-approval-availability',
      scope,
      triggerId: 'manual',
    });
    await runtime.requestApprovalAsync({
      approval: {
        expiresAt: '2026-11-18T11:00:00.000Z',
        id: 'expired-approval',
        requestedAt: '2026-11-18T09:00:00.000Z',
        runId: run.id,
        status: 'pending',
      },
      scope,
    });
    expect(
      await runtime.getApprovalAvailabilityAsync({
        approvalId: 'expired-approval',
        flowId: definition.id,
        flowVersion: definition.version,
        runId: run.id,
        scope,
      }),
    ).toMatchObject({ status: 'expired' });
  });

  it('preserves each owner-recorded terminal approval status', async () => {
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, definition.id, definition.version);
    const run = await runtime.triggerAsync({
      flowId: definition.id,
      idempotencyKey: 'terminal-approval-availability',
      scope,
      triggerId: 'manual',
    });
    for (const status of ['approved', 'rejected', 'cancelled', 'expired'] as const) {
      await runtime.requestApprovalAsync({
        approval: {
          id: 'terminal-approval',
          requestedAt: '2026-11-18T09:00:00.000Z',
          runId: run.id,
          status,
        },
        scope,
      });
      expect(
        await runtime.getApprovalAvailabilityAsync({
          approvalId: 'terminal-approval',
          flowId: definition.id,
          flowVersion: definition.version,
          runId: run.id,
          scope,
        }),
      ).toMatchObject({ status });
    }
  });

  it('fails closed when owner approval expiry data is malformed', async () => {
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, definition.id, definition.version);
    const run = await runtime.triggerAsync({
      flowId: definition.id,
      idempotencyKey: 'malformed-approval-availability',
      scope,
      triggerId: 'manual',
    });
    await runtime.requestApprovalAsync({
      approval: {
        expiresAt: 'not-a-timestamp',
        id: 'malformed-approval',
        requestedAt: '2026-11-18T09:00:00.000Z',
        runId: run.id,
        status: 'pending',
      },
      scope,
    });
    expect(
      await runtime.getApprovalAvailabilityAsync({
        approvalId: 'malformed-approval',
        flowId: definition.id,
        flowVersion: definition.version,
        runId: run.id,
        scope,
      }),
    ).toBeUndefined();
  });

  it('binds HTTP trigger families to their own permissions, rejects cross-kind calls, and redacts replays', async () => {
    const runtime = createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, definition);
    await runtime.publishAsync(scope, definition.id, definition.version);
    const capabilities: string[] = [];
    const handler = createFlowHttpHandler({
      access: {
        acquireAsync: async ({ capability }) => {
          capabilities.push(capability);
          return true;
        },
        authorizeAsync: async ({ capability }) => {
          capabilities.push(capability);
          return capability === 'trigger:manual';
        },
      },
      authenticator: {
        authenticateAsync: async () => ({ environment: 'test', id: 'actor', ...scope }),
      },
      runtime,
    });
    const manual = () =>
      handler(
        new Request('http://flow/v1/workflows/demo/triggers/manual', {
          body: JSON.stringify({
            idempotencyKey: 'manual-secret',
            input: { secret: { kind: 'inline', value: 'SENTINEL_TRIGGER_SECRET' } },
          }),
          method: 'POST',
        }),
      );
    const first = await manual();
    const firstBody = await first.text();
    const replay = await manual();
    const replayBody = await replay.text();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(firstBody).not.toContain('SENTINEL_TRIGGER_SECRET');
    expect(replayBody).not.toContain('SENTINEL_TRIGGER_SECRET');
    expect(JSON.parse(firstBody)).toMatchObject({ status: 'pending' });
    expect(JSON.parse(firstBody)).not.toHaveProperty('input');
    expect(JSON.parse(replayBody).id).toBe(JSON.parse(firstBody).id);
    expect(capabilities).toEqual([
      'trigger:manual',
      'trigger:manual',
      'trigger:manual',
      'trigger:manual',
    ]);
    expect(
      (
        await handler(
          new Request('http://flow/v1/webhooks/demo/hook', {
            body: JSON.stringify({ idempotencyKey: 'denied-webhook' }),
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(403);

    const crossKindHandler = createFlowHttpHandler({
      access: { acquireAsync: async () => true, authorizeAsync: async () => true },
      authenticator: {
        authenticateAsync: async () => ({ environment: 'test', id: 'actor', ...scope }),
      },
      runtime,
    });
    expect(
      (
        await crossKindHandler(
          new Request('http://flow/v1/workflows/demo/triggers/hook', {
            body: JSON.stringify({ idempotencyKey: 'manual-to-hook' }),
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await crossKindHandler(
          new Request('http://flow/v1/webhooks/demo/manual', {
            body: JSON.stringify({ idempotencyKey: 'hook-to-manual' }),
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(400);
    expect(await runtime.listRunsAsync(scope)).toHaveLength(1);
  });

  it('synchronizes each completed node and streams redacted progress before terminal completion', async () => {
    const fixture = graphFixture('http-progress', 'SENTINEL_STEP_SECRET', [
      edge('source', 'target'),
    ]);
    const runtime = createFlowRuntime({
      nodeRegistry: fixture.registry,
      persistence: InMemoryFlowPersistenceAdapter(),
      store: InMemoryFlowRuntimeStore(),
    });
    await runtime.createDraftAsync(scope, fixture.definition);
    await runtime.publishAsync(scope, fixture.definition.id, fixture.definition.version);
    const handler = createFlowHttpHandler({
      access: { acquireAsync: async () => true, authorizeAsync: async () => true },
      authenticator: {
        authenticateAsync: async () => ({ environment: 'test', id: 'actor', ...scope }),
      },
      runtime,
    });
    const triggered = await handler(
      new Request('http://flow/v1/workflows/http-progress/triggers/manual', {
        body: JSON.stringify({ idempotencyKey: 'progress' }),
        method: 'POST',
      }),
    );
    const { id } = (await triggered.json()) as { readonly id: string };
    await runtime.runWorkerTickAsync();
    const firstEvents = await handler(
      new Request(`http://flow/v1/events?runId=${id}`, {
        headers: { authorization: 'Bearer test' },
      }),
    );
    const firstBody = await firstEvents.text();
    expect(firstEvents.headers.get('content-type')).toContain('text/event-stream');
    expect(firstBody).not.toContain('SENTINEL_STEP_SECRET');
    expect(sseData(firstBody).map((event) => event.type)).toEqual([
      'run_queued',
      'run_started',
      'run_progressed',
    ]);
    expect((await runtime.getRunAsync(scope, id))?.steps.map((step) => step.nodeId)).toEqual([
      'source',
    ]);
    await runtime.runWorkerTickAsync();
    const finalEvents = await handler(
      new Request(`http://flow/v1/events?after=3&runId=${id}`, {
        headers: { authorization: 'Bearer test' },
      }),
    );
    expect(sseData(await finalEvents.text()).map((event) => event.type)).toEqual(['run_completed']);
    expect((await runtime.getRunAsync(scope, id))?.steps.map((step) => step.nodeId)).toEqual([
      'source',
      'target',
    ]);
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

  it('persists headless approval, cancellation, retry, and recovery lifecycle transitions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-headless-lifecycle-'));
    const runtimePath = join(directory, 'runtime.json');
    const clock = mutableClock(new Date('2026-11-15T10:00:00.000Z'));
    const approval = { approved: false };
    const deliveries: string[] = [];
    const failures = { enabled: true };
    const dependencies = () => ({
      clock,
      nodeRegistry: lifecycleRegistry(deliveries, failures),
      persistence: FileFlowPersistenceAdapter(`${runtimePath}.durable`),
      security: approvalSecurity(approval),
      store: FileFlowRuntimeStore(runtimePath),
    });
    try {
      const first = createFlowRuntime(dependencies());
      await publishLifecycleFlowAsync(first, 'approval', 'protected');
      const waiting = await first.triggerAsync({
        flowId: 'approval',
        idempotencyKey: 'approval',
        scope,
        triggerId: 'manual',
      });
      await first.runWorkerTickAsync();
      expect((await first.getRunAsync(scope, waiting.id))?.status).toBe('waiting_for_approval');
      expect(deliveries).toEqual([]);

      approval.approved = true;
      clock.advance(60_000);
      const resumed = createFlowRuntime(dependencies());
      await resumed.runWorkerTickAsync();
      expect((await resumed.getRunAsync(scope, waiting.id))?.status).toBe('succeeded');
      expect(deliveries).toEqual([`${waiting.id}:step:protected`]);

      await publishLifecycleFlowAsync(resumed, 'cancel', 'protected');
      const cancelled = await resumed.triggerAsync({
        flowId: 'cancel',
        idempotencyKey: 'cancel',
        scope,
        triggerId: 'manual',
      });
      expect((await resumed.cancelRunAsync(scope, cancelled.id))?.status).toBe('cancelled');
      await resumed.runWorkerTickAsync();
      expect(deliveries).toEqual([`${waiting.id}:step:protected`]);

      await publishLifecycleFlowAsync(resumed, 'retry', 'retry');
      const failed = await resumed.triggerAsync({
        flowId: 'retry',
        idempotencyKey: 'retry',
        scope,
        triggerId: 'manual',
      });
      for (const _attempt of [1, 2, 3]) {
        await resumed.runWorkerTickAsync();
        clock.advance(60_000);
      }
      expect((await resumed.getRunAsync(scope, failed.id))?.status).toBe('failed');
      failures.enabled = false;
      const retried = await resumed.retryRunAsync(scope, failed.id);
      expect(retried?.status).toBe('pending');
      await resumed.runWorkerTickAsync();
      expect((await resumed.getRunAsync(scope, retried!.id))?.status).toBe('succeeded');

      await publishLifecycleFlowAsync(resumed, 'recovery', 'retry');
      const recovered = await resumed.triggerAsync({
        flowId: 'recovery',
        idempotencyKey: 'recovery',
        scope,
        triggerId: 'manual',
      });
      const restarted = createFlowRuntime(dependencies());
      await restarted.runWorkerTickAsync();
      expect((await restarted.getRunAsync(scope, recovered.id))?.status).toBe('succeeded');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('recovers a terminated headless protected delivery from an independent provider receipt without redelivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flow-headless-crash-'));
    const fixture = new URL('./fixtures/durableHeadlessCrashWorker.ts', import.meta.url).pathname;
    const input = {
      deliveryPath: join(directory, 'provider-deliveries.json'),
      durablePath: join(directory, 'durable.json'),
      receiptPath: join(directory, 'provider-receipts.json'),
      runtimePath: join(directory, 'runtime.json'),
    };
    try {
      const crashed = Bun.spawnSync([
        process.execPath,
        fixture,
        JSON.stringify({ ...input, mode: 'crash-after-provider' }),
      ]);
      expect(crashed.exitCode).not.toBe(0);
      const recovered = Bun.spawnSync([
        process.execPath,
        fixture,
        JSON.stringify({ ...input, mode: 'recover' }),
      ]);
      const output = `${recovered.stdout.toString()}${recovered.stderr.toString()}`;
      expect(recovered.exitCode, output).toBe(0);
      const result = JSON.parse(recovered.stdout.toString()) as {
        readonly deliveries: readonly string[];
        readonly receipts: readonly { readonly idempotencyKey: string }[];
        readonly run: {
          readonly status: string;
          readonly steps: readonly { readonly nodeId: string }[];
        };
      };
      expect(result.receipts).toEqual([
        expect.objectContaining({ idempotencyKey: expect.stringMatching(/:step:provider$/) }),
      ]);
      expect(result.deliveries).toHaveLength(1);
      expect(result.run.status).toBe('succeeded');
      expect(result.run.steps.map((step) => step.nodeId)).toEqual(['branch', 'provider']);
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

  it('executes an authenticated webhook through a protected node without changing manual execution', async () => {
    const deliveries: string[] = [];
    const runtime = createFlowRuntime({
      nodeRegistry: {
        'fixture:protected': {
          effect: {
            createSecurityOperation: ({ effect }) => ({
              actor: { environment: 'test', id: 'actor', projectId: 'project', tenantId: 'tenant' },
              capability: 'fixture:protected',
              idempotencyKey: effect.idempotencyKey,
              operationId: effect.idempotencyKey,
            }),
            kind: 'protected',
          },
          executeAsync: async ({ effect }) => {
            deliveries.push(effect.idempotencyKey);
            return { output: {} };
          },
        },
      },
      persistence: InMemoryFlowPersistenceAdapter(),
      security: permittedSecurity(),
      store: InMemoryFlowRuntimeStore(),
    });
    const webhook = {
      ...definition,
      id: 'protected-webhook',
      nodes: [
        {
          capability: { capabilityId: 'protected', providerId: 'fixture' },
          id: 'effect',
          ports: [],
        },
      ],
      version: 2,
    };
    await runtime.createDraftAsync(scope, webhook);
    await runtime.publishAsync(scope, webhook.id, webhook.version);
    const handler = createFlowHttpHandler({
      access: { acquireAsync: async () => true, authorizeAsync: async () => true },
      authenticator: {
        authenticateAsync: async () => ({ environment: 'test', id: 'actor', ...scope }),
      },
      runtime,
    });
    const response = await handler(
      new Request('http://flow/v1/webhooks/protected-webhook/hook', {
        body: JSON.stringify({ idempotencyKey: 'protected-webhook' }),
        method: 'POST',
      }),
    );
    const run = (await response.json()) as { readonly id: string };
    await drainRuntimeAsync(runtime);
    expect(response.status).toBe(202);
    expect((await runtime.getRunAsync(scope, run.id))?.status).toBe('succeeded');
    expect(deliveries).toEqual([`${run.id}:step:effect`]);
  });

  it.each([
    { path: '/v1/workflows/schema-manual/triggers/manual', triggerId: 'manual' },
    { path: '/v1/webhooks/schema-webhook/hook', triggerId: 'hook' },
  ])(
    'rejects an authenticated $triggerId revision before its protected provider can execute',
    async ({ path, triggerId }) => {
      const deliveries: string[] = [];
      const runtime = createFlowRuntime({
        nodeRegistry: protectedSchemaRegistry(deliveries),
        persistence: InMemoryFlowPersistenceAdapter(),
        security: permittedSecurity(),
        store: InMemoryFlowRuntimeStore(),
      });
      const flowId = `schema-${triggerId === 'manual' ? 'manual' : 'webhook'}`;
      const invalid = unsupportedSchemaDefinition(flowId);
      await runtime.createDraftAsync(scope, invalid);
      await runtime.publishAsync(scope, flowId, 1);
      const handler = createFlowHttpHandler({
        access: { acquireAsync: async () => true, authorizeAsync: async () => true },
        authenticator: {
          authenticateAsync: async () => ({ environment: 'test', id: 'actor', ...scope }),
        },
        runtime,
      });

      expect(
        (
          await handler(
            new Request(`http://flow${path}`, {
              body: JSON.stringify({ idempotencyKey: `invalid-${triggerId}` }),
              method: 'POST',
            }),
          )
        ).status,
      ).toBe(400);
      expect(deliveries).toHaveLength(0);
      expect(await runtime.listRunsAsync(scope, flowId)).toEqual([]);
    },
  );

  it.each(graphParityFixtures())(
    'keeps durable headless graph behavior equal to the canonical executor: $name',
    async ({ definition: fixture, name, registry }) => {
      const expected = await executeFlowAsync(compileFlowGraph(fixture, registry), registry, {
        runId: `direct-${name}`,
        triggerId: 'manual',
      });
      const runtime = createFlowRuntime({
        nodeRegistry: registry,
        persistence: InMemoryFlowPersistenceAdapter(),
        store: InMemoryFlowRuntimeStore(),
      });
      await runtime.createDraftAsync(scope, fixture);
      await runtime.publishAsync(scope, fixture.id, fixture.version);
      const run = await runtime.triggerAsync({
        flowId: fixture.id,
        idempotencyKey: name,
        scope,
        triggerId: 'manual',
      });
      await drainRuntimeAsync(runtime);
      const actual = await runtime.getRunAsync(scope, run.id);
      expect(actual?.status).toBe(expected.run.status);
      expect(actual?.steps.map((step) => step.nodeId)).toEqual(
        expected.run.steps.map((step) => step.nodeId),
      );
    },
  );
});

/** Complete the finite fixture queue without assuming one graph node per worker tick. */
const drainRuntimeAsync = async (runtime: {
  readonly runWorkerTickAsync: () => Promise<unknown>;
}) => {
  await runtime.runWorkerTickAsync();
  await runtime.runWorkerTickAsync();
  await runtime.runWorkerTickAsync();
  await runtime.runWorkerTickAsync();
};

/** Decode the finite HTTP event stream into its canonical JSON event payloads. */
const sseData = (body: string): readonly { readonly type: string }[] =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map(
      (entry) => JSON.parse(entry.replace('event: flow\ndata: ', '')) as { readonly type: string },
    );

/** Provide the released security port shape for a protected headless provider fixture. */
const permittedSecurity = (): FlowSecurityPort => ({
  authorizeAsync: async (operation) => ({
    executeAsync: async <Result>(
      callback: (
        secrets: Readonly<Record<string, Readonly<Record<string, string>>>>,
      ) => Promise<Result>,
    ) => callback({}),
    operation: { ...operation, secretRefs: operation.secretRefs ?? [] },
  }),
  createSecretAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
  getSecretMetadataAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
  revokeSecretAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
});

/** Supply representative diamond, failure, and key-order-independent conditional graph fixtures. */
const graphParityFixtures = () => [diamondFixture(), failureFixture(), reorderedJsonFixture()];

/** An unselected diamond branch must not strand the selected join. */
const diamondFixture = () =>
  graphFixture('diamond', { selected: true }, [
    conditionalEdge('source', 'left', true),
    conditionalEdge('source', 'right', false),
    edge('left', 'join'),
    edge('right', 'join'),
  ]);

/** A failure outcome follows its declared branch before the run becomes terminal. */
const failureFixture = () => ({
  definition: {
    edges: [
      {
        condition: { kind: 'outcome', outcome: 'failure' },
        id: 'failure',
        source: { nodeId: 'source', portId: 'value' },
        target: { nodeId: 'recovered', portId: 'value' },
      },
    ],
    id: 'failure',
    nodes: [node('source', 'fail'), node('recovered', 'pass')],
    title: 'Failure',
    triggers: [{ id: 'manual', kind: 'manual' }],
    version: 1,
  } satisfies FlowDefinition,
  name: 'failure',
  registry: fixtureRegistry({ source: 'fail' }),
});

/** Conditional JSON equality ignores object key order in both execution modes. */
const reorderedJsonFixture = () =>
  graphFixture('reordered-json', { nested: { a: 1, b: 2 } }, [
    {
      condition: { equals: { a: 1, b: 2 }, kind: 'value', path: '/nested' },
      id: 'reordered',
      source: { nodeId: 'source', portId: 'value' },
      target: { nodeId: 'matched', portId: 'value' },
    },
  ]);

/** Create a transform source plus pass-through targets for a parity graph. */
const graphFixture = (name: string, value: DataContractValue, edges: FlowDefinition['edges']) => ({
  definition: {
    edges,
    id: name,
    nodes: [node('source', 'emit'), ...targetNodes(edges)],
    title: name,
    triggers: [{ id: 'manual', kind: 'manual' }],
    version: 1,
  } satisfies FlowDefinition,
  name,
  registry: fixtureRegistry({ source: 'emit', value }),
});

/** Define a fixture node with a value output that can also accept join input. */
const node = (id: string, capabilityId: string) => ({
  capability: { capabilityId, providerId: 'fixture' },
  id,
  ports: [
    { direction: 'input' as const, id: 'value', required: false },
    { direction: 'output' as const, id: 'value', required: false },
  ],
});

/** Make one target node per edge while retaining deterministic graph ordering. */
const targetNodes = (edges: FlowDefinition['edges']) =>
  [...new Set(edges.map((entry) => entry.target.nodeId))].map((id) => node(id, 'pass'));

/** Connect two fixture nodes over their shared portable value port. */
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source: { nodeId: source, portId: 'value' },
  target: { nodeId: target, portId: 'value' },
});

/** Create a boolean-value branch edge. */
const conditionalEdge = (source: string, target: string, equals: boolean) => ({
  ...edge(source, target),
  condition: { equals, kind: 'value' as const, path: '/selected' },
});

/** Create controlled test-only node operations with a stable observable output. */
const fixtureRegistry = (source: {
  readonly source: 'emit' | 'fail';
  readonly value?: DataContractValue;
}): FlowNodeRegistry => ({
  'fixture:emit': {
    effect: { kind: 'internal' as const },
    executeAsync: async () => ({
      output: { value: { kind: 'inline' as const, value: source.value ?? null } },
    }),
  },
  'fixture:fail': {
    effect: { kind: 'internal' as const },
    executeAsync: async () => {
      throw new Error('FLOW_FIXTURE_FAILURE');
    },
  },
  'fixture:pass': {
    effect: { kind: 'internal' as const },
    executeAsync: async () => ({ output: {} }),
  },
});

/** Supply a protected first node and a later unsupported port schema for the headless preflight. */
const unsupportedSchemaDefinition = (id: string) =>
  ({
    edges: [],
    id,
    nodes: [
      {
        capability: { capabilityId: 'protected', providerId: 'fixture' },
        id: 'provider',
        ports: [],
      },
      {
        capability: { capabilityId: 'pass', providerId: 'fixture' },
        id: 'unsupported',
        ports: [
          { data: { schema: { format: 'email' } }, direction: 'output' as const, id: 'value' },
        ],
      },
    ],
    title: 'Unsupported schema preflight',
    triggers: [
      { id: 'manual', kind: 'manual' as const },
      { id: 'hook', kind: 'webhook' as const, path: '/hook' },
    ],
    version: 1,
  }) satisfies FlowDefinition;

/** Count only an actual protected provider delivery after the security boundary permits it. */
const protectedSchemaRegistry = (deliveries: string[]): FlowNodeRegistry => ({
  'fixture:pass': {
    effect: { kind: 'internal' as const },
    executeAsync: async () => ({ output: {} }),
  },
  'fixture:protected': {
    effect: {
      createSecurityOperation: ({ effect }) => ({
        actor: { environment: 'test', id: 'actor', projectId: 'project', tenantId: 'tenant' },
        capability: 'fixture:protected',
        idempotencyKey: effect.idempotencyKey,
        operationId: effect.idempotencyKey,
      }),
      kind: 'protected',
    },
    executeAsync: async ({ effect }) => {
      deliveries.push(effect.idempotencyKey);
      return { output: {} };
    },
  },
});

/** Create an approved-or-pending protected boundary for the persisted lifecycle acceptance. */
const approvalSecurity = (state: { readonly approved: boolean }): FlowSecurityPort => {
  const claimed = new Set<string>();
  const consumed = new Set<string>();
  return createFlowSecurityPort({
    approvalStore: {
      getAsync: async (operation) => ({
        operation,
        status: state.approved ? 'approved' : 'pending',
      }),
    },
    audit: { writeAsync: async () => undefined },
    grants: [
      {
        actorId: 'actor',
        capability: 'fixture:protected',
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
        error: { code: 'unavailable', message: 'unused' },
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

/** Compose protected and retried operations under the same production graph execution boundary. */
const lifecycleRegistry = (
  deliveries: string[],
  failures: { readonly enabled: boolean },
): FlowNodeRegistry => ({
  'fixture:protected': {
    effect: {
      createSecurityOperation: ({ effect }) => ({
        actor: { environment: 'test', id: 'actor', projectId: 'project', tenantId: 'tenant' },
        capability: 'fixture:protected',
        idempotencyKey: effect.idempotencyKey,
        operationId: effect.idempotencyKey,
      }),
      kind: 'protected',
    },
    executeAsync: async ({ effect }) => {
      deliveries.push(effect.idempotencyKey);
      return { output: {} };
    },
  },
  'fixture:retry': {
    effect: { kind: 'internal' },
    executeAsync: async () => {
      if (failures.enabled) throw new Error('FLOW_TEST_RETRY');
      return { output: {} };
    },
  },
});

/** Persist and publish one single-node lifecycle flow through the public headless runtime. */
const publishLifecycleFlowAsync = async (
  runtime: ReturnType<typeof createFlowRuntime>,
  id: string,
  capabilityId: 'protected' | 'retry',
): Promise<void> => {
  const lifecycle = {
    edges: [],
    id,
    nodes: [{ capability: { capabilityId, providerId: 'fixture' }, id: capabilityId, ports: [] }],
    title: id,
    triggers: [{ id: 'manual', kind: 'manual' as const }],
    version: 1,
  } satisfies FlowDefinition;
  await runtime.createDraftAsync(scope, lifecycle);
  await runtime.publishAsync(scope, id, 1);
};

/** Advance the persisted worker clock without touching wall-clock time in lifecycle acceptance. */
const mutableClock = (initial: Date) => {
  let current = initial;
  return {
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
    now: () => current,
  };
};
