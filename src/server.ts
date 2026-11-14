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
    readonly persistencePath?: string;
    readonly port?: number;
    readonly runtime?: FlowRuntime;
    readonly workerIntervalMs?: number;
  } = {},
) => {
  const runtime =
    input.runtime ??
    createFlowRuntime({
      nodeRegistry: createDefaultNodeRegistry(),
      store: input.persistencePath
        ? FileFlowRuntimeStore(input.persistencePath)
        : InMemoryFlowRuntimeStore(),
    });
  const access = input.access ?? {
    acquireAsync: () => Promise.resolve(true),
    authorizeAsync: () => Promise.resolve(true),
  };
  const authenticator = input.authenticator ?? {
    authenticateAsync: () =>
      Promise.resolve({
        environment: 'local',
        id: 'local',
        projectId: 'local',
        tenantId: 'local',
      }),
  };
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
