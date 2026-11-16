import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowDefinition } from '@ankhorage/contracts/flow';

import {
  FlowSecurityError,
  InMemoryFlowPersistenceAdapter,
  InMemoryFlowRuntimeStore,
  createFlowRuntime,
} from '../src/index.js';
import { createSocialNodeRegistry, socialCapabilities } from '../src/social.js';
import type { SocialProviderPort, SocialProviderReceipt } from '../src/social.js';
import type { FlowSecurityPort } from '../src/types/security.js';

const actor = { environment: 'test', id: 'author', projectId: 'project', tenantId: 'tenant' };

test('executes the approved Draft to Scheduled to Posted to Analytics mock-provider flow', async () => {
  const events: string[] = ['draft'];
  const provider: SocialProviderPort = {
    allowedCapabilities: ['analytics:read', 'oauth:renew', 'oauth:revoke', 'publish', 'schedule'],
    allowedHosts: ['mock.social.test'],
    endpoint: 'https://mock.social.test/v1',
    fetchAnalyticsAsync: async ({ outboundTransport, platformPostId }) => {
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/analytics',
      });
      return {
        metrics: { impressions: 7 },
        observedAt: '2026-11-14T10:01:00.000Z',
        platformPostId,
        provenance: {
          accountId: 'page-1',
          platform: 'meta-facebook',
          provider: 'mock',
          source: 'mock-api',
        },
      };
    },
    platform: 'meta-facebook',
    publishAsync: async ({ outboundTransport, request }) => {
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/publish',
      });
      events.push(request.scheduledAt ? 'scheduled' : 'posted');
      return request.scheduledAt
        ? { platformPostId: 'post-1', scheduledAt: request.scheduledAt, status: 'scheduled' }
        : { platformPostId: 'post-1', publishedAt: '2026-11-14T10:00:00.000Z', status: 'posted' };
    },
    reconcileAsync: async () => ({ kind: 'unknown' }),
    renewAsync: async () => credential(),
    revokeAsync: async () => undefined,
    validateMediaAsync: async () => undefined,
  };
  const registry = createSocialNodeRegistry({
    actor,
    clock: { now: () => new Date('2026-11-14T09:00:00.000Z') },
    providers: [provider],
    outboundTransport: {
      fetchAsync: async ({ allowedHosts, url }) => {
        events.push(`transport:${url}`);
        expect(allowedHosts).toEqual(['mock.social.test']);
        return new Response();
      },
    },
    security: approvedSecurity(events),
  });
  const publish = registry['social:publish'];
  const analytics = registry['social:analytics'];
  if (!publish || !analytics) throw new Error('Expected social operations.');
  await publish.executeAsync({
    config: config({ scheduledAt: '2026-11-14T10:00:00.000Z' }),
    effect: { idempotencyKey: 'schedule-1' },
    input: { media: { artifactId: 'asset-1', kind: 'artifact', mediaType: 'image/jpeg' } },
    node: node('schedule'),
    signal: new AbortController().signal,
  });
  await publish.executeAsync({
    config: config(),
    effect: { idempotencyKey: 'publish-1' },
    input: { media: { artifactId: 'asset-1', kind: 'artifact', mediaType: 'image/jpeg' } },
    node: node('post'),
    signal: new AbortController().signal,
  });
  const result = await analytics.executeAsync({
    config: config({ platformPostId: 'post-1' }),
    effect: { idempotencyKey: 'analytics-1' },
    input: {},
    node: node('analytics'),
    signal: new AbortController().signal,
  });
  expect(events).toEqual([
    'draft',
    'approved',
    'transport:https://mock.social.test/v1/publish',
    'scheduled',
    'approved',
    'transport:https://mock.social.test/v1/publish',
    'posted',
    'approved',
    'transport:https://mock.social.test/v1/analytics',
  ]);
  expect(result.output?.analytics).toEqual({
    kind: 'inline',
    value: {
      metrics: { impressions: 7 },
      observedAt: '2026-11-14T10:01:00.000Z',
      platformPostId: 'post-1',
      provenance: {
        accountId: 'page-1',
        platform: 'meta-facebook',
        provider: 'mock',
        source: 'mock-api',
      },
    },
  });
});

test('runs the persisted headless Draft to Approval to Schedule to Publish to Analytics graph', async () => {
  const published: string[] = [];
  const approval = { granted: false };
  const clock = { instant: new Date('2026-11-14T09:00:00.000Z') };
  const provider: SocialProviderPort = {
    allowedCapabilities: ['analytics:read', 'oauth:renew', 'oauth:revoke', 'publish', 'schedule'],
    allowedHosts: ['mock.social.test'],
    endpoint: 'https://mock.social.test/v1',
    fetchAnalyticsAsync: async () => ({
      metrics: { impressions: 7 },
      observedAt: clock.instant.toISOString(),
      platformPostId: 'post-1',
      provenance: {
        accountId: 'page-1',
        platform: 'meta-facebook',
        provider: 'mock',
        source: 'fake',
      },
    }),
    platform: 'meta-facebook',
    publishAsync: async ({ request }) => {
      published.push(request.scheduledAt === undefined ? 'published' : 'scheduled');
      return request.scheduledAt === undefined
        ? { platformPostId: 'post-1', publishedAt: clock.instant.toISOString(), status: 'posted' }
        : { platformPostId: 'post-1', scheduledAt: request.scheduledAt, status: 'scheduled' };
    },
    reconcileAsync: async () => ({ kind: 'unknown' }),
    renewAsync: async () => credential(),
    revokeAsync: async () => undefined,
    validateMediaAsync: async () => undefined,
  };
  const security: FlowSecurityPort = {
    authorizeAsync: async (operation) => {
      if (!approval.granted)
        throw new FlowSecurityError('approval_pending', 'The Flow approval gate is pending.');
      return {
        executeAsync: async (callback) => callback({ 'oauth-ref': credential() }),
        operation: { ...operation, secretRefs: operation.secretRefs ?? [] },
      };
    },
    reconcileAsync: async () => ({
      reconcileAsync: async (callback) => callback({ 'oauth-ref': credential() }),
    }),
    createSecretAsync: async () => {
      throw new Error('Not used.');
    },
    getSecretMetadataAsync: async () => {
      throw new Error('Not used.');
    },
    replaceSecretAsync: async () => {
      throw new Error('Not used.');
    },
    revokeSecretAsync: async () => {
      throw new Error('Not used.');
    },
  };
  const runtime = createFlowRuntime({
    clock: { now: () => clock.instant },
    nodeRegistry: createSocialNodeRegistry({
      actor,
      clock: { now: () => clock.instant },
      outboundTransport: { fetchAsync: async () => new Response() },
      providers: [provider],
      security,
    }),
    persistence: InMemoryFlowPersistenceAdapter(),
    security,
    store: InMemoryFlowRuntimeStore(),
  });
  const definition = socialFlowDefinition();
  await runtime.createDraftAsync({ projectId: 'project', tenantId: 'tenant' }, definition);
  await runtime.publishAsync({ projectId: 'project', tenantId: 'tenant' }, definition.id, 1);
  const run = await runtime.triggerAsync({
    flowId: definition.id,
    idempotencyKey: 'social-headless',
    scope: { projectId: 'project', tenantId: 'tenant' },
    triggerId: 'manual',
  });
  await runtime.runWorkerTickAsync();
  expect(
    (await runtime.getRunAsync({ projectId: 'project', tenantId: 'tenant' }, run.id))?.status,
  ).toBe('waiting_for_approval');
  approval.granted = true;
  for (const _ of [1, 2, 3]) {
    clock.instant = new Date(clock.instant.getTime() + 1_000);
    await runtime.runWorkerTickAsync();
  }
  expect(published).toEqual(['scheduled', 'published']);
  expect(
    (await runtime.getRunAsync({ projectId: 'project', tenantId: 'tenant' }, run.id))?.status,
  ).toBe('succeeded');
  expect(
    (await runtime.readEventsAsync({ projectId: 'project', tenantId: 'tenant' }, 0, run.id)).map(
      (event) => event.type,
    ),
  ).toEqual(['run_queued', 'run_started', 'run_progressed', 'run_progressed', 'run_completed']);
});

test('recovers a SIGKILL social publication from its provider receipt without a second post or permit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flow-social-crash-'));
  const fixture = new URL('./fixtures/socialDurableCrashWorker.ts', import.meta.url).pathname;
  const input = {
    deliveryPath: join(directory, 'provider-deliveries.json'),
    durablePath: join(directory, 'durable.json'),
    permitPath: join(directory, 'security-permits.json'),
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
    expect(output).not.toContain('SENTINEL_SOCIAL_CRASH_TOKEN');
    const result = JSON.parse(recovered.stdout.toString()) as {
      readonly deliveries: readonly string[];
      readonly events: readonly { readonly type: string }[];
      readonly permits: readonly string[];
      readonly receipts: readonly { readonly idempotencyKey: string }[];
      readonly run: {
        readonly status: string;
        readonly steps: readonly { readonly nodeId: string; readonly status: string }[];
      };
    };
    expect(result.deliveries).toHaveLength(1);
    expect(result.permits).toHaveLength(1);
    expect(result.receipts).toEqual([
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:step:publish$/) }),
    ]);
    expect(result.run).toMatchObject({ status: 'succeeded' });
    expect(result.run.steps).toEqual([
      expect.objectContaining({ nodeId: 'publish', status: 'succeeded' }),
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      'run_queued',
      'run_started',
      'run_completed',
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

/** Build the secret-reference-only config accepted by the social graph boundary. */
const config = (extra: Readonly<Record<string, string>> = {}) => ({
  accountId: { kind: 'inline' as const, value: 'page-1' },
  accountType: { kind: 'inline' as const, value: 'page' },
  credential: { kind: 'secret' as const, ref: 'oauth-ref' },
  platform: { kind: 'inline' as const, value: 'meta-facebook' },
  text: { kind: 'inline' as const, value: 'hello' },
  ...Object.fromEntries(
    Object.entries(extra).map(([key, value]) => [key, { kind: 'inline', value }]),
  ),
});

/** Build the published graph exercised through the existing headless runtime and durable worker. */
const socialFlowDefinition = (): FlowDefinition => ({
  edges: [
    {
      id: 'schedule-publish',
      source: { nodeId: 'schedule', portId: 'publication' },
      target: { nodeId: 'publish', portId: 'trigger' },
    },
    {
      id: 'publish-analytics',
      source: { nodeId: 'publish', portId: 'publication' },
      target: { nodeId: 'analytics', portId: 'trigger' },
    },
  ],
  id: 'social-headless',
  nodes: [
    {
      capability: { capabilityId: 'publish', providerId: 'social' },
      config: config({ scheduledAt: '2026-11-14T10:00:00.000Z' }),
      id: 'schedule',
      ports: [{ direction: 'output', id: 'publication', required: true }],
    },
    {
      capability: { capabilityId: 'publish', providerId: 'social' },
      config: config(),
      id: 'publish',
      ports: [
        { direction: 'input', id: 'trigger', required: false },
        { direction: 'output', id: 'publication', required: true },
      ],
    },
    {
      capability: { capabilityId: 'analytics', providerId: 'social' },
      config: config({ platformPostId: 'post-1' }),
      id: 'analytics',
      ports: [
        { direction: 'input', id: 'trigger', required: false },
        { direction: 'output', id: 'analytics', required: true },
      ],
    },
  ],
  title: 'Headless social acceptance',
  triggers: [{ id: 'manual', kind: 'manual' as const }],
  version: 1,
});

/** Create a graph node identity with no provider SDK or credential material. */
const node = (id: string) => ({
  capability: { capabilityId: 'publish', providerId: 'social' },
  id,
  ports: [],
});

/** Supply an approval-bound server permit while keeping token material inside its callback. */
const approvedSecurity = (events: string[]): FlowSecurityPort => ({
  authorizeAsync: async () => ({
    executeAsync: async (callback) => {
      events.push('approved');
      return callback({
        'oauth-ref': credential(),
      });
    },
    operation: {
      actor,
      capability: 'social',
      idempotencyKey: 'key',
      operationId: 'operation',
      secretRefs: ['oauth-ref'],
    },
  }),
  reconcileAsync: async () => ({
    reconcileAsync: async (callback) => callback({ 'oauth-ref': credential() }),
  }),
  createSecretAsync: async () => {
    throw new Error('Not used.');
  },
  getSecretMetadataAsync: async () => {
    throw new Error('Not used.');
  },
  revokeSecretAsync: async () => {
    throw new Error('Not used.');
  },
  replaceSecretAsync: async () => {
    throw new Error('Not used.');
  },
});

/** Supply a server-only OAuth payload bound to one tenant, platform, and Page. */
const credential = (extra: Readonly<Record<string, string>> = {}) => ({
  accountId: 'page-1',
  accountType: 'page',
  platform: 'meta-facebook',
  scopes: 'pages_manage_posts pages_read_engagement pages_show_list',
  tenantId: 'tenant',
  token: 'SENTINEL_TOKEN',
  ...extra,
});

test('rejects a duplicate publish and a failed publish retry before a second provider call', async () => {
  const duplicate = socialFixture();
  await publishAsync(duplicate.registry);
  await expect(publishAsync(duplicate.registry)).rejects.toThrow('SOCIAL_IDEMPOTENCY_CONFLICT');
  expect(duplicate.calls.publish).toBe(1);

  const failing = socialFixture({ publishError: 'SOCIAL_UPLOAD_FAILED' });
  await expect(publishAsync(failing.registry)).rejects.toThrow('SOCIAL_UPLOAD_FAILED');
  await expect(publishAsync(failing.registry)).rejects.toThrow('SOCIAL_IDEMPOTENCY_CONFLICT');
  expect(failing.calls.publish).toBe(1);
});

test('rejects missing scopes, expired credentials, mismatched credential identity, and rejected host peers', async () => {
  const missingScope = socialFixture({
    credential: credential({ scopes: 'pages_read_engagement' }),
  });
  await expect(publishAsync(missingScope.registry)).rejects.toThrow('SOCIAL_SCOPE_MISSING');
  expect(missingScope.calls.publish).toBe(0);

  const expired = socialFixture({
    credential: credential({ expiresAt: '2026-11-14T08:59:59.000Z' }),
  });
  await expect(publishAsync(expired.registry)).rejects.toThrow('SOCIAL_CREDENTIAL_EXPIRED');
  expect(expired.calls.publish).toBe(0);

  const mismatched = socialFixture({ credential: credential({ tenantId: 'other-tenant' }) });
  await expect(publishAsync(mismatched.registry)).rejects.toThrow(
    'SOCIAL_CREDENTIAL_BINDING_INVALID',
  );
  expect(mismatched.calls.publish).toBe(0);

  const rejectedPeer = socialFixture({ transportError: 'HOST_PEER_REJECTED' });
  await expect(publishAsync(rejectedPeer.registry)).rejects.toThrow('HOST_PEER_REJECTED');
  expect(rejectedPeer.calls.transport).toBe(1);
});

test('does not call providers when approval or rate limiting denies the operation', async () => {
  const deniedApproval = socialFixture({ authorizeError: 'FLOW_APPROVAL_REJECTED' });
  await expect(publishAsync(deniedApproval.registry)).rejects.toThrow('FLOW_APPROVAL_REJECTED');
  expect(deniedApproval.calls.publish).toBe(0);

  const rateLimited = socialFixture({ authorizeError: 'FLOW_RATE_LIMITED' });
  await expect(publishAsync(rateLimited.registry)).rejects.toThrow('FLOW_RATE_LIMITED');
  expect(rateLimited.calls.publish).toBe(0);
});

test('uses distinct current LinkedIn member and organization permissions', () => {
  expect(socialCapabilities.linkedin.scopes.member?.publish).toEqual(['w_member_social']);
  expect(socialCapabilities.linkedin.scopes.member?.['analytics:read']).toEqual([
    'r_member_postAnalytics',
  ]);
  expect(socialCapabilities.linkedin.scopes.organization?.publish).toEqual([
    'w_organization_social',
  ]);
  expect(socialCapabilities.linkedin.scopes.organization?.['analytics:read']).toEqual([
    'r_organization_social',
  ]);
});

test('renews and revokes only through the server-owned secret boundary without returning credentials', async () => {
  const fixture = socialFixture();
  const renew = fixture.registry['social:oauth-renew'];
  const revoke = fixture.registry['social:oauth-revoke'];
  if (!renew || !revoke) throw new Error('Expected lifecycle operations.');
  const renewal = await renew.executeAsync({
    config: config(),
    effect: { idempotencyKey: 'renew-1' },
    input: {},
    node: node('renew'),
    signal: new AbortController().signal,
  });
  const revocation = await revoke.executeAsync({
    config: config(),
    effect: { idempotencyKey: 'revoke-1' },
    input: {},
    node: node('revoke'),
    signal: new AbortController().signal,
  });
  expect(fixture.calls).toMatchObject({ renew: 1, replace: 1, revoke: 1, remove: 1, transport: 2 });
  expect(JSON.stringify([renewal, revocation, fixture.audit])).not.toContain('SENTINEL_TOKEN');
  expect(renewal.output?.lifecycle).toEqual({ kind: 'inline', value: { status: 'renewed' } });
  expect(revocation.output?.lifecycle).toEqual({ kind: 'inline', value: { status: 'revoked' } });
});

test('rejects a renewed credential with a different tenant binding before secret replacement', async () => {
  const fixture = socialFixture({
    renewedCredential: credential({ tenantId: 'other-tenant', token: 'SENTINEL_UNBOUND_TOKEN' }),
  });
  const renew = fixture.registry['social:oauth-renew'];
  if (!renew) throw new Error('Expected a renewal operation.');
  await expect(
    renew.executeAsync({
      config: config(),
      effect: { idempotencyKey: 'renew-unbound' },
      input: {},
      node: node('renew-unbound'),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('SOCIAL_CREDENTIAL_BINDING_INVALID');
  expect(fixture.calls).toMatchObject({ renew: 1, replace: 0 });
  expect(JSON.stringify(fixture.audit)).not.toContain('SENTINEL_UNBOUND_TOKEN');
});

test('rejects spoofed receipt kinds before credential mutation or provider replay', async () => {
  for (const [operationId, receipt] of [
    ['social:publish', { kind: 'oauth-revoke' }],
    ['social:oauth-revoke', { kind: 'oauth-renew', credential: credential() }],
  ] as const) {
    const fixture = socialFixture({ receipt });
    await expect(reconcileSocialAsync(fixture.registry, operationId)).rejects.toThrow(
      'SOCIAL_RECEIPT_KIND_INVALID',
    );
    expect(fixture.calls).toMatchObject({ publish: 0, remove: 0, replace: 0, renew: 0, revoke: 0 });
    expect(JSON.stringify(fixture.audit)).not.toContain('SENTINEL_TOKEN');
  }
});

test('rejects receipt-renewed credentials that violate trusted binding or scopes', async () => {
  for (const [name, renewedCredential, error] of [
    [
      'tenant',
      credential({ tenantId: 'other-tenant', token: 'SENTINEL_RECEIPT_TENANT' }),
      'SOCIAL_CREDENTIAL_BINDING_INVALID',
    ],
    [
      'platform',
      credential({ platform: 'linkedin', token: 'SENTINEL_RECEIPT_PLATFORM' }),
      'SOCIAL_CREDENTIAL_BINDING_INVALID',
    ],
    [
      'account',
      credential({ accountId: 'other-page', token: 'SENTINEL_RECEIPT_ACCOUNT' }),
      'SOCIAL_CREDENTIAL_BINDING_INVALID',
    ],
    [
      'account type',
      credential({ accountType: 'profile', token: 'SENTINEL_RECEIPT_ACCOUNT_TYPE' }),
      'SOCIAL_CREDENTIAL_BINDING_INVALID',
    ],
    [
      'scopes',
      credential({ scopes: 'pages_read_engagement', token: 'SENTINEL_RECEIPT_SCOPES' }),
      'SOCIAL_SCOPE_MISSING',
    ],
  ] as const) {
    const fixture = socialFixture({
      receipt: { credential: renewedCredential, kind: 'oauth-renew' },
    });
    await expect(
      reconcileSocialAsync(fixture.registry, 'social:oauth-renew'),
      name,
    ).rejects.toThrow(error);
    expect(fixture.calls).toMatchObject({ publish: 0, remove: 0, replace: 0, renew: 0, revoke: 0 });
    expect(JSON.stringify(fixture.audit)).not.toContain('SENTINEL_RECEIPT');
  }
});

/** Exercise the optional SDK-free boundary with a provider that can only reach the host transport. */
const socialFixture = (
  options: {
    readonly authorizeError?: string;
    readonly credential?: Readonly<Record<string, string>>;
    readonly publishError?: string;
    readonly receipt?: SocialProviderReceipt;
    readonly renewedCredential?: Readonly<Record<string, string>>;
    readonly transportError?: string;
  } = {},
) => {
  const calls = { publish: 0, remove: 0, renew: 0, replace: 0, revoke: 0, transport: 0 };
  const audit: unknown[] = [];
  const claimed = new Set<string>();
  const provider: SocialProviderPort = {
    allowedCapabilities: ['analytics:read', 'oauth:renew', 'oauth:revoke', 'publish', 'schedule'],
    allowedHosts: ['mock.social.test'],
    endpoint: 'https://mock.social.test/v1',
    fetchAnalyticsAsync: async ({ outboundTransport }) => {
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/analytics',
      });
      return {
        metrics: {},
        observedAt: '2026-11-14T10:00:00.000Z',
        platformPostId: 'post-1',
        provenance: {
          accountId: 'page-1',
          platform: 'meta-facebook',
          provider: 'mock',
          source: 'mock',
        },
      };
    },
    platform: 'meta-facebook',
    publishAsync: async ({ outboundTransport }) => {
      calls.publish += 1;
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/publish',
      });
      if (options.publishError) throw new Error(options.publishError);
      return { platformPostId: 'post-1', status: 'posted' as const };
    },
    reconcileAsync: async () => options.receipt ?? { kind: 'unknown' },
    renewAsync: async ({ outboundTransport }) => {
      calls.renew += 1;
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/renew',
      });
      return options.renewedCredential ?? credential({ token: 'SENTINEL_RENEWED_TOKEN' });
    },
    revokeAsync: async ({ outboundTransport }) => {
      calls.revoke += 1;
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/revoke',
      });
    },
    validateMediaAsync: async () => undefined,
  };
  const security: FlowSecurityPort = {
    authorizeAsync: async (operation) => {
      if (options.authorizeError) throw new Error(options.authorizeError);
      if (claimed.has(operation.idempotencyKey)) throw new Error('SOCIAL_IDEMPOTENCY_CONFLICT');
      claimed.add(operation.idempotencyKey);
      return {
        executeAsync: async (callback) =>
          callback({ 'oauth-ref': options.credential ?? credential() }),
        operation: {
          actor,
          capability: operation.capability,
          idempotencyKey: operation.idempotencyKey,
          operationId: operation.operationId,
          secretRefs: ['oauth-ref'],
          ...(operation.target ? { target: operation.target } : {}),
        },
      };
    },
    reconcileAsync: async () => ({
      reconcileAsync: async (callback) =>
        callback({ 'oauth-ref': options.credential ?? credential() }),
    }),
    createSecretAsync: async () => {
      throw new Error('Not used.');
    },
    getSecretMetadataAsync: async () => {
      throw new Error('Not used.');
    },
    replaceSecretAsync: async ({ payload }) => {
      calls.replace += 1;
      audit.push({ event: 'replace', payloadFields: Object.keys(payload) });
      return {
        configuredFields: Object.keys(payload),
        kind: 'token',
        ref: 'oauth-ref',
        scope: { environment: 'test', projectId: 'project' },
        createdAt: 'now',
        updatedAt: 'now',
      };
    },
    revokeSecretAsync: async () => {
      calls.remove += 1;
      audit.push({ event: 'remove', ref: 'oauth-ref' });
    },
  };
  return {
    audit,
    calls,
    registry: createSocialNodeRegistry({
      actor,
      clock: { now: () => new Date('2026-11-14T09:00:00.000Z') },
      outboundTransport: {
        fetchAsync: async ({ allowedHosts, url }) => {
          calls.transport += 1;
          expect(allowedHosts).toEqual(['mock.social.test']);
          expect(url).toContain('mock.social.test');
          if (options.transportError) throw new Error(options.transportError);
          return new Response();
        },
      },
      providers: [provider],
      security,
    }),
  };
};

/** Run the public publishing operation through its graph-shaped input boundary. */
const publishAsync = async (registry: ReturnType<typeof createSocialNodeRegistry>) => {
  const publish = registry['social:publish'];
  if (!publish) throw new Error('Expected a publishing operation.');
  return publish.executeAsync({
    config: config(),
    effect: { idempotencyKey: 'publish-1' },
    input: { media: { artifactId: 'asset-1', kind: 'artifact', mediaType: 'image/jpeg' } },
    node: node('publish'),
    signal: new AbortController().signal,
  });
};

/** Ask the public social recovery boundary to reconstruct one completed protected operation. */
const reconcileSocialAsync = async (
  registry: ReturnType<typeof createSocialNodeRegistry>,
  operationId: 'social:oauth-renew' | 'social:oauth-revoke' | 'social:publish',
) => {
  const operation = registry[operationId];
  if (operation?.reconcileAsync === undefined) throw new Error('Expected social reconciliation.');
  return operation.reconcileAsync({
    config: config(),
    effect: { idempotencyKey: `recover-${operationId}` },
    input: {},
    node: node('recover'),
    secrets: { 'oauth-ref': credential() },
  });
};
