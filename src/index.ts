/*** Headless graph compilation and deterministic single-process execution. */
export { executeFlowAsync } from './features/execution/application/executeFlowAsync.js';
export { compileFlowGraph } from './features/execution/domain/compileFlowGraph.js';
export { createDefaultNodeRegistry } from './features/execution/domain/createDefaultNodeRegistry.js';
export { createFlowSecurityPort } from './features/security/application/createFlowSecurityPort.js';
export { FlowSecurityError } from './features/security/FlowSecurityError.js';
export type {
  FlowClock,
  FlowCompiledGraph,
  FlowExecutionResult,
  FlowNodeOperation,
  FlowNodeOperationResult,
  FlowNodeRegistry,
  FlowRunRequest,
} from './types/execution.js';
export type {
  FlowApprovalStorePort,
  FlowRateLimitPort,
  FlowResolvedSecrets,
  FlowSecretMetadata,
  FlowSecurityActor,
  FlowSecurityApproval,
  FlowSecurityAuditEvent,
  FlowSecurityAuditPort,
  FlowSecurityGrant,
  FlowSecurityOperation,
  FlowSecurityPermit,
  FlowSecurityPort,
} from './types/security.js';
