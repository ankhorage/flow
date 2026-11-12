/** Public configuration and results for the optional MCP integration. */
export type McpProviderDefinition =
  | {
      readonly id: string;
      readonly transport: 'remote';
      readonly endpoint: string;
      readonly allowedTools: readonly string[];
      readonly scopes: readonly string[];
      readonly timeoutMs?: number;
    }
  | {
      readonly id: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly environment?: Readonly<Record<string, string>>;
      readonly allowedTools: readonly string[];
      readonly scopes: readonly string[];
      readonly timeoutMs?: number;
    };

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
  readonly signal?: AbortSignal;
}

export interface McpToolResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface McpToolApprovalRequest {
  readonly providerId: string;
  readonly toolName: string;
  readonly scopes: readonly string[];
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type McpToolApprover = (request: McpToolApprovalRequest) => boolean | Promise<boolean>;

export interface McpToolRegistry {
  discoverAsync(signal?: AbortSignal): Promise<readonly McpToolMetadata[]>;
  invokeAsync(invocation: McpToolInvocation): Promise<McpToolResult>;
}
