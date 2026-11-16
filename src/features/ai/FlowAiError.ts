/** Represents a stable, redaction-safe AI execution failure. */
export class FlowAiError extends Error {
  readonly code:
    | 'agent_step_limit'
    | 'budget_exceeded'
    | 'cancelled'
    | 'invalid_output'
    | 'provider_failure'
    | 'quota_exceeded'
    | 'timed_out'
    | 'tool_denied';

  constructor(code: FlowAiError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'FlowAiError';
  }
}
