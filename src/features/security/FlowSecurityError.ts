/*** Represents a stable, payload-redacted Flow security denial. */
export class FlowSecurityError extends Error {
  public constructor(
    public readonly code:
      | 'approval_pending'
      | 'approval_rejected'
      | 'idempotency_conflict'
      | 'invalid_target'
      | 'permission_denied'
      | 'rate_limited'
      | 'secret_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FlowSecurityError';
  }
}
