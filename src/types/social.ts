import type { SecretRef } from '@ankhorage/contracts/secrets';

import type { FlowOutboundTransportPort, FlowSecurityActor, FlowSecurityPort } from './security.js';

/** The provider account classes Flow may publish to without a provider SDK. */
export type SocialPlatform = 'meta-facebook' | 'meta-instagram' | 'linkedin';

/** A concrete provider operation that is deliberately allowed for a platform. */
export type SocialCapability =
  'analytics:read' | 'oauth:renew' | 'oauth:revoke' | 'publish' | 'schedule';

/** Metadata required to validate a server-side OAuth credential without exposing it in a graph. */
export interface SocialAuthorization {
  readonly accountId: string;
  readonly accountType: string;
  readonly credential: Readonly<Record<string, string>>;
  readonly expiresAt?: string;
  readonly grantedScopes: readonly string[];
}

/** A media object that has been validated by the platform-specific adapter. */
export interface SocialMedia {
  readonly byteLength: number;
  readonly mediaType: string;
  readonly source: string;
}

/** A redaction-safe publication request passed to a platform adapter. */
export interface SocialPublishRequest {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly media: readonly SocialMedia[];
  readonly scheduledAt?: string;
  readonly text: string;
}

/** One observable result of publishing or scheduling content. */
export interface SocialPublication {
  readonly platformPostId: string;
  readonly status: 'posted' | 'scheduled';
  readonly publishedAt?: string;
  readonly scheduledAt?: string;
}

/** Normalized analytics together with the facts needed to interpret it later. */
export interface SocialAnalytics {
  readonly metrics: Readonly<Record<string, number>>;
  readonly observedAt: string;
  readonly platformPostId: string;
  readonly provenance: {
    readonly accountId: string;
    readonly platform: SocialPlatform;
    readonly provider: string;
    readonly source: string;
  };
}

/** Explicit server-only dependencies for the optional social node registry. */
export interface SocialNodeRegistryDependencies {
  readonly actor: FlowSecurityActor;
  readonly clock: { readonly now: () => Date };
  readonly providers: readonly SocialProviderPort[];
  readonly outboundTransport: FlowOutboundTransportPort;
  readonly security: FlowSecurityPort;
}

/** Provider edge translated through the optional social package boundary. */
export interface SocialProviderPort {
  readonly allowedCapabilities: readonly SocialCapability[];
  readonly allowedHosts: readonly string[];
  /** Exact documented server API endpoint; Flow authorizes this destination before every operation. */
  readonly endpoint: string;
  readonly platform: SocialPlatform;
  fetchAnalyticsAsync(input: {
    readonly authorization: SocialAuthorization;
    readonly outboundTransport: FlowOutboundTransportPort;
    readonly platformPostId: string;
    readonly signal: AbortSignal;
  }): Promise<SocialAnalytics>;
  publishAsync(input: {
    readonly authorization: SocialAuthorization;
    readonly outboundTransport: FlowOutboundTransportPort;
    readonly request: SocialPublishRequest;
    readonly signal: AbortSignal;
  }): Promise<SocialPublication>;
  revokeAsync(input: {
    readonly authorization: SocialAuthorization;
    readonly outboundTransport: FlowOutboundTransportPort;
  }): Promise<void>;
  renewAsync(input: {
    readonly authorization: SocialAuthorization;
    readonly outboundTransport: FlowOutboundTransportPort;
  }): Promise<Readonly<Record<string, string>>>;
  validateMediaAsync(input: {
    readonly authorization: SocialAuthorization;
    readonly media: readonly SocialMedia[];
  }): Promise<void>;
}

/** A graph configuration always refers to an OAuth credential held by the server secret store. */
export interface SocialNodeCredential {
  readonly ref: SecretRef;
}
