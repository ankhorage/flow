/*** Represents a stable, redaction-safe MCP failure. */
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}
