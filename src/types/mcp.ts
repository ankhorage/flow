import type { SecretRef } from '@ankhorage/contracts/secrets';

import type { FlowSecurityActor } from './security.js';

/** Public configuration and results for the optional MCP integration. */
export interface McpToolPermission {
  readonly name: string;
  readonly grantedScopes: readonly string[];
}

export type McpProviderDefinition =
  | {
      readonly id: string;
      readonly transport: 'remote';
      readonly endpoint: string;
      readonly allowedHosts: readonly string[];
      readonly allowedTools: readonly McpToolPermission[];
      readonly grantedScopes: readonly string[];
      readonly timeoutMs?: number;
    }
  | {
      readonly id: string;
      readonly transport: 'stdio';
      readonly allowedTools: readonly McpToolPermission[];
      readonly grantedScopes: readonly string[];
      readonly timeoutMs?: number;
    };

/** Host-owned command configuration. It is deliberately separate from workflow provider data. */
export interface McpTrustedStdioProvider {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface McpToolMetadata {
  readonly providerId: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly schemaFingerprint: string;
  readonly scopes: readonly string[];
  readonly readOnly: boolean;
}

export interface McpToolInvocation {
  readonly providerId: string;
  readonly toolName: string;
  readonly schemaFingerprint: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly scopes: readonly string[];
  readonly security: {
    readonly actor: FlowSecurityActor;
    readonly idempotencyKey: string;
    readonly operationId: string;
    readonly secretRefs?: readonly SecretRef[];
  };
  readonly signal?: AbortSignal;
}

export interface McpToolResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface McpToolRegistry {
  discoverAsync(signal?: AbortSignal): Promise<readonly McpToolMetadata[]>;
  invokeAsync(invocation: McpToolInvocation): Promise<McpToolResult>;
}
