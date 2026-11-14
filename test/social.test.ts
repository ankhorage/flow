import { expect, test } from 'bun:test';

import { createSocialNodeRegistry, socialCapabilities } from '../src/social.js';
import type { SocialProviderPort } from '../src/social.js';
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
    input: { media: { artifactId: 'asset-1', kind: 'artifact', mediaType: 'image/jpeg' } },
    node: node('schedule'),
    signal: new AbortController().signal,
  });
  await publish.executeAsync({
    config: config(),
    input: { media: { artifactId: 'asset-1', kind: 'artifact', mediaType: 'image/jpeg' } },
    node: node('post'),
    signal: new AbortController().signal,
  });
  const result = await analytics.executeAsync({
    config: config({ platformPostId: 'post-1' }),
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

/** Build the secret-reference-only config accepted by the social graph boundary. */
const config = (extra: Readonly<Record<string, string>> = {}) => ({
  accountId: { kind: 'inline' as const, value: 'page-1' },
  accountType: { kind: 'inline' as const, value: 'page' },
  credential: { kind: 'secret' as const, ref: 'oauth-ref' },
  idempotencyKey: { kind: 'inline' as const, value: 'publish-1' },
  platform: { kind: 'inline' as const, value: 'meta-facebook' },
  text: { kind: 'inline' as const, value: 'hello' },
  ...Object.fromEntries(
    Object.entries(extra).map(([key, value]) => [key, { kind: 'inline', value }]),
  ),
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
    config: config({ idempotencyKey: 'renew-1' }),
    input: {},
    node: node('renew'),
    signal: new AbortController().signal,
  });
  const revocation = await revoke.executeAsync({
    config: config({ idempotencyKey: 'revoke-1' }),
    input: {},
    node: node('revoke'),
    signal: new AbortController().signal,
  });
  expect(fixture.calls).toMatchObject({ renew: 1, replace: 1, revoke: 1, remove: 1, transport: 2 });
  expect(JSON.stringify([renewal, revocation, fixture.audit])).not.toContain('SENTINEL_TOKEN');
  expect(renewal.output?.lifecycle).toEqual({ kind: 'inline', value: { status: 'renewed' } });
  expect(revocation.output?.lifecycle).toEqual({ kind: 'inline', value: { status: 'revoked' } });
});

/** Exercise the optional SDK-free boundary with a provider that can only reach the host transport. */
const socialFixture = (
  options: {
    readonly authorizeError?: string;
    readonly credential?: Readonly<Record<string, string>>;
    readonly publishError?: string;
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
    renewAsync: async ({ outboundTransport }) => {
      calls.renew += 1;
      await outboundTransport.fetchAsync({
        allowedHosts: ['mock.social.test'],
        url: 'https://mock.social.test/v1/renew',
      });
      return credential({ token: 'SENTINEL_RENEWED_TOKEN' });
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
    input: { media: { artifactId: 'asset-1', kind: 'artifact', mediaType: 'image/jpeg' } },
    node: node('publish'),
    signal: new AbortController().signal,
  });
};
