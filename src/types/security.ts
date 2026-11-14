import type { SecretMetadata, SecretRef } from '@ankhorage/contracts/secrets';

/** Trusted execution identity supplied by the host authentication boundary. */
export interface FlowSecurityActor {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly environment: string;
}

/** An exact capability grant; omitted dimensions never imply access. */
export interface FlowSecurityGrant {
  readonly actorId: string;
  readonly capability: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly environment: string;
}

/** A protected external operation presented to the security boundary. */
export interface FlowSecurityOperation {
  readonly actor: FlowSecurityActor;
  readonly capability: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly secretRefs?: readonly SecretRef[];
  readonly target?: FlowSecurityTarget;
}

/** An outbound destination and its exact host authority. */
export interface FlowSecurityTarget {
  readonly allowedHosts: readonly string[];
  readonly url: string;
}

/** The complete immutable identity that grants, claims, and consumes one operation. */
export interface FlowSecurityOperationIdentity {
  readonly actor: FlowSecurityActor;
  readonly capability: string;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly secretRefs: readonly SecretRef[];
  readonly target?: FlowSecurityTarget;
}

/** A durable human decision bound to exactly one complete operation identity. */
export interface FlowSecurityApproval {
  readonly operation: FlowSecurityOperationIdentity;
  readonly status: 'approved' | 'pending' | 'rejected';
}

/** Host-owned persistence boundary for approval-gate state. */
export interface FlowApprovalStorePort {
  getAsync(operation: FlowSecurityOperationIdentity): Promise<FlowSecurityApproval | undefined>;
}

/** Host-owned durable exactly-once boundary. Both methods must be atomic across workers and restarts. */
export interface FlowOperationStorePort {
  claimAsync(operation: FlowSecurityOperationIdentity): Promise<boolean>;
  consumeAsync(operation: FlowSecurityOperationIdentity): Promise<boolean>;
}

/**
 * Host-owned network boundary that verifies every actual peer before opening a connection.
 * It must enforce the supplied host allowlist, resolve immediately before every connection,
 * reject private or special-use resolved addresses, and reapply that policy to redirects.
 */
export interface FlowOutboundTransportPort {
  fetchAsync(input: {
    readonly allowedHosts: readonly string[];
    readonly init?: RequestInit;
    readonly url: string;
  }): Promise<Response>;
}

/** Host-owned rate limiter. A denied acquisition must have no external side effect. */
export interface FlowRateLimitPort {
  acquireAsync(input: {
    readonly actor: FlowSecurityActor;
    readonly capability: string;
    readonly operationId: string;
  }): Promise<boolean>;
}

/** Redaction-safe audit edge. Secret values and payloads are intentionally absent. */
export interface FlowSecurityAuditPort {
  writeAsync(event: FlowSecurityAuditEvent): Promise<void>;
}

/** Immutable audit metadata for one permit or denial. */
export interface FlowSecurityAuditEvent {
  readonly actorId: string;
  readonly capability: string;
  readonly decision: 'denied' | 'permitted';
  readonly operationId: string;
  readonly reason:
    | 'approval_pending'
    | 'approval_rejected'
    | 'idempotency_conflict'
    | 'invalid_target'
    | 'permission_denied'
    | 'rate_limited'
    | 'secret_unavailable';
  readonly secretRefs: readonly SecretRef[];
  readonly targetHost?: string;
}

/** Metadata-only credential view safe for administrative or graph-facing callers. */
export type FlowSecretMetadata = SecretMetadata;
export type FlowResolvedSecrets = Readonly<Record<SecretRef, Readonly<Record<string, string>>>>;

/** One-use authorization result. Raw secrets stay private to the returned server closure. */
export interface FlowSecurityPermit {
  readonly operation: FlowSecurityOperation;
  executeAsync<T>(operation: (secrets: FlowResolvedSecrets) => Promise<T>): Promise<T>;
}

/** Public server-side boundary consumed by provider, AI, MCP, and social adapters. */
export interface FlowSecurityPort {
  authorizeAsync(operation: FlowSecurityOperation): Promise<FlowSecurityPermit>;
  getSecretMetadataAsync(input: {
    readonly actor: FlowSecurityActor;
    readonly ref: SecretRef;
  }): Promise<FlowSecretMetadata>;
}
