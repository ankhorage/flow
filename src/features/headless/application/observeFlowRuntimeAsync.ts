import type { FlowRuntimeDependencies } from '../../../types/headless.js';

/** Emit redaction-safe Flow lifecycle telemetry through the host-owned observability port. */
export const observeFlowRuntimeAsync = async (
  dependencies: FlowRuntimeDependencies,
  category: 'approval' | 'execution' | 'validation',
  action: string,
  occurredAt: string,
  runId?: string,
): Promise<void> =>
  dependencies.observability?.recordAsync({
    action,
    category,
    occurredAt,
    ...(runId === undefined ? {} : { runId }),
  }) ?? Promise.resolve();
