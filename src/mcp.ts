/*** Optional, allowlist-only MCP tool discovery and invocation integration. */
export { createMcpAgentToolAdapter } from './features/mcp/createMcpAgentToolAdapter.js';
export { createMcpToolRegistry } from './features/mcp/createMcpToolRegistry.js';
export type {
  McpProviderDefinition,
  McpToolInvocation,
  McpToolMetadata,
  McpToolPermission,
  McpToolRegistry,
  McpToolResult,
  McpTrustedStdioProvider,
} from './types/mcp.js';
