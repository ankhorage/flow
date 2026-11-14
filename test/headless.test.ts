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
