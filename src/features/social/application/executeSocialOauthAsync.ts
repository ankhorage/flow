import type {
  SocialCapability,
  SocialNodeRegistryDependencies,
  SocialPlatform,
  SocialProviderPort,
} from '../../../types/social.js';
import { validateSocialAuthorization } from '../domain/validateSocialAuthorization.js';

/** Execute OAuth lifecycle work through the provider transport and server-owned secret boundary. */
export const executeSocialOauthAsync = async (input: {
  readonly capability: Extract<SocialCapability, 'oauth:renew' | 'oauth:revoke'>;
  readonly dependencies: SocialNodeRegistryDependencies;
  readonly nodeId: string;
  readonly request: {
    readonly accountId: string;
    readonly accountType: string;
    readonly credentialRef: string;
    readonly idempotencyKey: string;
    readonly platform: SocialPlatform;
  };
}): Promise<void> => {
  const { capability, dependencies, nodeId, request } = input;
  const provider = providerOf(dependencies.providers, request.platform);
  if (!provider.allowedCapabilities.includes(capability))
    throw new Error(`SOCIAL_CAPABILITY_UNSUPPORTED:${request.platform}:${capability}`);
  const permit = await dependencies.security.authorizeAsync({
    actor: dependencies.actor,
    capability: `social:${request.platform}:${capability}`,
    idempotencyKey: request.idempotencyKey,
    operationId: `social:${nodeId}:${request.idempotencyKey}`,
    secretRefs: [request.credentialRef],
    target: { allowedHosts: provider.allowedHosts, url: provider.endpoint },
  });
  await permit.executeAsync((secrets) =>
    executeCredentialLifecycleAsync(dependencies, provider, request, capability, secrets),
  );
};

/** Keep provider tokens inside the permit while renewing or revoking their server-owned secret. */
const executeCredentialLifecycleAsync = async (
  dependencies: SocialNodeRegistryDependencies,
  provider: SocialProviderPort,
  request: Parameters<typeof executeSocialOauthAsync>[0]['request'],
  capability: Extract<SocialCapability, 'oauth:renew' | 'oauth:revoke'>,
  secrets: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<void> => {
  const authorization = validateSocialAuthorization({
    accountId: request.accountId,
    accountType: request.accountType,
    actor: dependencies.actor,
    capability,
    credential: secrets[request.credentialRef],
    now: dependencies.clock.now(),
    platform: request.platform,
  });
  if (capability === 'oauth:renew') {
    const credential = await provider.renewAsync({
      authorization,
      outboundTransport: dependencies.outboundTransport,
    });
    await dependencies.security.replaceSecretAsync({
      actor: dependencies.actor,
      payload: credential,
      ref: request.credentialRef,
    });
    return;
  }
  await provider.revokeAsync({ authorization, outboundTransport: dependencies.outboundTransport });
  await dependencies.security.revokeSecretAsync({
    actor: dependencies.actor,
    ref: request.credentialRef,
  });
};

/** Select exactly one adapter for the requested platform. */
const providerOf = (
  providers: readonly SocialProviderPort[],
  platform: SocialPlatform,
): SocialProviderPort => {
  const provider = providers.find((candidate) => candidate.platform === platform);
  if (!provider) throw new Error(`SOCIAL_PROVIDER_UNSUPPORTED:${platform}`);
  return provider;
};
