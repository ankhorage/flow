import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const packageRoot = process.cwd();
const temporaryCacheDirectory = join(tmpdir(), 'flow-packed-consumer-cache');

const runCommand = (command: string[], cwd: string): string => {
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: temporaryCacheDirectory,
      npm_config_cache: temporaryCacheDirectory,
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
      "import '@ankhorage/flow';",
      "import '@ankhorage/flow/ai';",
      "import '@ankhorage/flow/execution';",
      "import '@ankhorage/flow/social';",
      "import '@ankhorage/contracts/flow';",
    ].join('\n'),
  );
  writeFileSync(
    join(consumerDirectory, 'consumer.ts'),
    [
      "import '@ankhorage/flow';",
      "import '@ankhorage/flow/ai';",
      "import '@ankhorage/flow/execution';",
      "import '@ankhorage/flow/social';",
      "import '@ankhorage/contracts/flow';",
      "import type { FlowDefinition } from '@ankhorage/contracts/flow';",
      "const definition: FlowDefinition = { id: 'consumer-flow', version: 1, title: 'Consumer flow', nodes: [], edges: [], triggers: [{ id: 'manual', kind: 'manual' }] };",
      'void definition;',
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

const verifyConsumer = (consumerDirectory: string): void => {
  expect(existsSync(join(consumerDirectory, 'node_modules/@modelcontextprotocol/sdk'))).toBe(false);
  runCommand(['node', 'consumer.mjs'], consumerDirectory);
  runCommand(['bun', 'consumer.mjs'], consumerDirectory);
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

describe('packed Flow consumer', () => {
  it('supports Node ESM, Bun, and TypeScript without resolving the optional MCP SDK', () => {
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
      verifyConsumer(consumerDirectory);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
