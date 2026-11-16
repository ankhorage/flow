import { readFile, rename, writeFile } from 'node:fs/promises';

import type { FlowDefinition } from '@ankhorage/contracts/flow';

import {
  FileFlowPersistenceAdapter,
  FileFlowRuntimeStore,
  createFlowRuntime,
} from '../../src/index.js';

interface Receipt {
  readonly idempotencyKey: string;
  readonly output: { readonly receipt: { readonly kind: 'inline'; readonly value: string } };
}

interface FixtureInput {
  readonly deliveryPath: string;
  readonly durablePath: string;
  readonly mode: 'crash-after-provider' | 'recover';
  readonly receiptPath: string;
  readonly runtimePath: string;
}

const input = JSON.parse(process.argv[2] ?? '') as FixtureInput;
const scope = { projectId: 'project', tenantId: 'tenant' };
const clock = {
  now: () =>
    new Date(
      input.mode === 'crash-after-provider'
        ? '2026-11-14T12:00:00.000Z'
        : '2026-11-14T12:01:00.000Z',
    ),
};

const definition: FlowDefinition = {
  edges: [
    {
      condition: { equals: true, kind: 'value', path: '/selected' },
      id: 'branch-to-provider',
      source: { nodeId: 'branch', portId: 'route' },
      target: { nodeId: 'provider', portId: 'route' },
    },
    {
      condition: { equals: false, kind: 'value', path: '/selected' },
      id: 'branch-to-skipped',
      source: { nodeId: 'branch', portId: 'route' },
      target: { nodeId: 'skipped', portId: 'route' },
    },
  ],
  id: 'durable-crash-flow',
  nodes: [
    {
      capability: { capabilityId: 'branch', providerId: 'fixture' },
      id: 'branch',
      ports: [{ direction: 'output', id: 'route', required: true }],
    },
    {
      capability: { capabilityId: 'write', providerId: 'fixture' },
      id: 'provider',
      ports: [
        { direction: 'input', id: 'route', required: true },
        { direction: 'output', id: 'receipt', required: true },
      ],
    },
    {
      capability: { capabilityId: 'skipped', providerId: 'fixture' },
      id: 'skipped',
      ports: [{ direction: 'input', id: 'route', required: true }],
    },
  ],
  title: 'Durable crash fixture',
  triggers: [{ id: 'manual', kind: 'manual' }],
  version: 1,
};

const runtime = createFlowRuntime({
  clock,
  nodeRegistry: {
    'fixture:branch': {
      effect: { kind: 'internal' },
      executeAsync: async () => ({
        output: { route: { kind: 'inline', value: { selected: true } } },
      }),
    },
    'fixture:skipped': {
      effect: { kind: 'internal' },
      executeAsync: async () => {
        throw new Error('FLOW_TEST_SKIPPED_BRANCH_DELIVERED');
      },
    },
    'fixture:write': {
      effect: {
        createSecurityOperation: ({ effect }) => ({
          actor: { environment: 'test', id: 'operator', projectId: 'project', tenantId: 'tenant' },
          capability: 'fixture:write',
          idempotencyKey: effect.idempotencyKey,
          operationId: effect.idempotencyKey,
        }),
        kind: 'protected',
      },
      executeAsync: async ({ effect }) => {
        await recordProviderInvocationAsync(effect.idempotencyKey);
        const receipt = await saveReceiptAsync(effect.idempotencyKey);
        if (input.mode === 'crash-after-provider') process.kill(process.pid, 'SIGKILL');
        return { output: receipt.output };
      },
      reconcileAsync: async ({ effect }) => {
        const receipt = await readReceiptAsync(effect.idempotencyKey);
        return receipt === undefined ? 'unknown' : { output: receipt.output };
      },
    },
  },
  persistence: FileFlowPersistenceAdapter(input.durablePath),
  security: {
    authorizeAsync: async (operation) => ({
      executeAsync: async (callback) => callback({}),
      operation: { ...operation, secretRefs: operation.secretRefs ?? [] },
    }),
    reconcileAsync: async () => ({ reconcileAsync: async (callback) => callback({}) }),
    createSecretAsync: async () => {
      throw new Error('FLOW_TEST_SECRET_UNUSED');
    },
    getSecretMetadataAsync: async () => {
      throw new Error('FLOW_TEST_SECRET_UNUSED');
    },
    revokeSecretAsync: async () => {
      throw new Error('FLOW_TEST_SECRET_UNUSED');
    },
    replaceSecretAsync: async () => {
      throw new Error('FLOW_TEST_SECRET_UNUSED');
    },
  },
  store: FileFlowRuntimeStore(input.runtimePath),
});

if (input.mode === 'crash-after-provider') {
  await runtime.createDraftAsync(scope, definition);
  await runtime.publishAsync(scope, definition.id, definition.version);
  const run = await runtime.triggerAsync({
    flowId: definition.id,
    idempotencyKey: 'crash-fixture-trigger',
    scope,
    triggerId: 'manual',
  });
  await runtime.runWorkerTickAsync();
  await runtime.runWorkerTickAsync();
  throw new Error(`FLOW_TEST_CRASH_NOT_REACHED:${run.id}`);
}

await runtime.runWorkerTickAsync();
const [run] = await runtime.listRunsAsync(scope, definition.id);
const receipts = await readReceiptsAsync();
const deliveries = await readDeliveriesAsync();
console.log(JSON.stringify({ deliveries, receipts, run }));

/** Persist one provider receipt independently from Flow's durable state using its stable key. */
async function saveReceiptAsync(idempotencyKey: string): Promise<Receipt> {
  const existing = await readReceiptAsync(idempotencyKey);
  if (existing !== undefined) return existing;
  const receipt: Receipt = {
    idempotencyKey,
    output: { receipt: { kind: 'inline', value: 'provider-applied' } },
  };
  const receipts = [...(await readReceiptsAsync()), receipt];
  const temporary = `${input.receiptPath}.tmp`;
  await writeFile(temporary, JSON.stringify(receipts), 'utf8');
  await rename(temporary, input.receiptPath);
  return receipt;
}

/** Read the provider-owned stable delivery record without consulting Flow persistence. */
async function readReceiptAsync(idempotencyKey: string): Promise<Receipt | undefined> {
  return (await readReceiptsAsync()).find((receipt) => receipt.idempotencyKey === idempotencyKey);
}

/** Load the isolated receipt store; it is deliberately independent of Flow's process and stores. */
async function readReceiptsAsync(): Promise<readonly Receipt[]> {
  try {
    return JSON.parse(await readFile(input.receiptPath, 'utf8')) as readonly Receipt[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Record every provider-boundary invocation separately so receipt deduplication cannot hide a replay. */
async function recordProviderInvocationAsync(idempotencyKey: string): Promise<void> {
  const deliveries = [...(await readDeliveriesAsync()), idempotencyKey];
  await writeFile(input.deliveryPath, JSON.stringify(deliveries), 'utf8');
}

/** Load provider invocation evidence independently from its idempotent receipt store. */
async function readDeliveriesAsync(): Promise<readonly string[]> {
  try {
    return JSON.parse(await readFile(input.deliveryPath, 'utf8')) as readonly string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
