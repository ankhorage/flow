import type { FlowAiAgentToolPort } from '../../types/ai.js';
import type { McpToolMetadata, McpToolRegistry } from '../../types/mcp.js';

/** Adapts one discovered MCP tool into an explicit AI agent tool without coupling the AI feature to MCP. */
export const createMcpAgentToolAdapter = (input: {
  readonly registry: McpToolRegistry;
  readonly tool: McpToolMetadata;
}): FlowAiAgentToolPort => ({
  name: `${input.tool.providerId}:${input.tool.name}`,
  invokeAsync: async ({ arguments: toolArguments, security, signal }) => {
    const result = await input.registry.invokeAsync({
      arguments: toolArguments,
      providerId: input.tool.providerId,
      schemaFingerprint: input.tool.schemaFingerprint,
      scopes: input.tool.scopes,
      security: {
        actor: security.actor,
        idempotencyKey: `${security.idempotencyKey}:mcp`,
        operationId: `${security.operationId}:mcp`,
        secretRefs: security.secretRefs,
      },
      signal,
      toolName: input.tool.name,
    });
    return result.structuredContent ?? result.content;
  },
});
