import type { AnkhCommandHandler } from '@ankhorage/ankh';

import { startFlowServerAsync } from '../../server.js';

/*** Start the authenticated standalone Flow server through the existing Ankh provider discovery. */
export const serve: AnkhCommandHandler = ({ argv }) => {
  const token = process.env.FLOW_API_TOKEN;
  if (!token) throw new Error('FLOW_API_TOKEN_REQUIRED');
  const port = readPort(argv);
  const persistencePath = readOption(argv, '--state') ?? '.flow/runtime.json';
  const attempts = new Map<string, number>();
  const server = startFlowServerAsync({
    access: {
      acquireAsync: ({ actor }) => {
        const minute = Math.floor(Date.now() / 60_000);
        const key = `${actor.id}:${minute}`;
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        return Promise.resolve(count <= 60);
      },
      authorizeAsync: () => Promise.resolve(true),
    },
    authenticator: {
      authenticateAsync: (request) =>
        Promise.resolve(
          request.headers.get('authorization') === `Bearer ${token}`
            ? {
                environment: 'standalone',
                id: 'token',
                projectId: 'standalone',
                tenantId: 'standalone',
              }
            : undefined,
        ),
    },
    persistencePath,
    port,
  });
  process.stdout.write(`Flow server listening on http://127.0.0.1:${server.port}\n`);
  return Promise.resolve();
};

/*** Read one optional server port without accepting invalid network configuration. */
const readPort = (argv: readonly string[]): number | undefined => {
  const value = readOption(argv, '--port');
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error('FLOW_PORT_INVALID');
  return port;
};

/*** Read one exact command option without interpreting unrelated Ankh arguments. */
const readOption = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`FLOW_OPTION_VALUE_REQUIRED:${name}`);
  return value;
};
