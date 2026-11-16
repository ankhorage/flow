import type { FlowAuditRecord, FlowObservabilityPort } from '../../../types/headless.js';

/** Create bounded, redaction-safe telemetry for embedded runtimes and deterministic tests. */
export const InMemoryFlowObservability = (retention = 1_000): FlowObservabilityPort => {
  const audit: FlowAuditRecord[] = [];
  const metrics = new Map<string, number>();
  return {
    recordAsync: (record) => {
      audit.push(record);
      if (audit.length > retention) audit.splice(0, audit.length - retention);
      metrics.set(record.action, (metrics.get(record.action) ?? 0) + 1);
      return Promise.resolve();
    },
    snapshotAsync: () =>
      Promise.resolve({ audit: [...audit], metrics: Object.fromEntries(metrics.entries()) }),
  };
};
