import type { FlowDataRef, FlowNodeConfig, FlowNodeConfigValue } from '@ankhorage/contracts/flow';

import type { FlowNodeOperation, FlowNodeRegistry } from '../../../types/execution.js';
import type {
  SocialAuthorization,
  SocialCapability,
  SocialMedia,
  SocialNodeRegistryDependencies,
  SocialPlatform,
  SocialProviderPort,
} from '../../../types/social.js';
import { socialAccountTypesOf, socialScopesOf } from '../domain/socialScopesOf.js';

/** Create optional, SDK-free social publish, OAuth lifecycle, and analytics node operations. */
export const createSocialNodeRegistry = (
  dependencies: SocialNodeRegistryDependencies,
): FlowNodeRegistry => ({
  'social:analytics': { executeAsync: executeAnalyticsAsync(dependencies) },
  'social:publish': { executeAsync: executePublishAsync(dependencies) },
  'social:oauth-renew': {
    executeAsync: async ({ config, node }) =>
      executeOauthAsync(dependencies, config, node.id, 'oauth:renew'),
  },
  'social:oauth-revoke': {
    executeAsync: async ({ config, node }) =>
      executeOauthAsync(dependencies, config, node.id, 'oauth:revoke'),
  },
});

/** Build the protected publishing operation, including media validation and future scheduling. */
const executePublishAsync =
  (dependencies: SocialNodeRegistryDependencies): FlowNodeOperation['executeAsync'] =>
  async ({ config, input, node, signal }) => {
    const request = readPublishConfig(config, input);
    const provider = providerOf(dependencies.providers, request.platform);
    assertCapability(provider, request.platform, request.scheduledAt ? 'schedule' : 'publish');
    const permit = await dependencies.security.authorizeAsync({
      actor: dependencies.actor,
      capability: `social:${request.platform}:${request.scheduledAt ? 'schedule' : 'publish'}`,
      idempotencyKey: request.idempotencyKey,
      operationId: `social:${node.id}:${request.idempotencyKey}`,
      secretRefs: [request.credentialRef],
      target: {
        allowedHosts: provider.allowedHosts,
        url: `https://${provider.allowedHosts[0] ?? 'invalid'}`,
      },
    });
    const publication = await permit.executeAsync(async (secrets) => {
      const authorization = authorizationOf(request, secrets[request.credentialRef]);
      assertAuthorization(
        provider,
        authorization,
        request.platform,
        request.scheduledAt ? 'schedule' : 'publish',
      );
      await provider.validateMediaAsync({ authorization, media: request.media });
      return provider.publishAsync({
        authorization,
        request: {
          accountId: request.accountId,
          idempotencyKey: request.idempotencyKey,
          media: request.media,
          ...(request.scheduledAt ? { scheduledAt: request.scheduledAt } : {}),
          text: request.text,
        },
        signal,
      });
    });
    return { output: { publication: { kind: 'inline', value: publicationValue(publication) } } };
  };

/** Build the protected analytics operation with source and account provenance intact. */
const executeAnalyticsAsync =
  (dependencies: SocialNodeRegistryDependencies): FlowNodeOperation['executeAsync'] =>
  async ({ config, node, signal }) => {
    const request = readAnalyticsConfig(config);
    const provider = providerOf(dependencies.providers, request.platform);
    assertCapability(provider, request.platform, 'analytics:read');
    const permit = await dependencies.security.authorizeAsync({
      actor: dependencies.actor,
      capability: `social:${request.platform}:analytics:read`,
      idempotencyKey: request.idempotencyKey,
      operationId: `social:${node.id}:${request.idempotencyKey}`,
      secretRefs: [request.credentialRef],
      target: {
        allowedHosts: provider.allowedHosts,
        url: `https://${provider.allowedHosts[0] ?? 'invalid'}`,
      },
    });
    const analytics = await permit.executeAsync(async (secrets) => {
      const authorization = authorizationOf(request, secrets[request.credentialRef]);
      assertAuthorization(provider, authorization, request.platform, 'analytics:read');
      return provider.fetchAnalyticsAsync({
        authorization,
        platformPostId: request.platformPostId,
        signal,
      });
    });
    return { output: { analytics: { kind: 'inline', value: analyticsValue(analytics) } } };
  };

/** Authorize a token lifecycle operation and deliberately emit no credential data. */
const executeOauthAsync = async (
  dependencies: SocialNodeRegistryDependencies,
  config: FlowNodeConfig | undefined,
  nodeId: string,
  capability: Extract<SocialCapability, 'oauth:renew' | 'oauth:revoke'>,
) => {
  const request = readOauthConfig(config);
  const provider = providerOf(dependencies.providers, request.platform);
  assertCapability(provider, request.platform, capability);
  const permit = await dependencies.security.authorizeAsync({
    actor: dependencies.actor,
    capability: `social:${request.platform}:${capability}`,
    idempotencyKey: request.idempotencyKey,
    operationId: `social:${nodeId}:${request.idempotencyKey}`,
    secretRefs: [request.credentialRef],
    target: {
      allowedHosts: provider.allowedHosts,
      url: `https://${provider.allowedHosts[0] ?? 'invalid'}`,
    },
  });
  await permit.executeAsync(async (secrets) => {
    const authorization = authorizationOf(request, secrets[request.credentialRef]);
    assertAuthorization(provider, authorization, request.platform, capability);
    return capability === 'oauth:renew'
      ? provider.renewAsync({ authorization })
      : provider.revokeAsync({ authorization });
  });
  return {
    output: {
      lifecycle: {
        kind: 'inline' as const,
        value: { status: capability === 'oauth:renew' ? 'renewed' : 'revoked' },
      },
    },
  };
};

interface SocialConfig {
  readonly accountId: string;
  readonly accountType: string;
  readonly credentialRef: string;
  readonly idempotencyKey: string;
  readonly platform: SocialPlatform;
}

/** Read common graph configuration while rejecting raw OAuth data and unknown platforms. */
const readSocialConfig = (config: FlowNodeConfig | undefined): SocialConfig => ({
  accountId: stringConfig(config, 'accountId'),
  accountType: stringConfig(config, 'accountType'),
  credentialRef: secretConfig(config, 'credential'),
  idempotencyKey: stringConfig(config, 'idempotencyKey'),
  platform: platformConfig(config),
});

/** Read publication-specific configuration and optional artifact metadata from the input edge. */
const readPublishConfig = (
  config: FlowNodeConfig | undefined,
  input: Readonly<Record<string, FlowDataRef>>,
): SocialConfig & {
  readonly media: readonly SocialMedia[];
  readonly scheduledAt?: string;
  readonly text: string;
} => ({
  ...readSocialConfig(config),
  media: mediaOf(input.media),
  ...(optionalStringConfig(config, 'scheduledAt')
    ? { scheduledAt: optionalStringConfig(config, 'scheduledAt') }
    : {}),
  text: stringConfig(config, 'text'),
});

/** Read the immutable post identifier used to retrieve normalized analytics. */
const readAnalyticsConfig = (config: FlowNodeConfig | undefined) => ({
  ...readSocialConfig(config),
  platformPostId: stringConfig(config, 'platformPostId'),
});

/** Read the minimal configuration shared by token renewal and revocation. */
const readOauthConfig = (config: FlowNodeConfig | undefined) => readSocialConfig(config);

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

/** Validate the OAuth discovery result before any provider side effect. */
const assertAuthorization = (
  provider: SocialProviderPort,
  authorization: SocialAuthorization,
  platform: SocialPlatform,
  capability: SocialCapability,
): void => {
  if (!socialAccountTypesOf(platform).includes(authorization.accountType))
    throw new Error(`SOCIAL_ACCOUNT_UNSUPPORTED:${platform}`);
  const missing = socialScopesOf(platform, capability).filter(
    (scope) => !authorization.grantedScopes.includes(scope),
  );
  if (missing.length > 0) throw new Error(`SOCIAL_SCOPE_MISSING:${platform}:${missing.join(',')}`);
  if (provider.platform !== platform) throw new Error(`SOCIAL_PROVIDER_UNSUPPORTED:${platform}`);
};

/** Construct an authorization boundary only inside the one-use security permit callback. */
const authorizationOf = (
  request: SocialConfig,
  credential: Readonly<Record<string, string>> | undefined,
): SocialAuthorization => {
  if (!credential) throw new Error('SOCIAL_CREDENTIAL_UNAVAILABLE');
  return {
    accountId: request.accountId,
    accountType: request.accountType,
    credential,
    grantedScopes: (credential.scopes ?? '').split(' ').filter(Boolean),
  };
};

/** Convert a declared artifact input to media metadata without reading its bytes in the graph engine. */
const mediaOf = (value: FlowDataRef | undefined): readonly SocialMedia[] => {
  if (!value) return [];
  if (value.kind !== 'artifact' || !value.mediaType) throw new Error('SOCIAL_MEDIA_INVALID');
  return [
    { byteLength: value.byteLength ?? 0, mediaType: value.mediaType, source: value.artifactId },
  ];
};

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

/** Read an inline string configuration value, never a secret or untyped literal. */
const stringConfig = (config: FlowNodeConfig | undefined, key: SocialConfigKey): string => {
  const value = configValue(config, key);
  if (value?.kind !== 'inline' || typeof value.value !== 'string' || value.value.length === 0)
    throw new Error(`SOCIAL_CONFIG_INVALID:${key}`);
  return value.value;
};

/** Read an optional inline string without treating a missing value as a historical fallback. */
const optionalStringConfig = (
  config: FlowNodeConfig | undefined,
  key: SocialConfigKey,
): string | undefined => {
  const value = configValue(config, key);
  if (value === undefined) return undefined;
  return stringConfig(config, key);
};

/** Require a server-held secret reference at credential positions. */
const secretConfig = (config: FlowNodeConfig | undefined, key: SocialConfigKey): string => {
  const value = configValue(config, key);
  if (value?.kind !== 'secret') throw new Error(`SOCIAL_CREDENTIAL_INVALID:${key}`);
  return value.ref;
};

type SocialConfigKey =
  | 'accountId'
  | 'accountType'
  | 'credential'
  | 'idempotencyKey'
  | 'platform'
  | 'platformPostId'
  | 'scheduledAt'
  | 'text';

/** Read only known social keys instead of reflecting arbitrary graph configuration. */
const configValue = (
  config: FlowNodeConfig | undefined,
  key: SocialConfigKey,
): FlowNodeConfigValue | undefined => {
  switch (key) {
    case 'accountId':
      return config?.accountId;
    case 'accountType':
      return config?.accountType;
    case 'credential':
      return config?.credential;
    case 'idempotencyKey':
      return config?.idempotencyKey;
    case 'platform':
      return config?.platform;
    case 'platformPostId':
      return config?.platformPostId;
    case 'scheduledAt':
      return config?.scheduledAt;
    case 'text':
      return config?.text;
  }
};

/** Narrow an explicitly supported platform from JSON configuration. */
const platformConfig = (config: FlowNodeConfig | undefined): SocialPlatform => {
  const platform = stringConfig(config, 'platform');
  if (!['meta-facebook', 'meta-instagram', 'linkedin'].includes(platform))
    throw new Error(`SOCIAL_PLATFORM_UNSUPPORTED:${platform}`);
  return platform as SocialPlatform;
};
