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
import { validateFlowApiHostname } from './utils/validateFlowApiHostname.js';

/*** Start the authenticated HTTP API without starting a durable worker. */
export const startFlowApiServerAsync = (
  input: {
    readonly access?: FlowHttpAccessPort;
    readonly authenticator?: FlowHttpAuthenticatorPort;
    readonly hostname?: string;
    readonly localDemo?: boolean;
    readonly persistencePath?: string;
    readonly port?: number;
    readonly runtime?: FlowRuntime;
  } = {},
) => {
  assertServerInput(input);
  const binding = validateFlowApiHostname(input.hostname ?? '127.0.0.1');
  if (input.localDemo && !binding.loopback) throw new Error('FLOW_LOCAL_DEMO_LOOPBACK_REQUIRED');
  const runtime = runtimeFor(input);
  const { access, authenticator } = securityFor(input);
  const server = Bun.serve({
    fetch: createFlowHttpHandler({ access, authenticator, runtime }),
    hostname: binding.hostname,
    port: input.port ?? 4318,
  });
  return {
    hostname: binding.hostname,
    port: server.port,
    runtime,
    stop: () => {
      void server.stop(true);
      return Promise.resolve();
    },
  };
};

/*** Run one client-independent durable Flow worker loop without opening an HTTP listener. */
export const startFlowWorkerAsync = (
  input: {
    readonly onError?: (error: unknown) => void;
    readonly persistencePath?: string;
    readonly runtime?: FlowRuntime;
    readonly workerIntervalMs?: number;
  } = {},
) => {
  assertWorkerInput(input);
  const runtime = runtimeFor(input);
  const loop = createWorkerLoop(runtime, input.workerIntervalMs ?? 100, input.onError);
  loop.start();
  return {
    runtime,
    stop: loop.stopAsync,
  };
};

/*** Start the historical combined API and worker process through the separated canonical boundaries. */
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
  const api = startFlowApiServerAsync(input);
  const worker = startFlowWorkerAsync({ ...input, runtime: api.runtime });
  return {
    ...api,
    stop: async () => {
      await worker.stop();
      await api.stop();
    },
  };
};

type ServerInput = NonNullable<Parameters<typeof startFlowApiServerAsync>[0]>;

/*** Reject insecure host composition before opening a network listener. */
const assertServerInput = (input: ServerInput): void => {
  if (!input.localDemo && (input.access === undefined || input.authenticator === undefined))
    throw new Error('FLOW_SERVER_SECURITY_CONFIG_REQUIRED');
  if (input.runtime === undefined && input.persistencePath === undefined)
    throw new Error('FLOW_PERSISTENCE_PATH_REQUIRED');
};

/** Reject an uncomposed worker before it can create ephemeral state. */
const assertWorkerInput = (
  input: NonNullable<Parameters<typeof startFlowWorkerAsync>[0]>,
): void => {
  if (input.runtime === undefined && input.persistencePath === undefined)
    throw new Error('FLOW_PERSISTENCE_PATH_REQUIRED');
  if (
    input.workerIntervalMs !== undefined &&
    (!Number.isSafeInteger(input.workerIntervalMs) || input.workerIntervalMs < 1)
  )
    throw new Error('FLOW_WORKER_INTERVAL_INVALID');
};

/*** Compose a persistent runtime unless an embedding host owns it directly. */
const runtimeFor = (input: Pick<ServerInput, 'persistencePath' | 'runtime'>): FlowRuntime =>
  input.runtime ??
  createFlowRuntime({
    nodeRegistry: createDefaultNodeRegistry(),
    persistence: FileFlowPersistenceAdapter(`${input.persistencePath}.durable`),
    store: input.persistencePath
      ? FileFlowRuntimeStore(input.persistencePath)
      : InMemoryFlowRuntimeStore(),
  });

/*** Serialize worker ticks, retain failures at the process edge, and fence shutdown from rescheduling. */
const createWorkerLoop = (
  runtime: FlowRuntime,
  intervalMs: number,
  onError: (error: unknown) => void = reportWorkerError,
) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = Promise.resolve();
  const isStopped = (): boolean => stopped;
  const runAsync = (): void => {
    active = (async () => {
      if (isStopped()) return;
      try {
        await runtime.runWorkerTickAsync();
      } catch (error) {
        try {
          onError(error);
        } catch (reportingError) {
          reportWorkerError(reportingError);
        }
      }
      if (!isStopped()) timer = setTimeout(runAsync, intervalMs);
    })();
  };
  return {
    start: () => {
      runAsync();
    },
    stopAsync: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await active;
    },
  };
};

/** Report a worker failure without leaking a rejected timer promise into the host runtime. */
const reportWorkerError = (error: unknown): void => {
  void error;
  process.stderr.write('FLOW_WORKER_TICK_FAILED\n');
};

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
