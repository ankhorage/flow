import { McpToolError } from './McpToolError.js';

/*** Propagates cancellation and a fixed timeout into an asynchronous SDK operation. */
export const boundedMcpAsync = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs,
  );
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await operation(combined);
  } catch (error) {
    if (controller.signal.aborted) throw new McpToolError('timed_out', 'MCP operation timed out.');
    if (combined.aborted) throw new McpToolError('cancelled', 'MCP operation was cancelled.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
