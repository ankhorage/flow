import { randomUUID } from 'node:crypto';

const token = `flow-container-token-${randomUUID()}`;
const identifier = randomUUID().replaceAll('-', '');
const image = `flow-container-acceptance:${identifier}`;
const network = `flow-container-network-${identifier}`;
const volume = `flow-container-state-${identifier}`;
const api = `flow-container-api-${identifier}`;
const worker = `flow-container-worker-${identifier}`;
const restartedWorker = `flow-container-worker-restarted-${identifier}`;

try {
  docker(['build', '--file', 'test/container/Dockerfile', '--tag', image, '.']);
  docker(['network', 'create', network]);
  docker(['volume', 'create', volume]);
  startApi();
  client('health');
  client('reject-unauthorized-operation');
  const firstRun = client('create-publish-trigger');
  startWorker(worker);
  assertWorkerHasNoPublicListener(worker);
  client('wait-for-run', { FLOW_RUN_ID: firstRun });
  docker(['stop', worker]);
  client('health');
  const recoveredRun = client('trigger-recovery-run');
  startWorker(restartedWorker);
  assertWorkerHasNoPublicListener(restartedWorker);
  client('wait-for-run', { FLOW_RUN_ID: recoveredRun });
  assertLogsAreRedacted(api);
  assertLogsAreRedacted(restartedWorker);
  process.stdout.write('FLOW_CONTAINER_ACCEPTANCE_PASSED\n');
} finally {
  removeContainer(restartedWorker);
  removeContainer(worker);
  removeContainer(api);
  removeResource(['network', 'rm', network]);
  removeResource(['volume', 'rm', volume]);
}

/** Build and execute the test image through Docker without passing the token in command arguments. */
function docker(arguments_: readonly string[], environment: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['docker', ...arguments_], {
    env: { ...process.env, ...environment, FLOW_API_TOKEN: token },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error('FLOW_CONTAINER_ACCEPTANCE_DOCKER_FAILED');
  return new TextDecoder().decode(result.stdout).trim();
}

/** Start the only externally reachable process on the test-owned Docker network and durable volume. */
function startApi(): void {
  docker([
    'run',
    '--detach',
    '--name',
    api,
    '--network',
    network,
    '--network-alias',
    'flow-api',
    '--mount',
    `type=volume,source=${volume},target=/state`,
    '--env',
    'FLOW_API_HOSTNAME=0.0.0.0',
    '--env',
    'FLOW_API_TOKEN',
    '--env',
    'FLOW_RUNTIME_MODULE=/app/test/fixtures/fileRuntimeModule.ts',
    '--env',
    'FLOW_TEST_STATE_DIRECTORY=/state',
    image,
    'api',
    '--port',
    '4318',
  ]);
}

/** Start one listener-free worker process with access only to the same test-owned durable volume. */
function startWorker(name: string): void {
  docker([
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    network,
    '--mount',
    `type=volume,source=${volume},target=/state`,
    '--env',
    'FLOW_RUNTIME_MODULE=/app/test/fixtures/fileRuntimeModule.ts',
    '--env',
    'FLOW_TEST_STATE_DIRECTORY=/state',
    image,
    'worker',
  ]);
}

/** Perform each HTTP assertion from a distinct client container in the Docker network namespace. */
function client(mode: string, environment: Record<string, string> = {}): string {
  return docker(
    [
      'run',
      '--rm',
      '--network',
      network,
      '--env',
      'FLOW_API_TOKEN',
      '--env',
      `FLOW_CONTAINER_MODE=${mode}`,
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--entrypoint',
      'bun',
      image,
      'test/container/client.ts',
    ],
    environment,
  );
}

/** Prove that a worker container neither publishes nor listens on the API port. */
function assertWorkerHasNoPublicListener(name: string): void {
  const ports = docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]);
  if (ports !== '{}') throw new Error('FLOW_CONTAINER_WORKER_PORT_PUBLISHED');
  docker([
    'exec',
    name,
    'bun',
    '-e',
    "const fs = require('node:fs'); const listening = [fs.readFileSync('/proc/net/tcp', 'utf8'), fs.readFileSync('/proc/net/tcp6', 'utf8')].some((table) => table.split('\\n').some((line) => /\\s0A\\s/u.test(line))); if (listening) throw new Error('FLOW_CONTAINER_WORKER_LISTENER_PRESENT');",
  ]);
}

/** Check service logs without emitting their contents, so the assertion itself cannot disclose a secret. */
function assertLogsAreRedacted(name: string): void {
  if (docker(['logs', name]).includes(token)) throw new Error('FLOW_CONTAINER_SECRET_LOGGED');
}

/** Remove a named test container without obscuring the acceptance failure that triggered cleanup. */
function removeContainer(name: string): void {
  removeResource(['rm', '--force', name]);
}

/** Remove only this run's UUID-scoped Docker resources and tolerate partial setup failures. */
function removeResource(arguments_: readonly string[]): void {
  Bun.spawnSync(['docker', ...arguments_], { stderr: 'ignore', stdout: 'ignore' });
}
