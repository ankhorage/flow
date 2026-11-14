import type { McpProviderDefinition } from '../../types/mcp.js';
import { McpToolError } from './McpToolError.js';

const MAX_TIMEOUT_MS = 30_000;

/*** Snapshots and validates explicit MCP provider authority before any connection is opened. */
export const prepareMcpProviders = (
  configured: readonly McpProviderDefinition[],
): ReadonlyMap<string, McpProviderDefinition> => {
  const providers = new Map(
    configured.map(cloneProvider).map((provider) => [provider.id, provider]),
  );
  if (!providers.size || providers.size !== configured.length)
    throw new McpToolError('invalid_provider', 'MCP provider identifiers must be unique.');
  providers.forEach(validateProvider);
  return providers;
};

/*** Clones provider data so later workflow-object mutation cannot expand authority. */
const cloneProvider = (provider: McpProviderDefinition): McpProviderDefinition => {
  const common = {
    id: provider.id,
    allowedTools: provider.allowedTools.map((item) => ({
      name: item.name,
      grantedScopes: [...item.grantedScopes],
    })),
    grantedScopes: [...provider.grantedScopes],
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
  };
  return provider.transport === 'stdio'
    ? { ...common, transport: 'stdio' }
    : {
        ...common,
        transport: 'remote',
        endpoint: provider.endpoint,
        allowedHosts: [...provider.allowedHosts],
      };
};

/*** Requires non-empty scopes, unique tool permissions, and safe transport configuration. */
const validateProvider = (provider: McpProviderDefinition): void => {
  if (!provider.id || !uniqueStrings(provider.grantedScopes) || !provider.allowedTools.length)
    throw new McpToolError(
      'invalid_provider',
      'MCP providers need an id, explicit granted scopes, and tool permissions.',
    );
  if (!uniqueStrings(provider.allowedTools.map((item) => item.name)))
    throw new McpToolError('invalid_provider', 'MCP tool permission names must be unique.');
  if (
    provider.allowedTools.some(
      (item) =>
        !uniqueStrings(item.grantedScopes) ||
        !item.grantedScopes.every((scope) => provider.grantedScopes.includes(scope)),
    )
  )
    throw new McpToolError(
      'invalid_provider',
      'MCP tools require explicitly granted provider scopes.',
    );
  if (
    provider.timeoutMs !== undefined &&
    (!Number.isSafeInteger(provider.timeoutMs) ||
      provider.timeoutMs < 100 ||
      provider.timeoutMs > MAX_TIMEOUT_MS)
  )
    throw new McpToolError('invalid_provider', 'MCP timeout must be bounded.');
  if (provider.transport === 'remote') validateRemote(provider);
};

/*** Rejects credentials, private literals, and endpoints outside their explicit host allowlist. */
const validateRemote = (
  provider: Extract<McpProviderDefinition, { readonly transport: 'remote' }>,
): void => {
  let url: URL;
  try {
    url = new URL(provider.endpoint);
  } catch {
    throw new McpToolError('unsafe_endpoint', 'Remote MCP endpoint must be an absolute URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.username || url.password || url.hash)
    throw new McpToolError(
      'unsafe_endpoint',
      'Remote MCP endpoints cannot embed credentials or fragments.',
    );
  if (
    url.protocol !== 'https:' ||
    privateIpv4(host) ||
    privateIpv6(host) ||
    !uniqueStrings(provider.allowedHosts) ||
    !provider.allowedHosts.includes(host)
  )
    throw new McpToolError(
      'unsafe_endpoint',
      'Remote MCP endpoints require HTTPS, a public host allowlist, and no private address.',
    );
};

/*** Detects loopback, link-local, unique-local, and unspecified IPv6 literals. */
const privateIpv6 = (host: string): boolean => {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:')
  );
};

/*** Detects private, reserved, and local IPv4 literals. */
const privateIpv4 = (host: string): boolean => {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

/*** Checks unique non-empty strings. */
const uniqueStrings = (values: readonly unknown[]): values is readonly string[] =>
  values.every((value) => typeof value === 'string' && value.length > 0) &&
  new Set(values).size === values.length;
