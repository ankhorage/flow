import type { FlowNodeOperationResult } from '../../../types/execution.js';
import type {
  SocialCapability,
  SocialNodeRegistryDependencies,
  SocialProviderReceipt,
} from '../../../types/social.js';
import { validateSocialAuthorization } from '../domain/validateSocialAuthorization.js';
import type { SocialConfig } from './createSocialConfigReader.js';

/** Rebuild an authorized social effect only from the corresponding provider receipt kind. */
export const reconcileSocialReceiptAsync = async (input: {
  readonly capability: SocialCapability;
  readonly dependencies: SocialNodeRegistryDependencies;
  readonly receipt: Exclude<SocialProviderReceipt, { readonly kind: 'unknown' }>;
  readonly request: SocialConfig;
}): Promise<FlowNodeOperationResult> => {
  const { capability, dependencies, receipt, request } = input;
  assertReceiptKind(capability, receipt.kind);
  switch (receipt.kind) {
    case 'analytics':
      return {
        output: { analytics: { kind: 'inline', value: analyticsValue(receipt.analytics) } },
      };
    case 'oauth-renew':
      return reconcileRenewedCredentialAsync(dependencies, request, receipt.credential);
    case 'oauth-revoke':
      await dependencies.security.revokeSecretAsync({
        actor: dependencies.actor,
        ref: request.credentialRef,
      });
      return { output: { lifecycle: { kind: 'inline', value: { status: 'revoked' } } } };
    case 'publish':
      return {
        output: { publication: { kind: 'inline', value: publicationValue(receipt.publication) } },
      };
  }
};

/** Validate a renewed receipt credential before it can replace the server-owned secret. */
const reconcileRenewedCredentialAsync = async (
  dependencies: SocialNodeRegistryDependencies,
  request: SocialConfig,
  credential: Readonly<Record<string, string>>,
): Promise<FlowNodeOperationResult> => {
  validateSocialAuthorization({
    accountId: request.accountId,
    accountType: request.accountType,
    actor: dependencies.actor,
    capability: 'oauth:renew',
    credential,
    now: dependencies.clock.now(),
    platform: request.platform,
  });
  await dependencies.security.replaceSecretAsync({
    actor: dependencies.actor,
    payload: credential,
    ref: request.credentialRef,
  });
  return { output: { lifecycle: { kind: 'inline', value: { status: 'renewed' } } } };
};

/** Reject a provider receipt unless its result type belongs to the authorized social operation. */
const assertReceiptKind = (
  capability: SocialCapability,
  receiptKind: Exclude<SocialProviderReceipt['kind'], 'unknown'>,
): void => {
  const expectedKind = receiptKindOf(capability);
  if (receiptKind !== expectedKind)
    throw new Error(`SOCIAL_RECEIPT_KIND_INVALID:${capability}:${receiptKind}`);
};

/** Map the immutable provider operation capability to its sole valid durable receipt type. */
const receiptKindOf = (
  capability: SocialCapability,
): Exclude<SocialProviderReceipt['kind'], 'unknown'> => {
  switch (capability) {
    case 'analytics:read':
      return 'analytics';
    case 'oauth:renew':
      return 'oauth-renew';
    case 'oauth:revoke':
      return 'oauth-revoke';
    case 'publish':
    case 'schedule':
      return 'publish';
  }
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
    readonly platform: 'linkedin' | 'meta-facebook' | 'meta-instagram';
    readonly provider: string;
    readonly source: string;
  };
}) => ({
  metrics: { ...analytics.metrics },
  observedAt: analytics.observedAt,
  platformPostId: analytics.platformPostId,
  provenance: { ...analytics.provenance },
});
