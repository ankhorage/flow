/*** Optional, allowlist-only MCP tool discovery and invocation integration. */
export { createMcpToolRegistry } from './features/mcp/createMcpToolRegistry.js';
export type {
  McpProviderDefinition,
  McpToolApprovalRequest,
  McpToolApprover,
  McpToolInvocation,
  McpToolMetadata,
  McpToolRegistry,
  McpToolResult,
} from './types/mcp.js';
