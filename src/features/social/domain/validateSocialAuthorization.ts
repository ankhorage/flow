import type { FlowSecurityActor } from '../../../types/security.js';
import type {
  SocialAuthorization,
  SocialCapability,
  SocialPlatform,
} from '../../../types/social.js';
import { socialAccountTypesOf, socialScopesOf } from './socialScopesOf.js';

/** Validate the credential's immutable tenant, platform, account, expiry, and scope binding. */
export const validateSocialAuthorization = (input: {
  readonly accountId: string;
  readonly accountType: string;
  readonly actor: FlowSecurityActor;
  readonly capability: SocialCapability;
  readonly credential: Readonly<Record<string, string>> | undefined;
  readonly now: Date;
  readonly platform: SocialPlatform;
}): SocialAuthorization => {
  const { accountId, accountType, actor, capability, credential, now, platform } = input;
  if (!credential) throw new Error('SOCIAL_CREDENTIAL_UNAVAILABLE');
  if (
    credential.accountId !== accountId ||
    credential.accountType !== accountType ||
    credential.platform !== platform ||
    credential.tenantId !== actor.tenantId
  )
    throw new Error('SOCIAL_CREDENTIAL_BINDING_INVALID');
  if (!socialAccountTypesOf(platform).includes(accountType))
    throw new Error(`SOCIAL_ACCOUNT_UNSUPPORTED:${platform}`);
  if (credential.expiresAt && Number.isNaN(Date.parse(credential.expiresAt)))
    throw new Error('SOCIAL_CREDENTIAL_EXPIRY_INVALID');
  if (
    capability !== 'oauth:renew' &&
    credential.expiresAt !== undefined &&
    Date.parse(credential.expiresAt) <= now.getTime()
  )
    throw new Error('SOCIAL_CREDENTIAL_EXPIRED');
  const grantedScopes = (credential.scopes ?? '').split(' ').filter(Boolean);
  const missing = socialScopesOf(platform, accountType, capability).filter(
    (scope) => !grantedScopes.includes(scope),
  );
  if (missing.length > 0) throw new Error(`SOCIAL_SCOPE_MISSING:${platform}:${missing.join(',')}`);
  return {
    accountId,
    accountType,
    credential,
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    grantedScopes,
  };
};
