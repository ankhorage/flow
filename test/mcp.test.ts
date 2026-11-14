import { expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createFlowSecurityPort } from '../src/index.js';
import { createMcpToolRegistry } from '../src/mcp.js';

const provider = {
  id: 'fixture',
  transport: 'stdio' as const,
  allowedTools: [
    { name: 'safe_echo', grantedScopes: ['tools:invoke'] },
    { name: 'sum_numbers', grantedScopes: ['tools:invoke'] },
  ],
  grantedScopes: ['tools:invoke'],
  timeoutMs: 5_000,
};

const trustedStdioProviders = {
  fixture: {
    command: process.execPath,
    args: [new URL('./fixtures/mcpStdioServer.ts', import.meta.url).pathname],
  },
};

const securityInvocation = (operationId: string) => ({
  actor: {
    id: 'operator',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    environment: 'test',
  },
  idempotencyKey: operationId,
  operationId,
});

const permittingSecurity = (capabilities = ['mcp:fixture:safe_echo', 'mcp:fixture:sum_numbers']) =>
  createFlowSecurityPort({
    approvalStore: { getAsync: async (operation) => ({ operation, status: 'approved' }) },
    audit: { writeAsync: async () => undefined },
    grants: capabilities.map((capability) => ({
      ...securityInvocation('unused').actor,
      actorId: 'operator',
      capability,
    })),
    operationStore: {
      claimAsync: async () => true,
      consumeAsync: async () => true,
      releaseAsync: async () => undefined,
    },
    rateLimit: { acquireAsync: async () => true },
    secretStore: {
      create: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
      getMetadata: async () => ({ ok: false, error: { code: 'not_found', message: 'unused' } }),
      list: async () => ({ ok: true, data: [] }),
      remove: async () => ({ ok: true }),
      replace: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
      resolve: async () => ({ ok: true, data: {} }),
    },
  });

test('discovers only explicitly permitted tools from a trusted STDIO host provider', async () => {
  const registry = createMcpToolRegistry({ providers: [provider], trustedStdioProviders });
  const tools = await registry.discoverAsync();
  expect(tools).toHaveLength(2);
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'safe_echo', providerId: 'fixture', readOnly: true }),
      expect.objectContaining({ name: 'sum_numbers', providerId: 'fixture', readOnly: true }),
    ]),
  );
});

test('fails closed before real tool execution until the approval boundary is released', async () => {
  const registry = createMcpToolRegistry({ providers: [provider], trustedStdioProviders });
  const [tool] = await registry.discoverAsync();
  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: { message: 'must not run' },
      scopes: ['tools:invoke'],
      security: securityInvocation('denied'),
    }),
  ).rejects.toThrow('security approvals');
});

test('executes distinct STDIO tools only after a scoped Flow security permit is approved', async () => {
  const registry = createMcpToolRegistry({
    providers: [provider],
    security: permittingSecurity(),
    trustedStdioProviders,
  });
  const tools = await registry.discoverAsync();
  const echo = tools.find((tool) => tool.name === 'safe_echo');
  const sum = tools.find((tool) => tool.name === 'sum_numbers');
  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: echo?.schemaFingerprint ?? '',
      arguments: { message: 'permitted' },
      scopes: ['tools:invoke'],
      security: securityInvocation('approved'),
    }),
  ).resolves.toMatchObject({ content: [{ text: 'permitted' }] });
  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'sum_numbers',
      schemaFingerprint: sum?.schemaFingerprint ?? '',
      arguments: { values: [2, 3] },
      scopes: ['tools:invoke'],
      security: securityInvocation('approved-sum'),
    }),
  ).resolves.toMatchObject({ content: [{ text: '5' }] });
});

test('rejects missing scopes, stale schemas, and schema-invalid arguments before authorization', async () => {
  const registry = createMcpToolRegistry({ providers: [provider], trustedStdioProviders });
  const [tool] = await registry.discoverAsync();
  const invocation = {
    providerId: 'fixture',
    toolName: 'safe_echo',
    schemaFingerprint: tool?.schemaFingerprint ?? '',
    arguments: { message: 'hello' },
    security: securityInvocation('validation'),
  };
  await expect(registry.invokeAsync({ ...invocation, scopes: [] })).rejects.toThrow('scopes');
  await expect(
    registry.invokeAsync({ ...invocation, schemaFingerprint: 'stale', scopes: ['tools:invoke'] }),
  ).rejects.toThrow('schema changed');
  await expect(
    registry.invokeAsync({ ...invocation, arguments: { message: 1 }, scopes: ['tools:invoke'] }),
  ).rejects.toThrow('arguments do not satisfy');
  await expect(
    registry.invokeAsync({
      ...invocation,
      arguments: { message: 'x', injected: true },
      scopes: ['tools:invoke'],
    }),
  ).rejects.toThrow('arguments do not satisfy');
});

test('rejects unsafe remote endpoints and production remote access before network activity', async () => {
  expect(() =>
    createMcpToolRegistry({
      providers: [
        {
          id: 'unsafe',
          transport: 'remote',
          endpoint: 'https://127.0.0.1/mcp',
          allowedHosts: ['127.0.0.1'],
          allowedTools: [{ name: 'tool', grantedScopes: ['tools:invoke'] }],
          grantedScopes: ['tools:invoke'],
        },
      ],
    }),
  ).toThrow('public host allowlist');
  expect(() =>
    createMcpToolRegistry({
      providers: [
        {
          id: 'unsafe-ipv6',
          transport: 'remote',
          endpoint: 'https://[::ffff:7f00:1]/mcp',
          allowedHosts: ['::ffff:7f00:1'],
          allowedTools: [{ name: 'tool', grantedScopes: ['tools:invoke'] }],
          grantedScopes: ['tools:invoke'],
        },
      ],
    }),
  ).toThrow('public host allowlist');

  const production = createMcpToolRegistry({
    providers: [
      {
        id: 'production',
        transport: 'remote',
        endpoint: 'https://mcp.example.test/endpoint',
        allowedHosts: ['mcp.example.test'],
        allowedTools: [{ name: 'tool', grantedScopes: ['tools:invoke'] }],
        grantedScopes: ['tools:invoke'],
      },
    ],
  });
  await expect(production.discoverAsync()).rejects.toThrow('security transport boundary');
});

test('does not bypass a host transport that rejects an outbound peer or leak its error', async () => {
  const registry = createMcpToolRegistry({
    providers: [
      {
        id: 'blocked',
        transport: 'remote',
        endpoint: 'https://mcp.example.test/endpoint',
        allowedHosts: ['mcp.example.test'],
        allowedTools: [{ name: 'tool', grantedScopes: ['tools:invoke'] }],
        grantedScopes: ['tools:invoke'],
      },
    ],
    outboundTransport: {
      fetchAsync: async ({ allowedHosts, url }) => {
        expect(allowedHosts).toEqual(['mcp.example.test']);
        expect(url).toContain('mcp.example.test');
        throw new Error('host transport rejected the resolved peer');
      },
    },
  });
  await expect(registry.discoverAsync()).rejects.toThrow('MCP provider connection failed.');
});

test('routes remote discovery through the host transport boundary', async () => {
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
      providers: [
        {
          id: 'remote',
          transport: 'remote',
          endpoint: 'https://mcp.example.test/mcp',
          allowedHosts: ['mcp.example.test'],
          allowedTools: [{ name: 'remote_echo', grantedScopes: ['tools:invoke'] }],
          grantedScopes: ['tools:invoke'],
        },
      ],
      outboundTransport: {
        fetchAsync: async ({ init, url }) => {
          expect(url).toContain('mcp.example.test');
          return fetch(`http://127.0.0.1:${address.port}/mcp`, init);
        },
      },
      security: permittingSecurity(['mcp:remote:remote_echo']),
    });
    const [tool] = await registry.discoverAsync();
    expect(tool).toMatchObject({ name: 'remote_echo', providerId: 'remote' });
    await expect(
      registry.invokeAsync({
        providerId: 'remote',
        toolName: 'remote_echo',
        schemaFingerprint: tool?.schemaFingerprint ?? '',
        arguments: {},
        scopes: ['tools:invoke'],
        security: securityInvocation('remote-approved'),
      }),
    ).resolves.toMatchObject({ content: [{ text: 'remote' }] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('rejects untrusted STDIO configuration without leaking host command details', async () => {
  const registry = createMcpToolRegistry({ providers: [provider] });
  await expect(registry.discoverAsync()).rejects.toThrow('trusted host command configuration');
});

test('propagates caller cancellation before provider discovery', async () => {
  const registry = createMcpToolRegistry({ providers: [provider], trustedStdioProviders });
  const controller = new AbortController();
  controller.abort();
  await expect(registry.discoverAsync(controller.signal)).rejects.toThrow('cancelled');
});

test('propagates caller cancellation before permitted tool execution', async () => {
  const registry = createMcpToolRegistry({
    providers: [provider],
    security: permittingSecurity(),
    trustedStdioProviders,
  });
  const [tool] = await registry.discoverAsync();
  const controller = new AbortController();
  controller.abort();
  await expect(
    registry.invokeAsync({
      providerId: 'fixture',
      toolName: 'safe_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: { message: 'must not start' },
      scopes: ['tools:invoke'],
      security: securityInvocation('cancelled-invocation'),
      signal: controller.signal,
    }),
  ).rejects.toThrow('cancelled');
});

test('bounds a permitted stalled STDIO invocation with the provider timeout', async () => {
  const registry = createMcpToolRegistry({
    providers: [{ ...provider, id: 'stalled-execution', timeoutMs: 1_000 }],
    security: permittingSecurity(['mcp:stalled-execution:safe_echo']),
    trustedStdioProviders: {
      'stalled-execution': {
        command: process.execPath,
        args: [new URL('./fixtures/mcpStalledToolServer.ts', import.meta.url).pathname],
      },
    },
  });
  const [tool] = await registry.discoverAsync();
  await expect(
    registry.invokeAsync({
      providerId: 'stalled-execution',
      toolName: 'safe_echo',
      schemaFingerprint: tool?.schemaFingerprint ?? '',
      arguments: { message: 'must time out' },
      scopes: ['tools:invoke'],
      security: securityInvocation('timed-out-invocation'),
    }),
  ).rejects.toThrow('timed out');
});

test('bounds stalled host-transport discovery with the provider timeout', async () => {
  const httpServer = createServer(() => undefined);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a loopback test server port.');
  try {
    const registry = createMcpToolRegistry({
      providers: [
        {
          id: 'stalled',
          transport: 'remote',
          endpoint: 'https://mcp.example.test/mcp',
          allowedHosts: ['mcp.example.test'],
          allowedTools: [{ name: 'tool', grantedScopes: ['tools:invoke'] }],
          grantedScopes: ['tools:invoke'],
          timeoutMs: 100,
        },
      ],
      outboundTransport: {
        fetchAsync: async ({ init }) => fetch(`http://127.0.0.1:${address.port}/mcp`, init),
      },
    });
    await expect(registry.discoverAsync()).rejects.toThrow('timed out');
  } finally {
    httpServer.closeAllConnections();
    if (httpServer.listening)
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

test('redacts unsafe endpoint credentials from the stable error', () => {
  try {
    createMcpToolRegistry({
      providers: [
        {
          id: 'redaction',
          transport: 'remote',
          endpoint: 'https://operator:super-secret@mcp.example.test/endpoint',
          allowedHosts: ['mcp.example.test'],
          allowedTools: [{ name: 'tool', grantedScopes: ['tools:invoke'] }],
          grantedScopes: ['tools:invoke'],
        },
      ],
    });
    throw new Error('Expected endpoint validation to reject credentials.');
  } catch (error) {
    expect(error).toHaveProperty(
      'message',
      'Remote MCP endpoints cannot embed credentials or fragments.',
    );
    expect(String(error)).not.toContain('super-secret');
  }
});

test('rejects unsupported schemas instead of accepting arbitrary tool arguments', async () => {
  const httpServer = createServer(async (request, response) => {
    const server = new Server(
      { name: 'flow-invalid-schema', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'unsafe_schema',
          inputSchema: { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
        },
      ],
    }));
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
      providers: [
        {
          id: 'invalid-schema',
          transport: 'remote',
          endpoint: 'https://mcp.example.test/mcp',
          allowedHosts: ['mcp.example.test'],
          allowedTools: [{ name: 'unsafe_schema', grantedScopes: ['tools:invoke'] }],
          grantedScopes: ['tools:invoke'],
        },
      ],
      outboundTransport: {
        fetchAsync: async ({ init }) => fetch(`http://127.0.0.1:${address.port}/mcp`, init),
      },
    });
    await expect(registry.discoverAsync()).rejects.toThrow(
      'must set additionalProperties to false',
    );
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
    tools: [
      {
        name: 'remote_echo',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
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
