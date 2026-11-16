import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

import type { FlowDefinition } from '@ankhorage/contracts/flow';

import {
  FileFlowPersistenceAdapter,
  FileFlowRuntimeStore,
  createFlowRuntime,
} from '../../src/index.js';
import { createSocialNodeRegistry } from '../../src/social.js';
import type { SocialProviderPort } from '../../src/social.js';
import type { FlowSecurityPort } from '../../src/types/security.js';

interface FixtureInput {
  readonly deliveryPath: string;
  readonly durablePath: string;
  readonly mode: 'crash-after-provider' | 'crash-after-secret-remove' | 'recover';
  readonly permitPath: string;
  readonly receiptPath: string;
  readonly runtimePath: string;
  readonly secretPath: string;
  readonly secretRemovalPath: string;
}

interface Receipt {
  readonly accountId: string;
  readonly accountType: string;
  readonly idempotencyKey: string;
}

const input = JSON.parse(process.argv[2] ?? '') as FixtureInput;
const scope = { projectId: 'project', tenantId: 'tenant' };
const actor = { environment: 'test', id: 'author', ...scope };
const clock = {
  now: () =>
    new Date(input.mode === 'recover' ? '2026-11-16T10:01:00.000Z' : '2026-11-16T10:00:00.000Z'),
};
const credential = {
  accountId: 'page-1',
  accountType: 'page',
  platform: 'meta-facebook',
  scopes: 'pages_manage_posts pages_read_engagement pages_show_list',
  tenantId: 'tenant',
  token: 'SENTINEL_SOCIAL_REVOKE_CRASH_TOKEN',
};
const definition: FlowDefinition = {
  edges: [],
  id: 'social-revoke-crash-flow',
  nodes: [
    {
      capability: { capabilityId: 'oauth-revoke', providerId: 'social' },
      config: {
        accountId: { kind: 'inline', value: 'page-1' },
        accountType: { kind: 'inline', value: 'page' },
        credential: { kind: 'secret', ref: 'oauth-ref' },
        platform: { kind: 'inline', value: 'meta-facebook' },
      },
      id: 'revoke',
      ports: [{ direction: 'output', id: 'lifecycle', required: true }],
    },
  ],
  title: 'Social revoke crash fixture',
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
  publishAsync: async () => {
    throw new Error('FLOW_TEST_PUBLISH_UNUSED');
  },
  reconcileAsync: async () => ({ kind: 'unknown' }),
  reconcileRevocationAsync: async ({ accountId, accountType, idempotencyKey }) => {
    const receipt = await readReceiptAsync(idempotencyKey);
    return receipt === undefined ||
      receipt.accountId !== accountId ||
      receipt.accountType !== accountType
      ? { kind: 'unknown' }
      : { kind: 'oauth-revoke' };
  },
  renewAsync: async () => {
    throw new Error('FLOW_TEST_RENEW_UNUSED');
  },
  revokeAsync: async ({ authorization, idempotencyKey }) => {
    await recordAsync(input.deliveryPath, idempotencyKey);
    await saveReceiptAsync({
      accountId: authorization.accountId,
      accountType: authorization.accountType,
      idempotencyKey,
    });
    if (input.mode === 'crash-after-provider') process.kill(process.pid, 'SIGKILL');
  },
  validateMediaAsync: async () => undefined,
};

const security: FlowSecurityPort = {
  authorizeAsync: async (operation) => {
    await recordAsync(input.permitPath, operation.idempotencyKey);
    return {
      executeAsync: async (callback) => callback({ 'oauth-ref': await readSecretAsync() }),
      operation: { ...operation, secretRefs: operation.secretRefs ?? [] },
    };
  },
  reconcileAsync: async () => ({
    reconcileWithoutSecretsAsync: async (callback) => callback(),
    reconcileAsync: async (callback) => callback({ 'oauth-ref': await readSecretAsync() }),
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
    if (await existsAsync(input.secretPath)) {
      await unlink(input.secretPath);
      await recordAsync(input.secretRemovalPath, 'removed');
    }
    if (input.mode === 'crash-after-secret-remove') process.kill(process.pid, 'SIGKILL');
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

if (input.mode !== 'recover') {
  await writeFile(input.secretPath, JSON.stringify(credential), 'utf8');
  await runtime.createDraftAsync(scope, definition);
  await runtime.publishAsync(scope, definition.id, definition.version);
  await runtime.triggerAsync({
    flowId: definition.id,
    idempotencyKey: 'social-revoke-crash-trigger',
    scope,
    triggerId: 'manual',
  });
  await runtime.runWorkerTickAsync();
  throw new Error('FLOW_TEST_SOCIAL_REVOKE_CRASH_NOT_REACHED');
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
    removals: await readAllAsync(input.secretRemovalPath),
    run,
    secretPresent: await existsAsync(input.secretPath),
  }),
);

/** Save the provider receipt before returning from the effective remote revocation. */
async function saveReceiptAsync(receipt: Receipt): Promise<void> {
  const existing = await readReceiptAsync(receipt.idempotencyKey);
  if (existing !== undefined) return;
  const temporary = `${input.receiptPath}.tmp`;
  await writeFile(temporary, JSON.stringify([...(await readReceiptsAsync()), receipt]), 'utf8');
  await rename(temporary, input.receiptPath);
}

/** Read a provider receipt by Flow's stable effect identity without Flow durable state. */
async function readReceiptAsync(idempotencyKey: string): Promise<Receipt | undefined> {
  return (await readReceiptsAsync()).find((receipt) => receipt.idempotencyKey === idempotencyKey);
}

/** Keep receipt persistence independent from the worker queue and checkpoint store. */
async function readReceiptsAsync(): Promise<readonly Receipt[]> {
  return readJsonAsync<readonly Receipt[]>(input.receiptPath);
}

/** Record an external effect independently so provider idempotency cannot hide a replay. */
async function recordAsync(path: string, value: string): Promise<void> {
  await writeFile(path, JSON.stringify([...(await readAllAsync(path)), value]), 'utf8');
}

/** Read a fixture evidence list while treating first use as empty. */
async function readAllAsync(path: string): Promise<readonly string[]> {
  return readJsonAsync<readonly string[]>(path);
}

/** Resolve the fixture secret only for a permit callback. */
async function readSecretAsync(): Promise<typeof credential> {
  return JSON.parse(await readFile(input.secretPath, 'utf8')) as typeof credential;
}

/** Check only the fixture's secret lifecycle without logging its payload. */
async function existsAsync(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Load fixture JSON without swallowing malformed evidence or unrelated IO failures. */
async function readJsonAsync<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as T;
    throw error;
  }
}
