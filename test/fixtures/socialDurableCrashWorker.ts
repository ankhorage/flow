import { readFile, rename, writeFile } from 'node:fs/promises';

import type { FlowDefinition } from '@ankhorage/contracts/flow';

import {
  FileFlowPersistenceAdapter,
  FileFlowRuntimeStore,
  createFlowRuntime,
} from '../../src/index.js';
import { createSocialNodeRegistry } from '../../src/social.js';
import type { SocialProviderReceipt, SocialProviderPort } from '../../src/social.js';
import type { FlowSecurityPort } from '../../src/types/security.js';

interface FixtureInput {
  readonly deliveryPath: string;
  readonly durablePath: string;
  readonly mode: 'crash-after-provider' | 'recover';
  readonly permitPath: string;
  readonly receiptPath: string;
  readonly runtimePath: string;
}

interface Receipt {
  readonly idempotencyKey: string;
  readonly publication: { readonly platformPostId: string; readonly status: 'posted' };
}

const input = JSON.parse(process.argv[2] ?? '') as FixtureInput;
const scope = { projectId: 'project', tenantId: 'tenant' };
const actor = { environment: 'test', id: 'author', ...scope };
const clock = {
  now: () =>
    new Date(
      input.mode === 'crash-after-provider'
        ? '2026-11-16T10:00:00.000Z'
        : '2026-11-16T10:01:00.000Z',
    ),
};
const credential = {
  accountId: 'page-1',
  accountType: 'page',
  platform: 'meta-facebook',
  scopes: 'pages_manage_posts pages_read_engagement pages_show_list',
  tenantId: 'tenant',
  token: 'SENTINEL_SOCIAL_CRASH_TOKEN',
};
const definition: FlowDefinition = {
  edges: [],
  id: 'social-crash-flow',
  nodes: [
    {
      capability: { capabilityId: 'publish', providerId: 'social' },
      config: {
        accountId: { kind: 'inline', value: 'page-1' },
        accountType: { kind: 'inline', value: 'page' },
        credential: { kind: 'secret', ref: 'oauth-ref' },
        platform: { kind: 'inline', value: 'meta-facebook' },
        text: { kind: 'inline', value: 'one durable post' },
      },
      id: 'publish',
      ports: [{ direction: 'output', id: 'publication', required: true }],
    },
  ],
  title: 'Social durable crash fixture',
  triggers: [{ id: 'manual', kind: 'manual' }],
  version: 1,
};

const provider: SocialProviderPort = {
  allowedCapabilities: ['analytics:read', 'oauth:renew', 'oauth:revoke', 'publish', 'schedule'],
  allowedHosts: ['mock.social.test'],
  endpoint: 'https://mock.social.test/v1',
  fetchAnalyticsAsync: async () => {
    throw new Error('FLOW_TEST_ANALYTICS_UNUSED');
  },
  platform: 'meta-facebook',
  publishAsync: async ({ request }) => {
    await recordAsync(input.deliveryPath, request.idempotencyKey);
    const receipt = await saveReceiptAsync(request.idempotencyKey);
    if (input.mode === 'crash-after-provider') process.kill(process.pid, 'SIGKILL');
    return receipt.publication;
  },
  reconcileAsync: async ({ idempotencyKey }): Promise<SocialProviderReceipt> => {
    const receipt = await readReceiptAsync(idempotencyKey);
    return receipt === undefined
      ? { kind: 'unknown' }
      : { kind: 'publish', publication: receipt.publication };
  },
  reconcileRevocationAsync: async () => ({ kind: 'unknown' }),
  renewAsync: async () => {
    throw new Error('FLOW_TEST_RENEW_UNUSED');
  },
  revokeAsync: async () => {
    throw new Error('FLOW_TEST_REVOKE_UNUSED');
  },
  validateMediaAsync: async () => undefined,
};

const security: FlowSecurityPort = {
  authorizeAsync: async (operation) => {
    await recordAsync(input.permitPath, operation.idempotencyKey);
    return {
      executeAsync: async (callback) => callback({ 'oauth-ref': credential }),
      operation: { ...operation, secretRefs: operation.secretRefs ?? [] },
    };
  },
  reconcileAsync: async () => ({
    reconcileWithoutSecretsAsync: async (callback) => callback(),
    reconcileAsync: async (callback) => callback({ 'oauth-ref': credential }),
  }),
  createSecretAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
  getSecretMetadataAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
  replaceSecretAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
  revokeSecretAsync: async () => {
    throw new Error('FLOW_TEST_SECRET_UNUSED');
  },
};

const runtime = createFlowRuntime({
  clock,
  nodeRegistry: createSocialNodeRegistry({
    actor,
    clock,
    outboundTransport: { fetchAsync: async () => new Response() },
    providers: [provider],
    security,
  }),
  persistence: FileFlowPersistenceAdapter(input.durablePath),
  security,
  store: FileFlowRuntimeStore(input.runtimePath),
});

if (input.mode === 'crash-after-provider') {
  await runtime.createDraftAsync(scope, definition);
  await runtime.publishAsync(scope, definition.id, definition.version);
  await runtime.triggerAsync({
    flowId: definition.id,
    idempotencyKey: 'social-crash-trigger',
    scope,
    triggerId: 'manual',
  });
  await runtime.runWorkerTickAsync();
  throw new Error('FLOW_TEST_SOCIAL_CRASH_NOT_REACHED');
}

await runtime.runWorkerTickAsync();
const [run] = await runtime.listRunsAsync(scope, definition.id);
const events = run === undefined ? [] : await runtime.readEventsAsync(scope, 0, run.id);
console.log(
  JSON.stringify({
    deliveries: await readAllAsync(input.deliveryPath),
    events,
    permits: await readAllAsync(input.permitPath),
    receipts: await readReceiptsAsync(),
    run,
  }),
);

/** Persist the provider receipt independently from the worker's durable state before the forced crash. */
async function saveReceiptAsync(idempotencyKey: string): Promise<Receipt> {
  const existing = await readReceiptAsync(idempotencyKey);
  if (existing !== undefined) return existing;
  const receipt: Receipt = {
    idempotencyKey,
    publication: { platformPostId: 'post-1', status: 'posted' },
  };
  const temporary = `${input.receiptPath}.tmp`;
  await writeFile(temporary, JSON.stringify([...(await readReceiptsAsync()), receipt]), 'utf8');
  await rename(temporary, input.receiptPath);
  return receipt;
}

/** Read the provider-owned receipt store without consulting any Flow persistence adapter. */
async function readReceiptAsync(idempotencyKey: string): Promise<Receipt | undefined> {
  return (await readReceiptsAsync()).find((receipt) => receipt.idempotencyKey === idempotencyKey);
}

/** Read all durable receipts, treating only first use of the independent store as empty. */
async function readReceiptsAsync(): Promise<readonly Receipt[]> {
  return readJsonAsync<readonly Receipt[]>(input.receiptPath);
}

/** Record external provider or permit activity independently so receipt idempotency cannot hide a replay. */
async function recordAsync(path: string, value: string): Promise<void> {
  await writeFile(path, JSON.stringify([...(await readAllAsync(path)), value]), 'utf8');
}

/** Read one append-only fixture evidence list. */
async function readAllAsync(path: string): Promise<readonly string[]> {
  return readJsonAsync<readonly string[]>(path);
}

/** Load a fixture JSON store while preserving all non-ENOENT parse or IO failures. */
async function readJsonAsync<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as T;
    throw error;
  }
}
