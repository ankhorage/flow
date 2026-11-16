import type { FlowDataRef, FlowNodeConfig, FlowNodeConfigValue } from '@ankhorage/contracts/flow';

import type { SocialCapability, SocialMedia, SocialPlatform } from '../../../types/social.js';

/** Create the closed social graph-configuration reader shared by protected execution and classification. */
export const createSocialConfigReader = () => ({
  analytics: (config: FlowNodeConfig | undefined) => ({
    ...common(config),
    platformPostId: stringConfig(config, 'platformPostId'),
  }),
  common,
  publish: (config: FlowNodeConfig | undefined, input: Readonly<Record<string, FlowDataRef>>) => ({
    ...common(config),
    media: mediaOf(input.media),
    ...(optionalStringConfig(config, 'scheduledAt')
      ? { scheduledAt: optionalStringConfig(config, 'scheduledAt') }
      : {}),
    text: stringConfig(config, 'text'),
  }),
  publishCapability: (config: FlowNodeConfig | undefined): SocialCapability =>
    optionalStringConfig(config, 'scheduledAt') ? 'schedule' : 'publish',
});

export interface SocialConfig {
  readonly accountId: string;
  readonly accountType: string;
  readonly credentialRef: string;
  readonly platform: SocialPlatform;
}

/** Read common graph configuration while rejecting raw OAuth data and unknown platforms. */
const common = (config: FlowNodeConfig | undefined): SocialConfig => ({
  accountId: stringConfig(config, 'accountId'),
  accountType: stringConfig(config, 'accountType'),
  credentialRef: secretConfig(config, 'credential'),
  platform: platformConfig(config),
});

/** Convert a declared artifact input to media metadata without reading its bytes in the graph engine. */
const mediaOf = (value: FlowDataRef | undefined): readonly SocialMedia[] => {
  if (!value) return [];
  if (value.kind !== 'artifact' || !value.mediaType) throw new Error('SOCIAL_MEDIA_INVALID');
  return [
    { byteLength: value.byteLength ?? 0, mediaType: value.mediaType, source: value.artifactId },
  ];
};

/** Read an inline string configuration value, never a secret or untyped literal. */
const stringConfig = (config: FlowNodeConfig | undefined, key: SocialConfigKey): string => {
  const value = configValue(config, key);
  if (value?.kind !== 'inline' || typeof value.value !== 'string' || value.value.length === 0)
    throw new Error(`SOCIAL_CONFIG_INVALID:${key}`);
  return value.value;
};

/** Read an optional inline string without treating a missing value as a historical fallback. */
const optionalStringConfig = (config: FlowNodeConfig | undefined, key: SocialConfigKey) => {
  const value = configValue(config, key);
  return value === undefined ? undefined : stringConfig(config, key);
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
