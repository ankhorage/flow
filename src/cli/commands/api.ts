import { startFlowApiServerAsync } from '../../server.js';
import { validateFlowApiHostname } from '../../utils/validateFlowApiHostname.js';
import { loadFlowRuntimeAsync } from '../loadFlowRuntimeAsync.js';
import { registerProcessShutdown } from '../registerProcessShutdown.js';

/*** Start only the authenticated Flow API against an explicitly composed shared runtime. */
export const api = async (argv: readonly string[]): Promise<void> => {
  const token = requireApiToken();
  const hostname = readHostname();
  const server = startFlowApiServerAsync({
    access: createAccess(),
    authenticator: createAuthenticator(token),
    hostname,
    port: readPort(argv),
    runtime: await loadFlowRuntimeAsync(),
  });
  registerProcessShutdown(server.stop);
  process.stdout.write(`Flow API listening on http://${server.hostname}:${server.port}\n`);
};

/** Read the API token at the process edge without making a local deployment insecure by default. */
const requireApiToken = (): string => {
  const token = process.env.FLOW_API_TOKEN;
  if (!token) throw new Error('FLOW_API_TOKEN_REQUIRED');
  return token;
};

/** Provide the standalone server's bounded request gate. */
const createAccess = () => {
  const attempts = new Map<string, number>();
  return {
    acquireAsync: ({ actor }: { readonly actor: { readonly id: string } }) => {
      const minute = Math.floor(Date.now() / 60_000);
      const key = `${actor.id}:${minute}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return Promise.resolve(count <= 60);
    },
    authorizeAsync: () => Promise.resolve(true),
  };
};

/** Authenticate the standalone bearer token while retaining server-owned request identity. */
const createAuthenticator = (token: string) => ({
  authenticateAsync: (request: Request) =>
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
});

/** Read one optional API port without accepting invalid network configuration. */
const readPort = (argv: readonly string[]): number | undefined => {
  const index = argv.indexOf('--port');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  const port = Number(value);
  if (!value || value.startsWith('--') || !Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error('FLOW_PORT_INVALID');
  return port;
};

/** Read and validate the deployment-selected public listener address when it is explicitly set. */
const readHostname = (): string | undefined => {
  const hostname = process.env.FLOW_API_HOSTNAME;
  if (hostname === undefined) return undefined;
  return validateFlowApiHostname(hostname).hostname;
};
