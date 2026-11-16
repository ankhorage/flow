import type { FlowNodeConfig } from '@ankhorage/contracts/flow';

import type {
  FlowNodeOperation,
  FlowNodeOperationResult,
  FlowNodeRegistry,
} from '../../../types/execution.js';
import type { FlowResolvedSecrets, FlowSecurityOperation } from '../../../types/security.js';
import type {
  SocialCapability,
  SocialNodeRegistryDependencies,
  SocialPlatform,
  SocialProviderPort,
} from '../../../types/social.js';
import { validateSocialAuthorization } from '../domain/validateSocialAuthorization.js';
import type { SocialConfig } from './createSocialConfigReader.js';
import { createSocialConfigReader } from './createSocialConfigReader.js';
import { executeSocialOauthAsync } from './executeSocialOauthAsync.js';
import { reconcileSocialReceiptAsync } from './reconcileSocialReceiptAsync.js';

/** Create optional, SDK-free social publish, OAuth lifecycle, and analytics node operations. */
export const createSocialNodeRegistry = (
  dependencies: SocialNodeRegistryDependencies,
): FlowNodeRegistry => ({
  'social:analytics': {
    effect: socialOperationEffect(dependencies, 'analytics:read'),
    executeAsync: executeAnalyticsAsync(dependencies),
    reconcileAsync: reconcileSocialAsync(dependencies, 'analytics:read'),
  },
  'social:publish': {
    effect: socialOperationEffect(dependencies, socialConfig.publishCapability),
    executeAsync: executePublishAsync(dependencies),
    reconcileAsync: reconcileSocialAsync(dependencies, socialConfig.publishCapability),
  },
  'social:oauth-renew': {
    effect: socialOperationEffect(dependencies, 'oauth:renew'),
    executeAsync: async ({ config, effect, node, secrets }) => {
      await executeSocialOauthAsync({
        capability: 'oauth:renew',
        dependencies,
        effect,
        nodeId: node.id,
        request: socialConfig.common(config),
        ...(secrets === undefined ? {} : { secrets }),
      });
      return { output: { lifecycle: { kind: 'inline', value: { status: 'renewed' } } } };
    },
    reconcileAsync: reconcileSocialAsync(dependencies, 'oauth:renew'),
  },
  'social:oauth-revoke': {
    effect: socialOperationEffect(dependencies, 'oauth:revoke'),
    executeAsync: async ({ config, effect, node, secrets }) => {
      await executeSocialOauthAsync({
        capability: 'oauth:revoke',
        dependencies,
        effect,
        nodeId: node.id,
        request: socialConfig.common(config),
        ...(secrets === undefined ? {} : { secrets }),
      });
      return { output: { lifecycle: { kind: 'inline', value: { status: 'revoked' } } } };
    },
    reconcileAsync: reconcileSocialAsync(dependencies, 'oauth:revoke'),
  },
});
const socialConfig = createSocialConfigReader();

/** Bind every provider-facing social operation to the canonical durable security operation. */
const socialOperationEffect = (
  dependencies: SocialNodeRegistryDependencies,
  capability: SocialCapability | ((config: FlowNodeConfig | undefined) => SocialCapability),
): FlowNodeOperation['effect'] => ({
  createSecurityOperation: ({ effect, node }) =>
    securityOperationOf(
      dependencies,
      node,
      effect.idempotencyKey,
      typeof capability === 'function' ? capability(node.config) : capability,
    ),
  kind: 'protected',
});

/** Build the protected publishing operation, including media validation and future scheduling. */
const executePublishAsync =
  (dependencies: SocialNodeRegistryDependencies): FlowNodeOperation['executeAsync'] =>
  async ({ config, effect, input, node, secrets, signal }) => {
    const request = socialConfig.publish(config, input);
    const provider = providerOf(dependencies.providers, request.platform);
    assertCapability(provider, request.platform, request.scheduledAt ? 'schedule' : 'publish');
    const publication = await withSocialSecretsAsync(
      dependencies,
      securityOperationOf(
        dependencies,
        { ...node, config },
        effect.idempotencyKey,
        socialConfig.publishCapability(config),
      ),
      secrets,
      async (resolved) => {
        const authorization = authorizationOf(
          dependencies,
          request,
          resolved[request.credentialRef],
          request.scheduledAt ? 'schedule' : 'publish',
        );
        await provider.validateMediaAsync({ authorization, media: request.media });
        return provider.publishAsync({
          authorization,
          outboundTransport: dependencies.outboundTransport,
          request: {
            accountId: request.accountId,
            idempotencyKey: effect.idempotencyKey,
            media: request.media,
            ...(request.scheduledAt ? { scheduledAt: request.scheduledAt } : {}),
            text: request.text,
          },
          signal,
        });
      },
    );
    return { output: { publication: { kind: 'inline', value: publicationValue(publication) } } };
  };

/** Build the protected analytics operation with source and account provenance intact. */
const executeAnalyticsAsync =
  (dependencies: SocialNodeRegistryDependencies): FlowNodeOperation['executeAsync'] =>
  async ({ config, effect, node, secrets, signal }) => {
    const request = socialConfig.analytics(config);
    const provider = providerOf(dependencies.providers, request.platform);
    assertCapability(provider, request.platform, 'analytics:read');
    const analytics = await withSocialSecretsAsync(
      dependencies,
      securityOperationOf(
        dependencies,
        { ...node, config },
        effect.idempotencyKey,
        'analytics:read',
      ),
      secrets,
      async (resolved) => {
        const authorization = authorizationOf(
          dependencies,
          request,
          resolved[request.credentialRef],
          'analytics:read',
        );
        return provider.fetchAnalyticsAsync({
          authorization,
          outboundTransport: dependencies.outboundTransport,
          platformPostId: request.platformPostId,
          signal,
        });
      },
    );
    return { output: { analytics: { kind: 'inline', value: analyticsValue(analytics) } } };
  };

/** Reconstruct a social result from a provider receipt under the canonical recovery permit. */
const reconcileSocialAsync =
  (
    dependencies: SocialNodeRegistryDependencies,
    capability: SocialCapability | ((config: FlowNodeConfig | undefined) => SocialCapability),
  ): NonNullable<FlowNodeOperation['reconcileAsync']> =>
  async ({ config, effect, secrets }): Promise<FlowNodeOperationResult | 'unknown'> => {
    if (secrets === undefined) throw new Error('FLOW_SOCIAL_RECONCILIATION_SECRETS_REQUIRED');
    const request = socialConfig.common(config);
    const resolvedCapability = typeof capability === 'function' ? capability(config) : capability;
    const provider = providerOf(dependencies.providers, request.platform);
    const authorization = authorizationOf(
      dependencies,
      request,
      secrets[request.credentialRef],
      resolvedCapability,
    );
    const receipt = await provider.reconcileAsync({
      authorization,
      capability: resolvedCapability,
      idempotencyKey: effect.idempotencyKey,
      outboundTransport: dependencies.outboundTransport,
    });
    if (receipt.kind === 'unknown') return 'unknown';
    return reconcileSocialReceiptAsync({
      capability: resolvedCapability,
      dependencies,
      receipt,
      request,
    });
  };

/** Resolve secrets through exactly one permit: the worker's durable permit or a direct executor permit. */
const withSocialSecretsAsync = async <T>(
  dependencies: SocialNodeRegistryDependencies,
  operation: FlowSecurityOperation,
  secrets: FlowResolvedSecrets | undefined,
  callback: (secrets: FlowResolvedSecrets) => Promise<T>,
): Promise<T> =>
  secrets === undefined
    ? (await dependencies.security.authorizeAsync(operation)).executeAsync(callback)
    : callback(secrets);

/** Create the exact approval, tenant, secret, host, and idempotency identity once for every social effect. */
const securityOperationOf = (
  dependencies: SocialNodeRegistryDependencies,
  node: { readonly config?: FlowNodeConfig; readonly id: string },
  idempotencyKey: string,
  capability: SocialCapability,
): FlowSecurityOperation => {
  const request = socialConfig.common(node.config);
  const provider = providerOf(dependencies.providers, request.platform);
  assertCapability(provider, request.platform, capability);
  return {
    actor: dependencies.actor,
    capability: `social:${request.platform}:${capability}`,
    idempotencyKey,
    operationId: idempotencyKey,
    secretRefs: [request.credentialRef],
    target: { allowedHosts: provider.allowedHosts, url: provider.endpoint },
  };
};

/** Resolve exactly one registered platform adapter. */
const providerOf = (
  providers: readonly SocialProviderPort[],
  platform: SocialPlatform,
): SocialProviderPort => {
  const provider = providers.find((candidate) => candidate.platform === platform);
  if (!provider) throw new Error(`SOCIAL_PROVIDER_UNSUPPORTED:${platform}`);
  return provider;
};

/** Enforce that an adapter cannot silently claim a capability not permitted for its platform. */
const assertCapability = (
  provider: SocialProviderPort,
  platform: SocialPlatform,
  capability: SocialCapability,
): void => {
  if (!provider.allowedCapabilities.includes(capability))
    throw new Error(`SOCIAL_CAPABILITY_UNSUPPORTED:${platform}:${capability}`);
};

/** Construct an authorization boundary only inside the one-use security permit callback. */
const authorizationOf = (
  dependencies: SocialNodeRegistryDependencies,
  request: SocialConfig,
  credential: Readonly<Record<string, string>> | undefined,
  capability: SocialCapability,
) =>
  validateSocialAuthorization({
    accountId: request.accountId,
    accountType: request.accountType,
    actor: dependencies.actor,
    capability,
    credential,
    now: dependencies.clock.now(),
    platform: request.platform,
  });

/** Convert a provider publication response to the portable serializable Flow data contract. */
const publicationValue = (publication: {
  readonly platformPostId: string;
  readonly publishedAt?: string;
  readonly scheduledAt?: string;
  readonly status: 'posted' | 'scheduled';
}) => ({
  platformPostId: publication.platformPostId,
  ...(publication.publishedAt ? { publishedAt: publication.publishedAt } : {}),
  ...(publication.scheduledAt ? { scheduledAt: publication.scheduledAt } : {}),
  status: publication.status,
});

/** Convert analytics to portable values while preserving provider, platform, account, and source provenance. */
const analyticsValue = (analytics: {
  readonly metrics: Readonly<Record<string, number>>;
  readonly observedAt: string;
  readonly platformPostId: string;
  readonly provenance: {
    readonly accountId: string;
    readonly platform: SocialPlatform;
    readonly provider: string;
    readonly source: string;
  };
}) => ({
  metrics: { ...analytics.metrics },
  observedAt: analytics.observedAt,
  platformPostId: analytics.platformPostId,
  provenance: { ...analytics.provenance },
});
