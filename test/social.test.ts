import { expect, test } from 'bun:test';

import { createSocialNodeRegistry } from '../src/social.js';
import type { SocialProviderPort } from '../src/social.js';
import type { FlowSecurityPort } from '../src/types/security.js';

const actor = { environment: 'test', id: 'author', projectId: 'project', tenantId: 'tenant' };

test('executes the approved Draft to Scheduled to Posted to Analytics mock-provider flow', async () => {
  const events: string[] = ['draft'];
  const provider: SocialProviderPort = {
    allowedCapabilities: ['analytics:read', 'oauth:renew', 'oauth:revoke', 'publish', 'schedule'],
    allowedHosts: ['mock.social.test'],
    fetchAnalyticsAsync: async ({ platformPostId }) => ({
      metrics: { impressions: 7 },
      observedAt: '2026-11-14T10:01:00.000Z',
      platformPostId,
      provenance: {
        accountId: 'page-1',
        platform: 'meta-facebook',
        provider: 'mock',
        source: 'mock-api',
      },
    }),
    platform: 'meta-facebook',
    publishAsync: async ({ request }) => {
      events.push(request.scheduledAt ? 'scheduled' : 'posted');
      return request.scheduledAt
        ? { platformPostId: 'post-1', scheduledAt: request.scheduledAt, status: 'scheduled' }
        : { platformPostId: 'post-1', publishedAt: '2026-11-14T10:00:00.000Z', status: 'posted' };
    },
    renewAsync: async () => undefined,
    revokeAsync: async () => undefined,
    validateMediaAsync: async () => undefined,
  };
  const registry = createSocialNodeRegistry({
    actor,
    clock: { now: () => new Date('2026-11-14T09:00:00.000Z') },
    providers: [provider],
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
  expect(events).toEqual(['draft', 'approved', 'scheduled', 'approved', 'posted', 'approved']);
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
        'oauth-ref': { scopes: 'pages_manage_posts pages_read_engagement pages_show_list' },
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
});
