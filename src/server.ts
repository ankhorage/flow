import { FileFlowPersistenceAdapter } from './features/execution/adapters/FileFlowPersistenceAdapter.js';
import { createDefaultNodeRegistry } from './features/execution/domain/createDefaultNodeRegistry.js';
import { createFlowHttpHandler } from './features/headless/adapters/createFlowHttpHandler.js';
import { FileFlowRuntimeStore } from './features/headless/adapters/FileFlowRuntimeStore.js';
import { InMemoryFlowRuntimeStore } from './features/headless/adapters/InMemoryFlowRuntimeStore.js';
import { createFlowRuntime } from './features/headless/application/createFlowRuntime.js';
import type {
  FlowHttpAccessPort,
  FlowHttpAuthenticatorPort,
  FlowRuntime,
} from './types/headless.js';

/*** Start a standalone Bun HTTP server and a client-independent Flow worker loop. */
export const startFlowServerAsync = (
  input: {
    readonly access?: FlowHttpAccessPort;
    readonly authenticator?: FlowHttpAuthenticatorPort;
    readonly hostname?: string;
    readonly localDemo?: boolean;
    readonly persistencePath?: string;
    readonly port?: number;
    readonly runtime?: FlowRuntime;
    readonly workerIntervalMs?: number;
  } = {},
) => {
  assertServerInput(input);
  const runtime = runtimeFor(input);
  const { access, authenticator } = securityFor(input);
  const server = Bun.serve({
    fetch: createFlowHttpHandler({ access, authenticator, runtime }),
    hostname: input.hostname ?? '127.0.0.1',
    port: input.port ?? 4318,
  });
  const timer = setInterval(() => void runtime.runWorkerTickAsync(), input.workerIntervalMs ?? 100);
  return {
    port: server.port,
    runtime,
    stop: () => {
      clearInterval(timer);
      void server.stop(true);
      return Promise.resolve();
    },
  };
};

type ServerInput = NonNullable<Parameters<typeof startFlowServerAsync>[0]>;

/*** Reject insecure host composition before opening a network listener. */
const assertServerInput = (input: ServerInput): void => {
  if (!input.localDemo && (input.access === undefined || input.authenticator === undefined))
    throw new Error('FLOW_SERVER_SECURITY_CONFIG_REQUIRED');
  if (input.localDemo && input.hostname !== undefined && input.hostname !== '127.0.0.1')
    throw new Error('FLOW_LOCAL_DEMO_LOOPBACK_REQUIRED');
  if (input.runtime === undefined && input.persistencePath === undefined)
    throw new Error('FLOW_PERSISTENCE_PATH_REQUIRED');
};

/*** Compose a persistent runtime unless an embedding host owns it directly. */
const runtimeFor = (input: ServerInput): FlowRuntime =>
  input.runtime ??
  createFlowRuntime({
    nodeRegistry: createDefaultNodeRegistry(),
    persistence: FileFlowPersistenceAdapter(`${input.persistencePath}.durable`),
    store: input.persistencePath
      ? FileFlowRuntimeStore(input.persistencePath)
      : InMemoryFlowRuntimeStore(),
  });

/*** Provide permissive boundaries only for an explicit loopback local demonstration. */
const securityFor = (
  input: ServerInput,
): { readonly access: FlowHttpAccessPort; readonly authenticator: FlowHttpAuthenticatorPort } => ({
  access: input.access ?? {
    acquireAsync: () => Promise.resolve(true),
    authorizeAsync: () => Promise.resolve(true),
  },
  authenticator: input.authenticator ?? {
    authenticateAsync: () =>
      Promise.resolve({ environment: 'local', id: 'local', projectId: 'local', tenantId: 'local' }),
  },
});
