import type { SocialCapability, SocialPlatform } from '../../../types/social.js';
import { socialCapabilities } from './socialCapabilities.js';

/** Return the documented OAuth scopes for one provider-approved social capability. */
export const socialScopesOf = (
  platform: SocialPlatform,
  capability: SocialCapability,
): readonly string[] => {
  const { scopes } = socialPolicyOf(platform);
  switch (capability) {
    case 'analytics:read':
      return scopes['analytics:read'];
    case 'oauth:renew':
      return scopes['oauth:renew'];
    case 'oauth:revoke':
      return scopes['oauth:revoke'];
    case 'publish':
      return scopes.publish;
    case 'schedule':
      return scopes.schedule;
  }
};

/** Return provider account classes admitted by the documented platform policy. */
export const socialAccountTypesOf = (platform: SocialPlatform): readonly string[] => {
  switch (platform) {
    case 'meta-facebook':
      return ['page'];
    case 'meta-instagram':
      return ['business', 'creator'];
    case 'linkedin':
      return ['member', 'organization'];
  }
};

/** Select a static platform policy without indexing arbitrary configuration. */
const socialPolicyOf = (platform: SocialPlatform) => {
  switch (platform) {
    case 'meta-facebook':
      return socialCapabilities['meta-facebook'];
    case 'meta-instagram':
      return socialCapabilities['meta-instagram'];
    case 'linkedin':
      return socialCapabilities.linkedin;
  }
};
