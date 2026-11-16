# Public API

## calculateRetryDueAt

Kind: `value`
Module: `src/features/execution/domain/calculateRetryDueAt.ts`
Source: `src/features/execution/domain/calculateRetryDueAt.ts:4:14`

Calculate an exponential retry time from persisted attempt state without ambient time.

### Signatures

- `(now: Date, completedAttempt: number, policy: FlowRetryPolicy) => string`
  - completedAttempt: `number`
  - now: `Date`
  - policy: `FlowRetryPolicy`
  - returns: `string`

## compileFlowGraph

Kind: `value`
Module: `src/features/execution/domain/compileFlowGraph.ts`
Source: `src/features/execution/domain/compileFlowGraph.ts:6:14`

Compile a valid acyclic graph into deterministic execution order.

### Signatures

- `(definition: FlowDefinition, registry: Readonly<Record<string, import("../../../index.js").FlowNodeOperation>>) => FlowCompiledGraph`
  - definition: `FlowDefinition`
  - registry: `Readonly<Record<string, import("../../../index.js").FlowNodeOperation>>`
  - returns: `FlowCompiledGraph`

## createDefaultNodeRegistry

Kind: `value`
Module: `src/features/execution/domain/createDefaultNodeRegistry.ts`
Source: `src/features/execution/domain/createDefaultNodeRegistry.ts:6:14`

Create the built-in operations that have no provider or host dependency.

### Signatures

- `() => Readonly<Record<string, FlowNodeOperation>>`
  - returns: `Readonly<Record<string, FlowNodeOperation>>`

## createDurableRun

Kind: `value`
Module: `src/features/execution/domain/createDurableRun.ts`
Source: `src/features/execution/domain/createDurableRun.ts:4:14`

Create a revision-zero run pinned permanently to one published flow definition.

### Signatures

- `(input: { readonly flow: FlowDefinitionRef; readonly id: string; }, now: Date) => FlowDurableRun`
  - input: `{ readonly flow: FlowDefinitionRef; readonly id: string; }`
  - now: `Date`
  - returns: `FlowDurableRun`

## createDurableRunAsync

Kind: `value`
Module: `src/features/execution/application/createDurableRunAsync.ts`
Source: `src/features/execution/application/createDurableRunAsync.ts:8:14`

Persist a new durable run without executing an operation or provider effect.

### Signatures

- `(input: { readonly flow: FlowDefinitionRef; readonly id: string; readonly scope?: FlowResourceScope; }, dependencies: { readonly clock: FlowClock; readonly persistence: FlowPersistencePort; }) => Promise<FlowDurableRun>`
  - dependencies: `{ readonly clock: FlowClock; readonly persistence: FlowPersistencePort; }`
  - input: `{ readonly flow: FlowDefinitionRef; readonly id: string; readonly scope?: FlowResourceScope; }`
  - returns: `Promise<FlowDurableRun>`

## createFlowRuntime

Kind: `value`
Module: `src/features/headless/application/createFlowRuntime.ts`
Source: `src/features/headless/application/createFlowRuntime.ts:24:14`

Compose the canonical versioned workflow API and client-independent worker boundary.

### Signatures

- `(dependencies: FlowRuntimeDependencies) => FlowRuntime`
  - dependencies: `FlowRuntimeDependencies`
  - returns: `FlowRuntime`

## createFlowSecurityPort

Kind: `value`
Module: `src/features/security/application/createFlowSecurityPort.ts`
Source: `src/features/security/application/createFlowSecurityPort.ts:33:14`

Creates the provider-neutral server-side authorization, approval, audit, and secret boundary.

### Signatures

- `(input: { readonly approvalStore: FlowApprovalStorePort; readonly audit: FlowSecurityAuditPort; readonly grants: readonly FlowSecurityGrant[]; readonly operationStore: FlowOperationStorePort; readonly rateLimit: FlowRateLimitPort; readonly secretStore: SecretStoreAdapter; }) => FlowSecurityPort`
  - input: `{ readonly approvalStore: FlowApprovalStorePort; readonly audit: FlowSecurityAuditPort; readonly grants: readonly FlowSecurityGrant[]; readonly operationStore: FlowOperationStorePort; readonly rateLimit: FlowRateLimitPort; readonly secretStore: SecretStoreAdapter; }`
  - returns: `FlowSecurityPort`

## createRetryWork

Kind: `value`
Module: `src/features/execution/domain/createRetryWork.ts`
Source: `src/features/execution/domain/createRetryWork.ts:5:14`

Create the next immutable work attempt from a completed attempt and controlled clock.

### Signatures

- `(completed: FlowDurableWork, now: Date, policy: FlowRetryPolicy) => FlowDurableWork`
  - completed: `FlowDurableWork`
  - now: `Date`
  - policy: `FlowRetryPolicy`
  - returns: `FlowDurableWork`

## executeFlowAsync

Kind: `value`
Module: `src/features/execution/application/executeFlowAsync.ts`
Source: `src/features/execution/application/executeFlowAsync.ts:21:14`

Execute a compiled graph in deterministic order within one process.

### Signatures

- `(graph: FlowCompiledGraph, registry: Readonly<Record<string, import("../../../index.js").FlowNodeOperation>>, request: FlowRunRequest, clock?: FlowClock) => Promise<FlowExecutionResult>`
  - clock: `FlowClock` (optional)
  - graph: `FlowCompiledGraph`
  - registry: `Readonly<Record<string, import("../../../index.js").FlowNodeOperation>>`
  - request: `FlowRunRequest`
  - returns: `Promise<FlowExecutionResult>`

## FileFlowPersistenceAdapter

Kind: `value`
Module: `src/features/execution/adapters/FileFlowPersistenceAdapter.ts`
Source: `src/features/execution/adapters/FileFlowPersistenceAdapter.ts:21:14`

Create a self-hostable, single-process JSON persistence adapter for durable Flow state.

### Signatures

- `(path: string) => FlowPersistencePort`
  - path: `string`
  - returns: `FlowPersistencePort`

## FileFlowRuntimeStore

Kind: `value`
Module: `src/features/headless/adapters/FileFlowRuntimeStore.ts`
Source: `src/features/headless/adapters/FileFlowRuntimeStore.ts:43:14`

### Signatures

- `(path: string) => FlowRuntimeStorePort`
  - path: `string`
  - returns: `FlowRuntimeStorePort`

## FlowApprovalStorePort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:53:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| getAsync | method | `(operation: FlowSecurityOperationIdentity) => Promise<FlowSecurityApproval \| undefined>` | yes |  |

## FlowAuditRecord

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:126:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| action | property | `string` | yes |  |
| category | property | `"approval" \| "execution" \| "validation"` | yes |  |
| occurredAt | property | `string` | yes |  |
| runId | property | `string \| undefined` | no |  |

## FlowClock

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:14:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| now | property | `() => Date` | yes |  |

## FlowCompiledGraph

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:56:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| definition | property | `FlowDefinition` | yes |  |
| edgesBySourceNodeId | property | `Readonly<Record<string, readonly FlowEdge[]>>` | yes |  |
| topologicalNodeIds | property | `readonly string[]` | yes |  |

## FlowDefinitionRef

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:7:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| id | property | `string` | yes |  |
| version | property | `number` | yes |  |

## FlowDurableEffectPort

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:60:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| compensateAsync | property | `((input: { readonly run: FlowDurableRun; readonly work: FlowDurableWork; }) => Promise<FlowDurableEffectResult \| void>) \| undefined` | no |  |
| executeAsync | property | `(input: { readonly idempotencyKey: string; readonly run: FlowDurableRun; readonly work: FlowDurableWork; }) => Promise<FlowDurableEffectResult \| void>` | yes |  |
| reconcileAsync | property | `((input: { readonly idempotencyKey: string; readonly run: FlowDurableRun; readonly work: FlowDurableWork; }) => Promise<FlowDurableEffectResult \| "unknown">) \| undefined` | no |  |

## FlowDurableEffectResult

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:53:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| checkpoint | property | `FlowRunCheckpoint \| undefined` | no |  |
| nextWork | property | `readonly FlowDurableWork[] \| undefined` | no |  |
| status | property | `"cancelled" \| "failed" \| "queued" \| "running" \| "succeeded" \| "waiting_approval" \| undefined` | no |  |

## FlowDurableRun

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:12:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| checkpoint | property | `FlowRunCheckpoint \| undefined` | no |  |
| createdAt | property | `string` | yes |  |
| flow | property | `FlowDefinitionRef` | yes |  |
| id | property | `string` | yes |  |
| revision | property | `number` | yes |  |
| scope | property | `FlowResourceScope \| undefined` | no |  |
| status | property | `"cancelled" \| "failed" \| "queued" \| "running" \| "succeeded" \| "waiting_approval"` | yes |  |
| updatedAt | property | `string` | yes |  |

## FlowDurableWork

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:23:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| attempt | property | `number` | yes |  |
| dueAt | property | `string` | yes |  |
| effectKind | property | `"internal" \| "protected"` | yes |  |
| flow | property | `FlowDefinitionRef` | yes |  |
| id | property | `string` | yes |  |
| idempotencyKey | property | `string \| undefined` | no |  |
| input | property | `Readonly<Record<string, FlowDataRef>> \| undefined` | no |  |
| lease | property | `{ readonly expiresAt: string; readonly fencingToken: number; readonly workerId: string; } \| undefined` | no |  |
| runId | property | `string` | yes |  |
| securityOperation | property | `FlowSecurityOperation \| undefined` | no |  |
| status | property | `"cancelled" \| "claimed" \| "completed" \| "ready"` | yes |  |
| stepId | property | `string \| undefined` | no |  |
| triggerId | property | `string \| undefined` | no |  |

## FlowExecutionResult

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:69:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| run | property | `FlowRunSnapshot` | yes |  |

## FlowHttpAccessPort

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:102:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| acquireAsync | method | `(input: { readonly actor: FlowSecurityActor; readonly capability: string; }) => Promise<boolean>` | yes |  |
| authorizeAsync | method | `(input: { readonly actor: FlowSecurityActor; readonly capability: string; }) => Promise<boolean>` | yes |  |

## FlowHttpAuthenticatorPort

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:97:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| authenticateAsync | method | `(request: Request) => Promise<FlowSecurityActor \| undefined>` | yes |  |

## FlowNodeEffect

Kind: `unknown`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:25:1`

## FlowNodeEffectIdentity

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:21:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| idempotencyKey | property | `string` | yes |  |

## FlowNodeOperation

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:35:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| effect | property | `FlowNodeEffect` | yes |  |
| executeAsync | property | `(input: { readonly config: FlowNodeConfig \| undefined; readonly effect: FlowNodeEffectIdentity; readonly input: Readonly<Record<FlowPortId, FlowDataRef>>; readonly node: FlowNode; readonly signal: AbortSignal; }) => Promise<FlowNodeOperationResult>` | yes |  |
| reconcileAsync | property | `((input: { readonly config: FlowNodeConfig \| undefined; readonly effect: FlowNodeEffectIdentity; readonly input: Readonly<Record<FlowPortId, FlowDataRef>>; readonly node: FlowNode; }) => Promise<FlowNodeOperationResult \| "unknown">) \| undefined` | no |  |

## FlowNodeOperationResult

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:17:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| output | property | `Readonly<Record<string, FlowDataRef>> \| undefined` | no |  |

## FlowNodeRegistry

Kind: `unknown`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:55:1`

## FlowObservabilityPort

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:134:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| recordAsync | method | `(record: FlowAuditRecord) => Promise<void>` | yes |  |
| snapshotAsync | method | `() => Promise<{ readonly audit: readonly FlowAuditRecord[]; readonly metrics: Readonly<Record<string, number>>; }>` | yes |  |

## FlowOperationStorePort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:61:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| claimAsync | method | `(operation: FlowSecurityOperationIdentity) => Promise<boolean>` | yes |  |
| consumeAsync | method | `(operation: FlowSecurityOperationIdentity) => Promise<boolean>` | yes |  |
| releaseAsync | method | `(operation: FlowSecurityOperationIdentity) => Promise<void>` | yes |  |

## FlowOutboundTransportPort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:72:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| fetchAsync | method | `(input: { readonly allowedHosts: readonly string[]; readonly init?: RequestInit; readonly url: string; }) => Promise<Response>` | yes |  |

## FlowOutboxRecord

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:108:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| createdAt | property | `string` | yes |  |
| id | property | `string` | yes |  |
| idempotencyKey | property | `string` | yes |  |
| payload | property | `import("@ankhorage/contracts/dist/serializable.js").SerializableValue \| undefined` | no |  |
| result | property | `FlowDurableEffectResult \| undefined` | no |  |
| runId | property | `string` | yes |  |
| status | property | `"delivered" \| "pending"` | yes |  |
| workId | property | `string` | yes |  |

## FlowPersistencePort

Kind: `type`
Module: `src/features/execution/ports/FlowPersistencePort.ts`
Source: `src/features/execution/ports/FlowPersistencePort.ts:8:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| cancelRunWorkAsync | property | `(runId: string) => Promise<readonly string[]>` | yes |  |
| claimDueWorkAsync | property | `(input: { readonly leaseDurationMs: number; readonly limit: number; readonly now: Date; readonly workerId: string; }) => Promise<readonly FlowDurableWork[]>` | yes |  |
| completeWorkAsync | property | `(input: { readonly id: string; readonly leaseFencingToken: number; readonly now: Date; readonly workerId: string; }) => Promise<boolean>` | yes |  |
| createOutboxAsync | property | `(record: FlowOutboxRecord) => Promise<void>` | yes |  |
| createRunAsync | property | `(run: FlowDurableRun) => Promise<void>` | yes |  |
| enqueueWorkAsync | property | `(work: FlowDurableWork) => Promise<void>` | yes |  |
| finalizeWorkAsync | property | `(input: { readonly expectedRevision: number; readonly nextWork: readonly FlowDurableWork[]; readonly now: Date; readonly run: FlowDurableRun; readonly workId: string; readonly leaseFencingToken: number; readonly workerId: string; }) => Promise<boolean>` | yes |  |
| markOutboxDeliveredAsync | property | `(id: string, result?: FlowDurableEffectResult) => Promise<boolean>` | yes |  |
| readOutboxAsync | property | `(id: string) => Promise<FlowOutboxRecord \| undefined>` | yes |  |
| readRunAsync | property | `(id: string) => Promise<FlowDurableRun \| undefined>` | yes |  |
| readWorkAsync | property | `(id: string) => Promise<FlowDurableWork \| undefined>` | yes |  |
| recoverExpiredClaimsAsync | property | `(now: Date) => Promise<readonly string[]>` | yes |  |
| releaseWorkAsync | property | `(input: { readonly dueAt: string; readonly id: string; readonly leaseFencingToken: number; readonly workerId: string; }) => Promise<boolean>` | yes |  |
| transitionRunAsync | property | `(input: { readonly expectedRevision: number; readonly run: FlowDurableRun; }) => Promise<boolean>` | yes |  |
| verifyClaimAsync | property | `(input: { readonly leaseFencingToken: number; readonly now: Date; readonly workId: string; readonly workerId: string; }) => Promise<boolean>` | yes |  |

## FlowRateLimitPort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:81:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| acquireAsync | method | `(input: { readonly actor: FlowSecurityActor; readonly capability: string; readonly operationId: string; }) => Promise<boolean>` | yes |  |

## FlowResolvedSecrets

Kind: `unknown`
Module: `src/types/security.ts`
Source: `src/types/security.ts:116:1`

## FlowRetryPolicy

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:46:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| baseDelayMs | property | `number` | yes |  |
| maxAttempts | property | `number` | yes |  |
| maxDelayMs | property | `number` | yes |  |

## FlowRunCheckpoint

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:99:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| completedStepIds | property | `readonly string[]` | yes |  |
| data | property | `import("@ankhorage/contracts/dist/serializable.js").SerializableValue \| undefined` | no |  |
| failedStepIds | property | `readonly string[]` | yes |  |
| steps | property | `readonly FlowStepSnapshot[] \| undefined` | no |  |

## FlowRunEvent

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:29:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| id | property | `number` | yes |  |
| runId | property | `string` | yes |  |
| timestamp | property | `string` | yes |  |
| trace | property | `FlowTraceEvent \| undefined` | no |  |
| type | property | `"approval_resolved" \| "run_cancelled" \| "run_completed" \| "run_progressed" \| "run_queued" \| "run_started"` | yes |  |

## FlowRunRequest

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:61:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| effectIdentity | property | `FlowNodeEffectIdentity \| undefined` | no |  |
| input | property | `Readonly<Record<string, FlowDataRef>> \| undefined` | no |  |
| runId | property | `string` | yes |  |
| schemaRegistry | property | `Readonly<Record<string, import("@ankhorage/contracts/data").DataSchema>> \| undefined` | no |  |
| signal | property | `AbortSignal \| undefined` | no |  |
| triggerId | property | `string` | yes |  |

## FlowRuntime

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:143:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| cancelRunAsync | method | `(scope: FlowResourceScope, runId: string) => Promise<FlowRunSnapshot \| undefined>` | yes |  |
| createDraftAsync | method | `(scope: FlowResourceScope, definition: FlowDefinition) => Promise<FlowWorkflowRevision>` | yes |  |
| getRunAsync | method | `(scope: FlowResourceScope, runId: string) => Promise<FlowRunSnapshot \| undefined>` | yes |  |
| getWorkflowAsync | method | `(scope: FlowResourceScope, flowId: string, version?: number) => Promise<FlowWorkflowRevision \| undefined>` | yes |  |
| listRunsAsync | method | `(scope: FlowResourceScope, flowId?: string) => Promise<readonly FlowRunSnapshot[]>` | yes |  |
| listWorkflowRevisionsAsync | method | `(scope: FlowResourceScope, flowId: string) => Promise<readonly FlowWorkflowRevision[]>` | yes |  |
| publishAsync | method | `(scope: FlowResourceScope, flowId: string, version: number) => Promise<FlowWorkflowRevision \| undefined>` | yes |  |
| readEventsAsync | method | `(scope: FlowResourceScope, afterId: number, runId?: string) => Promise<readonly FlowRunEvent[]>` | yes |  |
| requestApprovalAsync | method | `(input: { readonly approval: FlowApprovalRequest; readonly scope: FlowResourceScope; }) => Promise<void>` | yes |  |
| resolveApprovalAsync | method | `(input: { readonly actorId: string; readonly approvalId: string; readonly approved: boolean; readonly scope: FlowResourceScope; }) => Promise<FlowApprovalRequest \| undefined>` | yes |  |
| retryRunAsync | method | `(scope: FlowResourceScope, runId: string) => Promise<FlowRunSnapshot \| undefined>` | yes |  |
| runWorkerTickAsync | method | `() => Promise<readonly string[]>` | yes |  |
| triggerAsync | method | `(input: { readonly flowId: string; readonly idempotencyKey: string; readonly input?: Readonly<Record<string, { readonly kind: "inline"; readonly value: DataContractValue; }>>; readonly scope: FlowResourceScope; readonly triggerId: string; }) => Promise<FlowRunSnapshot>` | yes |  |

## FlowRuntimeDependencies

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:114:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| clock | property | `FlowClock \| undefined` | no |  |
| nodeRegistry | property | `Readonly<Record<string, import("./execution.js").FlowNodeOperation>>` | yes |  |
| observability | property | `FlowObservabilityPort \| undefined` | no |  |
| persistence | property | `FlowPersistencePort` | yes |  |
| schemaRegistry | property | `Readonly<Record<string, import("@ankhorage/contracts/data").DataSchema>> \| undefined` | no |  |
| security | property | `FlowSecurityPort \| undefined` | no |  |
| store | property | `FlowRuntimeStorePort` | yes |  |

## FlowRuntimeStorePort

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:44:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| createDraftAsync | method | `(scope: FlowResourceScope, definition: FlowDefinition) => Promise<FlowWorkflowRevision>` | yes |  |
| getRunAsync | method | `(scope: FlowResourceScope, runId: string) => Promise<FlowRunSnapshot \| undefined>` | yes |  |
| getWorkflowAsync | method | `(scope: FlowResourceScope, flowId: string, version?: number) => Promise<FlowWorkflowRevision \| undefined>` | yes |  |
| listPendingRunsAsync | method | `() => Promise<readonly { readonly run: FlowRunSnapshot; readonly scope: FlowResourceScope; }[]>` | yes |  |
| listRunsAsync | method | `(scope: FlowResourceScope, flowId?: string) => Promise<readonly FlowRunSnapshot[]>` | yes |  |
| listWorkflowRevisionsAsync | method | `(scope: FlowResourceScope, flowId: string) => Promise<readonly FlowWorkflowRevision[]>` | yes |  |
| publishAsync | method | `(scope: FlowResourceScope, flowId: string, version: number, publishedAt: string) => Promise<FlowWorkflowRevision \| undefined>` | yes |  |
| readEventsAsync | method | `(scope: FlowResourceScope, afterId: number, runId?: string) => Promise<readonly FlowRunEvent[]>` | yes |  |
| resolveApprovalAsync | method | `(input: { readonly approvalId: string; readonly actorId: string; readonly approved: boolean; readonly now: string; readonly scope: FlowResourceScope; }) => Promise<FlowApprovalRequest \| undefined>` | yes |  |
| saveApprovalAsync | method | `(scope: FlowResourceScope, approval: FlowApprovalRequest) => Promise<void>` | yes |  |
| saveRunAsync | method | `(scope: FlowResourceScope, run: FlowRunSnapshot, idempotencyKey?: string) => Promise<FlowRunSnapshot>` | yes |  |
| transitionRunAsync | method | `(input: { readonly expectedStatus: FlowExecutionStatus; readonly run: FlowRunSnapshot; readonly event: FlowRunEvent; readonly scope: FlowResourceScope; }) => Promise<boolean>` | yes |  |

## FlowSecretCreateInput

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:119:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| actor | property | `FlowSecurityActor` | yes |  |
| kind | property | `string` | yes |  |
| payload | property | `Readonly<Record<string, string>>` | yes |  |
| provider | property | `string \| undefined` | no |  |
| ref | property | `string` | yes |  |

## FlowSecretMetadata

Kind: `unknown`
Module: `src/types/security.ts`
Source: `src/types/security.ts:115:1`

## FlowSecretRevokeInput

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:128:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| actor | property | `FlowSecurityActor` | yes |  |
| ref | property | `string` | yes |  |

## FlowSecurityActor

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:4:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| environment | property | `string` | yes |  |
| id | property | `string` | yes |  |
| projectId | property | `string` | yes |  |
| tenantId | property | `string` | yes |  |

## FlowSecurityApproval

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:47:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| operation | property | `FlowSecurityOperationIdentity` | yes |  |
| status | property | `"pending" \| "approved" \| "rejected"` | yes |  |

## FlowSecurityAuditEvent

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:95:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| actorId | property | `string` | yes |  |
| capability | property | `string` | yes |  |
| decision | property | `"denied" \| "permitted"` | yes |  |
| operationId | property | `string` | yes |  |
| reason | property | `"approval_pending" \| "approval_rejected" \| "credential_create" \| "credential_revoke" \| "idempotency_conflict" \| "invalid_target" \| "permission_denied" \| "rate_limited" \| "secret_unavailable"` | yes |  |
| secretRefs | property | `readonly string[]` | yes |  |
| targetHost | property | `string \| undefined` | no |  |

## FlowSecurityAuditPort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:90:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| writeAsync | method | `(event: FlowSecurityAuditEvent) => Promise<void>` | yes |  |

## FlowSecurityError

Kind: `type`
Module: `src/features/security/FlowSecurityError.ts`
Source: `src/features/security/FlowSecurityError.ts:2:1`

Represents a stable, payload-redacted Flow security denial.

## FlowSecurityGrant

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:12:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| actorId | property | `string` | yes |  |
| capability | property | `string` | yes |  |
| environment | property | `string` | yes |  |
| projectId | property | `string` | yes |  |
| tenantId | property | `string` | yes |  |

## FlowSecurityOperation

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:21:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| actor | property | `FlowSecurityActor` | yes |  |
| capability | property | `string` | yes |  |
| idempotencyKey | property | `string` | yes |  |
| operationId | property | `string` | yes |  |
| secretRefs | property | `readonly string[] \| undefined` | no |  |
| target | property | `FlowSecurityTarget \| undefined` | no |  |

## FlowSecurityOperationIdentity

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:37:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| actor | property | `FlowSecurityActor` | yes |  |
| capability | property | `string` | yes |  |
| idempotencyKey | property | `string` | yes |  |
| operationId | property | `string` | yes |  |
| secretRefs | property | `readonly string[]` | yes |  |
| target | property | `FlowSecurityTarget \| undefined` | no |  |

## FlowSecurityPermit

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:134:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| executeAsync | method | `<T>(operation: (secrets: FlowResolvedSecrets) => Promise<T>) => Promise<T>` | yes |  |
| operation | property | `FlowSecurityOperationIdentity` | yes |  |

## FlowSecurityPort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:140:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| authorizeAsync | method | `(operation: FlowSecurityOperation) => Promise<FlowSecurityPermit>` | yes |  |
| createSecretAsync | method | `(input: FlowSecretCreateInput) => Promise<FlowSecretMetadata>` | yes |  |
| getSecretMetadataAsync | method | `(input: { readonly actor: FlowSecurityActor; readonly ref: SecretRef; }) => Promise<FlowSecretMetadata>` | yes |  |
| revokeSecretAsync | method | `(input: FlowSecretRevokeInput) => Promise<void>` | yes |  |

## FlowSecurityTarget

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:31:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| allowedHosts | property | `readonly string[]` | yes |  |
| url | property | `string` | yes |  |

## FlowWorkerOutcome

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:78:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| error | property | `string \| undefined` | no |  |
| status | property | `"cancelled" \| "failed" \| "succeeded" \| "waiting_approval" \| "already_completed" \| "lost_lease" \| "retry_scheduled"` | yes |  |
| workId | property | `string` | yes |  |

## FlowWorkerResult

Kind: `type`
Module: `src/types/durableExecution.ts`
Source: `src/types/durableExecution.ts:92:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| claimedWorkIds | property | `readonly string[]` | yes |  |
| outcomes | property | `readonly FlowWorkerOutcome[]` | yes |  |
| recoveredWorkIds | property | `readonly string[]` | yes |  |

## FlowWorkflowRevision

Kind: `type`
Module: `src/types/headless.ts`
Source: `src/types/headless.ts:22:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| definition | property | `FlowDefinition` | yes |  |
| publishedAt | property | `string \| undefined` | no |  |
| scope | property | `FlowResourceScope` | yes |  |

## InMemoryFlowObservability

Kind: `value`
Module: `src/features/headless/adapters/InMemoryFlowObservability.ts`
Source: `src/features/headless/adapters/InMemoryFlowObservability.ts:4:14`

### Signatures

- `(retention?: number) => FlowObservabilityPort`
  - retention: `number` (optional)
  - returns: `FlowObservabilityPort`

## InMemoryFlowPersistenceAdapter

Kind: `value`
Module: `src/features/execution/adapters/InMemoryFlowPersistenceAdapter.ts`
Source: `src/features/execution/adapters/InMemoryFlowPersistenceAdapter.ts:10:14`

Provide the canonical durable persistence contract for embedded tests and local composition.

### Signatures

- `() => FlowPersistencePort`
  - returns: `FlowPersistencePort`

## InMemoryFlowRuntimeStore

Kind: `value`
Module: `src/features/headless/adapters/InMemoryFlowRuntimeStore.ts`
Source: `src/features/headless/adapters/InMemoryFlowRuntimeStore.ts:15:14`

Create a deterministic in-memory store for embedded hosts and boundary tests.

### Signatures

- `() => FlowRuntimeStorePort`
  - returns: `FlowRuntimeStorePort`

## isCronDueAt

Kind: `value`
Module: `src/features/execution/domain/isCronDueAt.ts`
Source: `src/features/execution/domain/isCronDueAt.ts:2:14`

### Signatures

- `(input: { readonly cron: string; readonly now: Date; readonly timezone?: string; }) => boolean`
  - input: `{ readonly cron: string; readonly now: Date; readonly timezone?: string; }`
  - returns: `boolean`
