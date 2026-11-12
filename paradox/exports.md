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
