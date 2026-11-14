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
  readonly targetUrl?: string;
}

/** A durable human decision supplied by the host's approval persistence adapter. */
export interface FlowSecurityApproval {
  readonly approvedBy?: string;
  readonly operationId: string;
  readonly status: 'approved' | 'pending' | 'rejected';
}

/** Host-owned persistence boundary for approval-gate state. */
export interface FlowApprovalStorePort {
  getAsync(operationId: string): Promise<FlowSecurityApproval | undefined>;
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
