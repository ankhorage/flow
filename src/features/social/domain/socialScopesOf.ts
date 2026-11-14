import type { SocialCapability, SocialPlatform } from '../../../types/social.js';
import { socialCapabilities } from './socialCapabilities.js';

/** Return the documented OAuth scopes for one provider-approved social capability. */
export const socialScopesOf = (
  platform: SocialPlatform,
  accountType: string,
  capability: SocialCapability,
): readonly string[] => {
  const accountScopes = socialScopesFor(platform, accountType);
  if (!accountScopes) return [];
  switch (capability) {
    case 'analytics:read':
      return accountScopes['analytics:read'];
    case 'oauth:renew':
      return accountScopes['oauth:renew'];
    case 'oauth:revoke':
      return accountScopes['oauth:revoke'];
    case 'publish':
      return accountScopes.publish;
    case 'schedule':
      return accountScopes.schedule;
  }
};

/** Select account-specific permissions without indexing untrusted graph configuration. */
const socialScopesFor = (platform: SocialPlatform, accountType: string) => {
  const { scopes } = socialPolicyOf(platform);
  switch (platform) {
    case 'meta-facebook':
      return accountType === 'page' ? scopes.page : undefined;
    case 'meta-instagram':
      return accountType === 'business'
        ? scopes.business
        : accountType === 'creator'
          ? scopes.creator
          : undefined;
    case 'linkedin':
      return accountType === 'member'
        ? scopes.member
        : accountType === 'organization'
          ? scopes.organization
          : undefined;
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
