import { startFlowWorkerAsync } from '../../src/server.js';
import { registerProcessShutdown } from '../../src/cli/registerProcessShutdown.js';
import {
  InMemoryFlowPersistenceAdapter,
  InMemoryFlowRuntimeStore,
  createDefaultNodeRegistry,
  createFlowRuntime,
} from '../../src/index.js';

const mode = process.argv[2];

if (mode === 'worker') {
  const runtime = createFlowRuntime({
    nodeRegistry: createDefaultNodeRegistry(),
    persistence: InMemoryFlowPersistenceAdapter(),
    store: InMemoryFlowRuntimeStore(),
  });
  const worker = startFlowWorkerAsync({
    runtime: {
      ...runtime,
      runWorkerTickAsync: async (): Promise<readonly string[]> => {
        throw new Error('Bearer SENTINEL_SECRET');
      },
    },
    workerIntervalMs: 1,
  });
  setTimeout(() => void worker.stop(), 10);
} else if (mode === 'shutdown') {
  registerProcessShutdown(async () => {
    throw new Error('Bearer SENTINEL_SECRET');
  });
  process.kill(process.pid, 'SIGTERM');
  setTimeout(() => process.exit(process.exitCode), 10);
} else {
  throw new Error('FLOW_TEST_MODE_REQUIRED');
}
