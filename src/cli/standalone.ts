import { startFlowServerAsync } from '../server.js';

/*** Start Flow directly for local standalone operation without changing Ankh command semantics. */
const startAsync = (): Promise<void> => {
  const token = process.env.FLOW_API_TOKEN;
  if (!token) throw new Error('FLOW_API_TOKEN_REQUIRED');
  const port = Number(process.env.FLOW_PORT ?? '4318');
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
    persistencePath: process.env.FLOW_STATE_PATH ?? '.flow/runtime.json',
    port,
  });
  process.stdout.write(`Flow server listening on http://127.0.0.1:${server.port}\n`);
  return Promise.resolve();
};

void startAsync();
