# Public API

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

## createFlowSecurityPort

Kind: `value`
Module: `src/features/security/application/createFlowSecurityPort.ts`
Source: `src/features/security/application/createFlowSecurityPort.ts:33:14`

Creates the provider-neutral server-side authorization, approval, audit, and secret boundary.

### Signatures

- `(input: { readonly approvalStore: FlowApprovalStorePort; readonly audit: FlowSecurityAuditPort; readonly grants: readonly FlowSecurityGrant[]; readonly operationStore: FlowOperationStorePort; readonly rateLimit: FlowRateLimitPort; readonly secretStore: SecretStoreAdapter; }) => FlowSecurityPort`
  - input: `{ readonly approvalStore: FlowApprovalStorePort; readonly audit: FlowSecurityAuditPort; readonly grants: readonly FlowSecurityGrant[]; readonly operationStore: FlowOperationStorePort; readonly rateLimit: FlowRateLimitPort; readonly secretStore: SecretStoreAdapter; }`
  - returns: `FlowSecurityPort`

## executeFlowAsync

Kind: `value`
Module: `src/features/execution/application/executeFlowAsync.ts`
Source: `src/features/execution/application/executeFlowAsync.ts:23:14`

Execute a compiled graph in deterministic order within one process.

### Signatures

- `(graph: FlowCompiledGraph, registry: Readonly<Record<string, import("../../../index.js").FlowNodeOperation>>, request: FlowRunRequest, clock?: FlowClock) => Promise<FlowExecutionResult>`
  - clock: `FlowClock` (optional)
  - graph: `FlowCompiledGraph`
  - registry: `Readonly<Record<string, import("../../../index.js").FlowNodeOperation>>`
  - request: `FlowRunRequest`
  - returns: `Promise<FlowExecutionResult>`

## FlowApprovalStorePort

Kind: `type`
Module: `src/types/security.ts`
Source: `src/types/security.ts:53:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| getAsync | method | `(operation: FlowSecurityOperationIdentity) => Promise<FlowSecurityApproval \| undefined>` | yes |  |

## FlowClock

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:12:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| now | property | `() => Date` | yes |  |

## FlowCompiledGraph

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:27:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| definition | property | `FlowDefinition` | yes |  |
| edgesBySourceNodeId | property | `Readonly<Record<string, readonly FlowEdge[]>>` | yes |  |
| topologicalNodeIds | property | `readonly string[]` | yes |  |

## FlowExecutionResult

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:39:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| run | property | `FlowRunSnapshot` | yes |  |

## FlowNodeOperation

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:18:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| executeAsync | property | `(input: { readonly config: FlowNodeConfig \| undefined; readonly input: Readonly<Record<FlowPortId, FlowDataRef>>; readonly node: FlowNode; readonly signal: AbortSignal; }) => Promise<FlowNodeOperationResult>` | yes |  |

## FlowNodeOperationResult

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:15:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| output | property | `Readonly<Record<string, FlowDataRef>> \| undefined` | no |  |

## FlowNodeRegistry

Kind: `unknown`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:26:1`

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

## FlowRunRequest

Kind: `type`
Module: `src/types/execution.ts`
Source: `src/types/execution.ts:32:1`

### Members

| Name | Kind | Type | Required | Description |
| --- | --- | --- | --- | --- |
| input | property | `Readonly<Record<string, FlowDataRef>> \| undefined` | no |  |
| runId | property | `string` | yes |  |
| schemaRegistry | property | `Readonly<Record<string, import("@ankhorage/contracts/data").DataSchema>> \| undefined` | no |  |
| signal | property | `AbortSignal \| undefined` | no |  |
| triggerId | property | `string` | yes |  |

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
| status | property | `"approved" \| "pending" \| "rejected"` | yes |  |

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
