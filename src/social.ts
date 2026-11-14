/*** Optional provider-neutral social publishing, OAuth lifecycle, and analytics boundaries. */
export { createSocialNodeRegistry } from './features/social/application/createSocialNodeRegistry.js';
export { socialCapabilities } from './features/social/domain/socialCapabilities.js';
export type {
  SocialAnalytics,
  SocialAuthorization,
  SocialCapability,
  SocialMedia,
  SocialNodeCredential,
  SocialNodeRegistryDependencies,
  SocialPlatform,
  SocialProviderPort,
  SocialPublication,
  SocialPublishRequest,
} from './types/social.js';
