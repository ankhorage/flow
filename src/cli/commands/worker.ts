import { startFlowWorkerAsync } from '../../server.js';
import { loadFlowRuntimeAsync } from '../loadFlowRuntimeAsync.js';
import { registerProcessShutdown } from '../registerProcessShutdown.js';

/*** Start only the durable Flow worker against an explicitly composed shared runtime. */
export const worker = async (_argv: readonly string[]): Promise<void> => {
  if (_argv.length === 1 && _argv[0] === 'health') {
    await loadFlowRuntimeAsync();
    process.stdout.write('Flow worker runtime ready\n');
    return;
  }
  if (_argv.length > 0) throw new Error('FLOW_WORKER_ARGUMENT_INVALID');
  const workerProcess = startFlowWorkerAsync({ runtime: await loadFlowRuntimeAsync() });
  registerProcessShutdown(workerProcess.stop);
  process.stdout.write('Flow worker started\n');
};
