/*** Stop a Flow process exactly once when its host requests graceful termination. */
export const registerProcessShutdown = (stopAsync: () => Promise<void>): void => {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void stopAsync().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'FLOW_PROCESS_STOP_FAILED';
      process.stderr.write(`Flow process stop failed: ${message}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
};
