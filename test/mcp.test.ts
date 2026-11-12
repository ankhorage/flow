import { expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createMcpToolRegistry } from '../src/mcp.js';

const provider = {
  id: 'fixture',
  transport: 'stdio' as const,
  command: process.execPath,
  args: [new URL('./fixtures/mcpStdioServer.ts', import.meta.url).pathname],
  allowedTools: ['safe_echo'],
  scopes: ['tools:invoke'],
  timeoutMs: 5_000,
};

test('discovers an allowlisted STDIO tool and invokes it after approval', async () => {
  const registry = createMcpToolRegistry({ approveToolAsync: () => true, providers: [provider] });
  const tools = await registry.discoverAsync();
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ name: 'safe_echo', providerId: 'fixture', readOnly: true });

  const result = await registry.invokeAsync({
    providerId: 'fixture',
    toolName: 'safe_echo',
    schemaFingerprint: tools[0]?.schemaFingerprint ?? '',
    arguments: { message: 'hello' },
    scopes: ['tools:invoke'],
  });
  expect(result).toMatchObject({ content: [{ type: 'text', text: 'hello' }], isError: false });
});

test('denies tool execution before contacting the provider', async () => {
  const registry = createMcpToolRegistry({ approveToolAsync: () => false, providers: [provider] });
  const [tool] = await registry.discoverAsync();
  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: { message: 'blocked' },
      scopes: ['tools:invoke'],
    }),
  ).rejects.toThrow('not approved');
});

test('rejects stale schemas, undeclared arguments, and unsafe remote endpoints', async () => {
  const registry = createMcpToolRegistry({ approveToolAsync: () => true, providers: [provider] });
  const [tool] = await registry.discoverAsync();
  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: 'stale',
      arguments: {},
      scopes: ['tools:invoke'],
    }),
  ).rejects.toThrow('schema changed');

  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: {},
      scopes: ['tools:invoke'],
    }),
  ).rejects.toThrow('arguments do not satisfy');

  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: { message: 1 },
      scopes: ['tools:invoke'],
    }),
  ).rejects.toThrow('arguments do not satisfy');

  const unsafe = createMcpToolRegistry({
    approveToolAsync: () => true,
    providers: [
      {
        id: 'unsafe',
        transport: 'remote',
        endpoint: 'http://evil.example/mcp',
        allowedTools: ['tool'],
        scopes: ['tools:invoke'],
      },
    ],
  });
  await expect(unsafe.discoverAsync()).rejects.toThrow('must use HTTPS');
  expect(tool?.name).toBe('safe_echo');
});

test('discovers and invokes a safe tool through the loopback remote transport', async () => {
  const httpServer = createServer(async (request, response) => {
    const server = createRemoteMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response, await readJsonBodyAsync(request));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a loopback test server port.');

  try {
    const registry = createMcpToolRegistry({
      approveToolAsync: () => true,
      providers: [
        {
          id: 'remote',
          transport: 'remote',
          endpoint: `http://127.0.0.1:${address.port}/mcp`,
          allowedTools: ['remote_echo'],
          scopes: ['tools:invoke'],
        },
      ],
    });
    const [tool] = await registry.discoverAsync();
    const result = await registry.invokeAsync({
      providerId: 'remote',
      toolName: 'remote_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: {},
      scopes: ['tools:invoke'],
    });
    expect(result.content).toEqual([{ type: 'text', text: 'remote' }]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const createRemoteMcpServer = (): Server => {
  const server = new Server(
    { name: 'flow-test-remote-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'remote_echo', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: 'text', text: 'remote' }],
  }));
  return server;
};

const readJsonBodyAsync = async (
  request: import('node:http').IncomingMessage,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : undefined;
};
