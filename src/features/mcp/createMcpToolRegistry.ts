import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type {
  McpProviderDefinition,
  McpToolInvocation,
  McpToolMetadata,
  McpToolPermission,
  McpToolRegistry,
  McpToolResult,
  McpTrustedStdioProvider,
} from '../../types/mcp.js';
import type { FlowOutboundTransportPort, FlowSecurityPort } from '../../types/security.js';
import { createMcpRemoteTransport } from './createMcpRemoteTransport.js';
import { McpToolError } from './McpToolError.js';
import { prepareMcpProviders } from './prepareMcpProviders.js';
import { validateMcpSchema } from './validateMcpSchema.js';

const MAX_PAGES = 20;
const MAX_TOOLS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

/*** Creates a snapshotting, allowlist-only MCP registry. Real invocation fails closed until Issue #4 releases its approval boundary. */
export const createMcpToolRegistry = (input: {
  readonly providers: readonly McpProviderDefinition[];
  readonly outboundTransport?: FlowOutboundTransportPort;
  readonly security?: FlowSecurityPort;
  readonly trustedStdioProviders?: Readonly<Record<string, McpTrustedStdioProvider>>;
}): McpToolRegistry => {
  const providers = prepareMcpProviders(input.providers);
  const trusted = new Map(
    Object.entries(input.trustedStdioProviders ?? {}).map(([id, value]) => [
      id,
      {
        command: value.command,
        ...(value.args ? { args: [...value.args] } : {}),
      },
    ]),
  );
  const snapshot = new Map<string, McpToolMetadata>();
  return {
    discoverAsync: async (signal) => {
      const groups = await Promise.all(
        [...providers.values()].map((provider) =>
          discoverAsync(provider, trusted, input.outboundTransport, signal),
        ),
      );
      const tools = groups.flat();
      const entries = tools.map((tool) => [key(tool.providerId, tool.name), tool] as const);
      if (new Set(entries.map(([identifier]) => identifier)).size !== entries.length)
        throw new McpToolError(
          'duplicate_tool',
          'MCP discovery returned duplicate provider tool identifiers.',
        );
      snapshot.clear();
      entries.forEach(([identifier, tool]) => snapshot.set(identifier, tool));
      return tools;
    },
    invokeAsync: (invocation) =>
      invokeAsync(
        providers,
        trusted,
        snapshot,
        input.security,
        input.outboundTransport,
        invocation,
      ),
  };
};

/*** Discovers bounded tool metadata from one trusted provider connection. */
const discoverAsync = async (
  provider: McpProviderDefinition,
  trusted: ReadonlyMap<string, McpTrustedStdioProvider>,
  outboundTransport: FlowOutboundTransportPort | undefined,
  signal?: AbortSignal,
): Promise<readonly McpToolMetadata[]> => {
  const connection = await connectAsync(provider, trusted, outboundTransport, signal);
  try {
    const tools = await listToolsAsync(connection.client, timeoutOf(provider), signal);
    return tools
      .filter((tool) => permissionFor(provider, tool.name))
      .map((tool) => toMetadata(provider, tool));
  } finally {
    await connection.closeAsync().catch(() => undefined);
  }
};

/*** Validates, approves, and invokes one discovered tool through the server-only security port. */
const invokeAsync = async (
  providers: ReadonlyMap<string, McpProviderDefinition>,
  trusted: ReadonlyMap<string, McpTrustedStdioProvider>,
  snapshot: ReadonlyMap<string, McpToolMetadata>,
  security: FlowSecurityPort | undefined,
  outboundTransport: FlowOutboundTransportPort | undefined,
  invocation: McpToolInvocation,
): Promise<McpToolResult> => {
  const provider = providers.get(invocation.providerId);
  const tool = snapshot.get(key(invocation.providerId, invocation.toolName));
  if (!provider || !tool || !permissionFor(provider, invocation.toolName))
    throw new McpToolError('tool_not_discovered', 'The requested MCP tool is not allowlisted.');
  if (tool.schemaFingerprint !== invocation.schemaFingerprint)
    throw new McpToolError(
      'schema_changed',
      'The MCP tool schema changed; rediscover it before invoking.',
    );
  const permission = permissionFor(provider, invocation.toolName);
  if (!permission || !sameScopes(permission.grantedScopes, invocation.scopes))
    throw new McpToolError(
      'scope_denied',
      'MCP tool invocation scopes are not explicitly granted.',
    );
  if (!validateMcpSchema(tool.inputSchema).matches(invocation.arguments))
    throw new McpToolError(
      'invalid_arguments',
      'MCP tool arguments do not satisfy the discovered schema.',
    );
  if (!security)
    throw new McpToolError(
      'authorization_boundary_unavailable',
      'MCP tool execution is unavailable until Flow security approvals are installed.',
    );
  const permit = await security.authorizeAsync({
    ...invocation.security,
    capability: `mcp:${provider.id}:${tool.name}`,
    ...(provider.transport === 'remote'
      ? { target: { allowedHosts: provider.allowedHosts, url: provider.endpoint } }
      : {}),
  });
  return permit.executeAsync(async () =>
    callToolAsync(provider, trusted, outboundTransport, invocation),
  );
};

/*** Opens a bounded provider connection only after the approval permit was issued. */
const callToolAsync = async (
  provider: McpProviderDefinition,
  trusted: ReadonlyMap<string, McpTrustedStdioProvider>,
  outboundTransport: FlowOutboundTransportPort | undefined,
  invocation: McpToolInvocation,
): Promise<McpToolResult> => {
  const connection = await connectAsync(provider, trusted, outboundTransport, invocation.signal);
  try {
    const result = await boundedAsync(
      (signal) =>
        connection.client.callTool(
          { name: invocation.toolName, arguments: invocation.arguments },
          undefined,
          { signal },
        ),
      timeoutOf(provider),
      invocation.signal,
    );
    if (!Array.isArray(result.content))
      throw new McpToolError(
        'invalid_execution_response',
        'The MCP provider returned an invalid tool result.',
      );
    return {
      content: result.content,
      ...(isRecord(result.structuredContent)
        ? { structuredContent: result.structuredContent }
        : {}),
      isError: result.isError === true,
    };
  } finally {
    await connection.closeAsync().catch(() => undefined);
  }
};

interface ListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
}
interface Connection {
  readonly client: Client;
  closeAsync(): Promise<void>;
}

/*** Connects with a bounded timeout and an abort signal propagated to the SDK transport. */
const connectAsync = async (
  provider: McpProviderDefinition,
  trusted: ReadonlyMap<string, McpTrustedStdioProvider>,
  outboundTransport: FlowOutboundTransportPort | undefined,
  signal?: AbortSignal,
): Promise<Connection> => {
  const client = new Client({ name: '@ankhorage/flow', version: '0.1.0' });
  const transport =
    provider.transport === 'stdio'
      ? stdioTransport(provider, trusted)
      : createMcpRemoteTransport(provider, outboundTransport);
  await boundedAsync(
    (timeoutSignal) =>
      client.connect(transport, { signal: timeoutSignal, timeout: timeoutOf(provider) }),
    timeoutOf(provider),
    signal,
  );
  return { client, closeAsync: () => transport.close() };
};

/*** Resolves executable details exclusively from trusted host configuration. */
const stdioTransport = (
  provider: Extract<McpProviderDefinition, { readonly transport: 'stdio' }>,
  trusted: ReadonlyMap<string, McpTrustedStdioProvider>,
): StdioClientTransport => {
  const host = trusted.get(provider.id);
  if (!host)
    throw new McpToolError(
      'untrusted_stdio_provider',
      'STDIO MCP providers require trusted host command configuration.',
    );
  return new StdioClientTransport({
    command: host.command,
    args: host.args ? [...host.args] : undefined,
    stderr: 'pipe',
  });
};

/*** Lists a bounded, non-cyclic sequence of paginated tools. */
const listToolsAsync = async (
  client: Client,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<readonly ListedTool[]> => {
  const tools: ListedTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursors.size >= MAX_PAGES)
      throw new McpToolError('pagination_limit', 'MCP tool discovery exceeded the page limit.');
    if (cursor) {
      if (cursors.has(cursor))
        throw new McpToolError(
          'pagination_cycle',
          'MCP tool discovery returned a repeated cursor.',
        );
      cursors.add(cursor);
    }
    const page = await boundedAsync(
      (timeoutSignal) =>
        client.listTools(cursor ? { cursor } : undefined, { signal: timeoutSignal }),
      timeoutMs,
      signal,
    );
    if (!Array.isArray(page.tools))
      throw new McpToolError(
        'invalid_discovery_response',
        'The MCP provider returned invalid tool metadata.',
      );
    tools.push(...page.tools);
    if (tools.length > MAX_TOOLS)
      throw new McpToolError('tool_limit', 'MCP tool discovery exceeded the tool limit.');
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
};

/*** Converts valid protocol metadata into a stable Flow descriptor. */
const toMetadata = (provider: McpProviderDefinition, tool: ListedTool): McpToolMetadata => {
  if (!tool.name || !isRecord(tool.inputSchema))
    throw new McpToolError('invalid_schema', 'The MCP tool has no valid input schema.');
  const permission = permissionFor(provider, tool.name);
  if (!permission)
    throw new McpToolError('tool_not_discovered', 'The requested MCP tool is not allowlisted.');
  const schema = validateMcpSchema(tool.inputSchema);
  return {
    providerId: provider.id,
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    schemaFingerprint: schema.fingerprint,
    scopes: permission.grantedScopes,
    readOnly: tool.annotations?.readOnlyHint === true,
  };
};

/*** Propagates cancellation and a fixed timeout into an asynchronous SDK operation. */
const boundedAsync = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs,
  );
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await operation(combined);
  } catch (error) {
    if (controller.signal.aborted) throw new McpToolError('timed_out', 'MCP operation timed out.');
    if (combined.aborted) throw new McpToolError('cancelled', 'MCP operation was cancelled.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
/*** Finds one explicit permission for a protocol tool. */
const permissionFor = (
  provider: McpProviderDefinition,
  name: string,
): McpToolPermission | undefined => provider.allowedTools.find((item) => item.name === name);
/*** Requires every and only the configured granted scope. */
const sameScopes = (granted: readonly string[], requested: readonly string[]): boolean =>
  requested.length > 0 &&
  requested.length === granted.length &&
  new Set(requested).size === requested.length &&
  requested.every((scope) => granted.includes(scope));
/*** Builds a provider-scoped tool identifier. */
const key = (providerId: string, toolName: string): string => `${providerId}:${toolName}`;
/*** Narrows unknown data to a non-array object. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/*** Resolves a configured timeout to its bounded default. */
const timeoutOf = (provider: McpProviderDefinition): number =>
  provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
