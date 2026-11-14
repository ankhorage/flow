import type { FlowAiAgentToolPort, FlowAiSecurityContext } from '../../types/ai.js';
import type { McpToolMetadata, McpToolRegistry } from '../../types/mcp.js';

/** Adapts one discovered MCP tool into an explicit AI agent tool without coupling the AI feature to MCP. */
export const createMcpAgentToolAdapter = (input: {
  readonly registry: McpToolRegistry;
  readonly security: FlowAiSecurityContext;
  readonly tool: McpToolMetadata;
}): FlowAiAgentToolPort => ({
  name: `${input.tool.providerId}:${input.tool.name}`,
  invokeAsync: async ({ arguments: toolArguments, signal }) => {
    const result = await input.registry.invokeAsync({
      arguments: toolArguments,
      providerId: input.tool.providerId,
      schemaFingerprint: input.tool.schemaFingerprint,
      scopes: input.tool.scopes,
      security: input.security,
      signal,
      toolName: input.tool.name,
    });
    return result.structuredContent ?? result.content;
  },
});
