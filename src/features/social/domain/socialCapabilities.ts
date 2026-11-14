import type { SocialCapability, SocialPlatform } from '../../../types/social.js';

/** Platform policy derived from the respective documented server APIs, not consumer UI assumptions. */
export const socialCapabilities: Readonly<
  Record<
    SocialPlatform,
    {
      readonly accountTypes: readonly string[];
      readonly scopes: Readonly<Record<SocialCapability, readonly string[]>>;
    }
  >
> = {
  'meta-facebook': {
    accountTypes: ['page'],
    scopes: {
      'analytics:read': ['pages_read_engagement'],
      'oauth:renew': ['pages_show_list'],
      'oauth:revoke': ['pages_show_list'],
      publish: ['pages_manage_posts'],
      schedule: ['pages_manage_posts'],
    },
  },
  'meta-instagram': {
    accountTypes: ['business', 'creator'],
    scopes: {
      'analytics:read': ['instagram_manage_insights'],
      'oauth:renew': ['instagram_basic'],
      'oauth:revoke': ['instagram_basic'],
      publish: ['instagram_content_publish'],
      schedule: ['instagram_content_publish'],
    },
  },
  linkedin: {
    accountTypes: ['member', 'organization'],
    scopes: {
      'analytics:read': ['r_organization_social'],
      'oauth:renew': ['r_liteprofile'],
      'oauth:revoke': ['r_liteprofile'],
      publish: ['w_member_social'],
      schedule: ['w_member_social'],
    },
  },
};
