import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const packageRoot = process.cwd();
const temporaryCacheDirectory = join(tmpdir(), 'flow-packed-consumer-cache');

const runCommand = (
  command: string[],
  cwd: string,
  environment: Record<string, string> = {},
): string => {
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: temporaryCacheDirectory,
      npm_config_cache: temporaryCacheDirectory,
      ...environment,
    },
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode, output).toBe(0);
  return output;
};

const writeConsumerFiles = (consumerDirectory: string): void => {
  writeFileSync(
    join(consumerDirectory, 'consumer.mjs'),
    [
      "import { createFlowSecurityPort } from '@ankhorage/flow';",
      "import '@ankhorage/flow/ai';",
      "import '@ankhorage/flow/execution';",
      "import { createMcpToolRegistry } from '@ankhorage/flow/mcp';",
      "import '@ankhorage/flow/social';",
      "import '@ankhorage/contracts/flow';",
      "const registry = createMcpToolRegistry({ providers: [{ id: 'provider', transport: 'stdio', allowedTools: [{ name: 'safe_echo', grantedScopes: ['tools:invoke'] }], grantedScopes: ['tools:invoke'] }] });",
      "await registry.discoverAsync().then(() => { throw new Error('Expected MCP discovery to fail.'); }, (error) => { if (!(error instanceof Error) || !error.message.includes(process.env.FLOW_MCP_ERROR ?? '')) throw error; });",
    ].join('\n'),
  );
  writeFileSync(
    join(consumerDirectory, 'consumer.ts'),
    [
      "import { createFlowSecurityPort } from '@ankhorage/flow';",
      "import '@ankhorage/flow/ai';",
      "import '@ankhorage/flow/execution';",
      "import { createMcpToolRegistry } from '@ankhorage/flow/mcp';",
      "import '@ankhorage/flow/social';",
      "import '@ankhorage/contracts/flow';",
      "import type { FlowDefinition } from '@ankhorage/contracts/flow';",
      "const definition: FlowDefinition = { id: 'consumer-flow', version: 1, title: 'Consumer flow', nodes: [], edges: [], triggers: [{ id: 'manual', kind: 'manual' }] };",
      'void definition;',
      'void createFlowSecurityPort;',
      'void createMcpToolRegistry;',
    ].join('\n'),
  );
  writeFileSync(
    join(consumerDirectory, 'mcp-server.mjs'),
    [
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
      "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
      "const server = new Server({ name: 'packed-flow-test', version: '1.0.0' }, { capabilities: { tools: {} } });",
      "server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'safe_echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));",
      'await server.connect(new StdioServerTransport());',
    ].join('\n'),
  );
  writeFileSync(
    join(consumerDirectory, 'consumer-with-sdk.mjs'),
    [
      "import { createMcpToolRegistry } from '@ankhorage/flow/mcp';",
      "const registry = createMcpToolRegistry({ providers: [{ id: 'provider', transport: 'stdio', allowedTools: [{ name: 'safe_echo', grantedScopes: ['tools:invoke'] }], grantedScopes: ['tools:invoke'] }], trustedStdioProviders: { provider: { command: process.execPath, args: [new URL('./mcp-server.mjs', import.meta.url).pathname] } } });",
      'const tools = await registry.discoverAsync();',
      "if (tools.length !== 1 || tools[0]?.name !== 'safe_echo') throw new Error('Expected packed MCP discovery to succeed.');",
    ].join('\n'),
  );
};

const packAndInstall = (consumerDirectory: string, packedDirectory: string): void => {
  runCommand(['bun', 'run', 'build'], packageRoot);
  runCommand(
    ['npm', 'pack', '--ignore-scripts', '--pack-destination', packedDirectory],
    packageRoot,
  );

  const archiveName = readdirSync(packedDirectory).find((entry) => entry.endsWith('.tgz'));
  expect(archiveName).toBeDefined();
  runCommand(
    ['bun', 'add', '--ignore-scripts', join(packedDirectory, archiveName ?? 'missing.tgz')],
    consumerDirectory,
  );
};

const installMcpSdk = (consumerDirectory: string): void => {
  runCommand(['bun', 'add', '--ignore-scripts', '@modelcontextprotocol/sdk'], consumerDirectory);
};

const verifyTypes = (consumerDirectory: string): void => {
  runCommand(
    [
      join(packageRoot, 'node_modules/.bin/tsc'),
      '--noEmit',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      'consumer.ts',
    ],
    consumerDirectory,
  );
};

const verifyConsumerWithoutSdk = (consumerDirectory: string, mcpError: string): void => {
  runCommand(['node', 'consumer.mjs'], consumerDirectory, { FLOW_MCP_ERROR: mcpError });
  runCommand(['bun', 'consumer.mjs'], consumerDirectory, { FLOW_MCP_ERROR: mcpError });
  verifyTypes(consumerDirectory);
};

describe('packed Flow consumer', () => {
  it('imports every public subpath and fails MCP execution closed without the optional SDK', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'flow-packed-consumer-'));
    const consumerDirectory = join(temporaryDirectory, 'package');
    const packedDirectory = join(temporaryDirectory, 'packed');

    try {
      mkdirSync(consumerDirectory);
      mkdirSync(packedDirectory);
      writeFileSync(
        join(consumerDirectory, 'package.json'),
        JSON.stringify({ name: 'flow-packed-consumer', private: true, type: 'module' }),
      );
      writeConsumerFiles(consumerDirectory);
      packAndInstall(consumerDirectory, packedDirectory);
      expect(existsSync(join(consumerDirectory, 'node_modules/@modelcontextprotocol/sdk'))).toBe(
        false,
      );
      verifyConsumerWithoutSdk(
        consumerDirectory,
        'optional @modelcontextprotocol/sdk peer dependency',
      );
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 30_000);

  it('runs MCP through Node ESM, Bun, and TypeScript after the consumer installs the SDK', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'flow-packed-consumer-'));
    const consumerDirectory = join(temporaryDirectory, 'package');
    const packedDirectory = join(temporaryDirectory, 'packed');

    try {
      mkdirSync(consumerDirectory);
      mkdirSync(packedDirectory);
      writeFileSync(
        join(consumerDirectory, 'package.json'),
        JSON.stringify({ name: 'flow-packed-consumer', private: true, type: 'module' }),
      );
      writeConsumerFiles(consumerDirectory);
      packAndInstall(consumerDirectory, packedDirectory);
      installMcpSdk(consumerDirectory);
      expect(existsSync(join(consumerDirectory, 'node_modules/@modelcontextprotocol/sdk'))).toBe(
        true,
      );
      runCommand(['node', 'consumer-with-sdk.mjs'], consumerDirectory);
      runCommand(['bun', 'consumer-with-sdk.mjs'], consumerDirectory);
      verifyTypes(consumerDirectory);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});
