import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpToolError } from './McpToolError.js';

interface McpSdk {
  readonly Client: typeof Client;
  readonly StdioClientTransport: typeof StdioClientTransport;
  readonly StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport;
}

/*** Loads the optional MCP SDK only when an approved MCP connection needs to be opened. */
export const loadMcpSdkAsync = async (): Promise<McpSdk> => {
  try {
    const [client, stdio, streamableHttp] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    return {
      Client: client.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      StreamableHTTPClientTransport: streamableHttp.StreamableHTTPClientTransport,
    };
  } catch {
    throw new McpToolError(
      'optional_sdk_unavailable',
      'MCP execution requires the optional @modelcontextprotocol/sdk peer dependency.',
    );
  }
};
