import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {
  McpProviderDefinition,
  McpToolApprover,
  McpToolInvocation,
  McpToolMetadata,
  McpToolRegistry,
  McpToolResult,
} from '../../types/mcp.js';

/***
 * Creates an allowlist-only MCP registry for the optional Flow MCP entrypoint.
 *
 * Providers are configured explicitly; discovery never executes a tool and invocation always
 * requires a separate approval decision. Remote providers cannot receive caller-supplied headers.
 */
export const createMcpToolRegistry = (input: {
  readonly approveToolAsync: McpToolApprover;
  readonly providers: readonly McpProviderDefinition[];
}): McpToolRegistry => {
  const providers = new Map(input.providers.map((provider) => [provider.id, provider]));
  const discoveredTools = new Map<string, McpToolMetadata>();

  return {
    discoverAsync: (signal) => discoverMcpToolsAsync(input.providers, discoveredTools, signal),
    invokeAsync: (invocation) =>
      invokeMcpToolAsync(input.approveToolAsync, providers, discoveredTools, invocation),
  };
};

/*** Discovers only explicitly allowlisted tools and replaces the stable registry snapshot. */
const discoverMcpToolsAsync = async (
  providers: readonly McpProviderDefinition[],
  discoveredTools: Map<string, McpToolMetadata>,
  signal?: AbortSignal,
): Promise<readonly McpToolMetadata[]> => {
  const metadata = await Promise.all(
    providers.map((provider) => discoverProviderToolsAsync(provider, signal)),
  );
  const flattened = metadata.flat();
  discoveredTools.clear();
  flattened.forEach((tool) => discoveredTools.set(toolKey(tool.providerId, tool.name), tool));
  return flattened;
};

/*** Discovers the allowlisted tool metadata for one explicitly configured provider. */
const discoverProviderToolsAsync = async (
  provider: McpProviderDefinition,
  signal?: AbortSignal,
): Promise<readonly McpToolMetadata[]> => {
  validateProvider(provider);
  const connection = await openMcpProviderAsync(provider, signal);
  try {
    const tools = await listToolsAsync(connection.client, signal);
    return tools
      .filter((tool) => provider.allowedTools.includes(tool.name))
      .map((tool) => toMetadata(provider, tool));
  } finally {
    await closeConnectionAsync(connection);
  }
};

/*** Validates approval, schema, and scope before invoking one discovered MCP tool. */
const invokeMcpToolAsync = async (
  approveToolAsync: McpToolApprover,
  providers: ReadonlyMap<string, McpProviderDefinition>,
  discoveredTools: ReadonlyMap<string, McpToolMetadata>,
  invocation: McpToolInvocation,
): Promise<McpToolResult> => {
  const provider = providers.get(invocation.providerId);
  const tool = discoveredTools.get(toolKey(invocation.providerId, invocation.toolName));
  if (!provider || !tool)
    throw new McpToolError('tool_not_discovered', 'The requested MCP tool is not allowlisted.');
  validateInvocation(provider, tool, invocation);
  const approved = await approveToolAsync({
    providerId: invocation.providerId,
    toolName: invocation.toolName,
    scopes: invocation.scopes,
    arguments: invocation.arguments,
  });
  if (!approved) throw new McpToolError('approval_denied', 'MCP tool execution was not approved.');
  return callMcpToolAsync(provider, invocation);
};

/*** Rejects an invocation before it can reach a provider. */
const validateInvocation = (
  provider: McpProviderDefinition,
  tool: McpToolMetadata,
  invocation: McpToolInvocation,
): void => {
  if (!provider.allowedTools.includes(invocation.toolName))
    throw new McpToolError('tool_not_discovered', 'The requested MCP tool is not allowlisted.');
  if (tool.schemaFingerprint !== invocation.schemaFingerprint)
    throw new McpToolError(
      'schema_changed',
      'The MCP tool schema changed; rediscover it before invoking.',
    );
  if (
    !includesAll(provider.scopes, invocation.scopes) ||
    !includesAll(tool.scopes, invocation.scopes)
  )
    throw new McpToolError('scope_denied', 'The requested MCP tool scopes are not permitted.');
  validateArguments(tool.inputSchema, invocation.arguments);
};

/*** Executes an approved tool call and maps provider failures to a redaction-safe error. */
const callMcpToolAsync = async (
  provider: McpProviderDefinition,
  invocation: McpToolInvocation,
): Promise<McpToolResult> => {
  const connection = await openMcpProviderAsync(provider, invocation.signal);
  try {
    const response = await connection.client.callTool(
      { name: invocation.toolName, arguments: invocation.arguments },
      undefined,
      { signal: invocation.signal, timeout: provider.timeoutMs ?? 10_000 },
    );
    if (!('content' in response) || !Array.isArray(response.content))
      throw new McpToolError(
        'invalid_response',
        'The MCP provider returned an unsupported tool result.',
      );
    return {
      content: response.content,
      ...(isRecord(response.structuredContent)
        ? { structuredContent: response.structuredContent }
        : {}),
      isError: response.isError === true,
    };
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    throw normalizeError(error);
  } finally {
    await closeConnectionAsync(connection);
  }
};

class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

interface McpListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
  };
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

interface McpConnection {
  readonly client: Client;
  closeAsync(): Promise<void>;
}

/*** Opens one protocol-negotiated MCP client connection for a configured provider. */
const openMcpProviderAsync = async (
  provider: McpProviderDefinition,
  signal?: AbortSignal,
): Promise<McpConnection> => {
  const client = new Client({ name: '@ankhorage/flow', version: '0.1.0' });
  const transport =
    provider.transport === 'stdio'
      ? new StdioClientTransport({
          command: provider.command,
          args: provider.args ? [...provider.args] : undefined,
          env: provider.environment ? { ...provider.environment } : undefined,
          stderr: 'pipe',
        })
      : new StreamableHTTPClientTransport(new URL(provider.endpoint), {
          redirectPolicy: 'same-origin',
        });
  await client.connect(transport, { signal, timeout: provider.timeoutMs ?? 10_000 });
  return { client, closeAsync: () => transport.close() };
};

/*** Retrieves every paginated tool listing from an MCP provider. */
const listToolsAsync = async (
  client: Client,
  signal?: AbortSignal,
): Promise<readonly McpListedTool[]> => {
  const allTools: McpListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    allTools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return allTools;
};

/*** Maps MCP wire metadata into the stable, provider-scoped Flow metadata contract. */
const toMetadata = (provider: McpProviderDefinition, tool: McpListedTool): McpToolMetadata => ({
  providerId: provider.id,
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  schemaFingerprint: fingerprint(tool.inputSchema),
  scopes: provider.scopes,
  readOnly: tool.annotations?.readOnlyHint ?? false,
});

/*** Enforces that provider configuration is explicit and safe before connecting. */
const validateProvider = (provider: McpProviderDefinition): void => {
  if (!provider.id || provider.allowedTools.length === 0 || provider.scopes.length === 0) {
    throw new McpToolError(
      'invalid_provider',
      'MCP providers need an id, explicit tool allowlist, and scopes.',
    );
  }
  if (provider.transport === 'stdio' && !provider.command) {
    throw new McpToolError('invalid_provider', 'MCP STDIO providers need an explicit command.');
  }
  if (provider.transport === 'remote') validateRemoteEndpoint(provider.endpoint);
};

/*** Allows only encrypted remote endpoints, except an explicitly local test/development endpoint. */
const validateRemoteEndpoint = (endpoint: string): void => {
  const url = new URL(endpoint);
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new McpToolError(
      'unsafe_endpoint',
      'Remote MCP endpoints must use HTTPS (except local loopback) and cannot embed credentials.',
    );
  }
};

/*** Rejects arguments that do not conform to the exact schema discovered for the tool. */
const validateArguments = (
  schema: Readonly<Record<string, unknown>>,
  argumentsValue: Readonly<Record<string, unknown>>,
): void => {
  if (!schemaValueMatches(schema, argumentsValue)) {
    throw new McpToolError(
      'invalid_arguments',
      'MCP tool arguments do not satisfy the discovered schema.',
    );
  }
};

/*** Checks the JSON-schema constraints that apply to MCP tool argument objects. */
const schemaValueMatches = (schema: Readonly<Record<string, unknown>>, value: unknown): boolean => {
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number') return typeof value === 'number';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type !== 'object' || !isRecord(value)) return false;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((property): property is string => typeof property === 'string')
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return (
    required.every((property) => property in value) &&
    Object.entries(value).every(([property, propertyValue]) => {
      const propertySchema = Object.entries(properties).find(([name]) => name === property)?.[1];
      return !isRecord(propertySchema) || schemaValueMatches(propertySchema, propertyValue);
    })
  );
};

/*** Produces a stable identifier for an exact discovered tool schema. */
const fingerprint = (schema: object): string =>
  createHash('sha256').update(JSON.stringify(schema)).digest('hex');
/*** Builds the collision-free local registry key for one provider-owned tool. */
const toolKey = (providerId: string, toolName: string): string => `${providerId}:${toolName}`;
/*** Checks that all requested tool scopes are contained in the provider allowlist. */
const includesAll = (allowed: readonly string[], requested: readonly string[]): boolean =>
  requested.every((scope) => allowed.includes(scope));
/*** Narrows unknown structured MCP result data to an ordinary object. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/*** Converts provider failures to stable errors that omit provider or credential detail. */
const normalizeError = (error: unknown): McpToolError => {
  if (error instanceof DOMException && error.name === 'AbortError')
    return new McpToolError('cancelled', 'MCP tool execution was cancelled.');
  if (/time(d)?\s*out/i.test(error instanceof Error ? error.message : String(error)))
    return new McpToolError('timed_out', 'MCP tool execution timed out.');
  return new McpToolError('provider_error', 'MCP provider execution failed.');
};

/*** Closes a provider connection without allowing cleanup faults to mask the tool outcome. */
const closeConnectionAsync = async (connection: McpConnection): Promise<void> => {
  await connection.closeAsync().catch(() => undefined);
};
