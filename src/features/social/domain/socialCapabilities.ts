import type { SocialCapability, SocialPlatform } from '../../../types/social.js';

/** Platform policy derived from the respective documented server APIs, not consumer UI assumptions. */
export const socialCapabilities: Readonly<
  Record<
    SocialPlatform,
    {
      readonly accountTypes: readonly string[];
      readonly scopes: Readonly<
        Record<string, Readonly<Record<SocialCapability, readonly string[]>>>
      >;
    }
  >
> = {
  'meta-facebook': {
    accountTypes: ['page'],
    scopes: {
      page: {
        'analytics:read': ['pages_read_engagement'],
        'oauth:renew': ['pages_show_list'],
        'oauth:revoke': ['pages_show_list'],
        publish: ['pages_manage_posts'],
        schedule: ['pages_manage_posts'],
      },
    },
  },
  'meta-instagram': {
    accountTypes: ['business', 'creator'],
    scopes: {
      business: {
        'analytics:read': ['instagram_manage_insights'],
        'oauth:renew': ['instagram_basic'],
        'oauth:revoke': ['instagram_basic'],
        publish: ['instagram_content_publish'],
        schedule: ['instagram_content_publish'],
      },
      creator: {
        'analytics:read': ['instagram_manage_insights'],
        'oauth:renew': ['instagram_basic'],
        'oauth:revoke': ['instagram_basic'],
        publish: ['instagram_content_publish'],
        schedule: ['instagram_content_publish'],
      },
    },
  },
  linkedin: {
    accountTypes: ['member', 'organization'],
    scopes: {
      member: {
        'analytics:read': ['r_member_postAnalytics'],
        'oauth:renew': ['openid'],
        'oauth:revoke': ['openid'],
        publish: ['w_member_social'],
        schedule: ['w_member_social'],
      },
      organization: {
        'analytics:read': ['r_organization_social'],
        'oauth:renew': ['r_organization_social'],
        'oauth:revoke': ['r_organization_social'],
        publish: ['w_organization_social'],
        schedule: ['w_organization_social'],
      },
    },
  },
};
