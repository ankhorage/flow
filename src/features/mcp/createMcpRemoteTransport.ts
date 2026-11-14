import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpProviderDefinition } from '../../types/mcp.js';
import type { FlowOutboundTransportPort } from '../../types/security.js';
import { McpToolError } from './McpToolError.js';

/*** Opens remote MCP only through the host-owned transport that controls every peer connection. */
export const createMcpRemoteTransport = (
  provider: Extract<McpProviderDefinition, { readonly transport: 'remote' }>,
  outboundTransport: FlowOutboundTransportPort | undefined,
): StreamableHTTPClientTransport => {
  if (!outboundTransport)
    throw new McpToolError(
      'remote_security_boundary_unavailable',
      'Remote MCP requires a host-owned Flow security transport boundary.',
    );
  return new StreamableHTTPClientTransport(new URL(provider.endpoint), {
    fetch: async (url, init) =>
      outboundTransport.fetchAsync({
        allowedHosts: provider.allowedHosts,
        ...(init === undefined ? {} : { init }),
        url: url.toString(),
      }),
    redirectPolicy: 'same-origin',
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
};
