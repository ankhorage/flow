import {
  type InfraSecretReference,
  type InfraWorkloadSpec,
  type InfraWorkloadValue,
  isInfraWorkloadSpec,
} from '@ankhorage/contracts/infra';

import type { FlowDeploymentDescriptorInput } from '../../types/deployment.js';

/*** Compose exactly one public Flow API and one independent worker workload from explicit portable inputs. */
export const createFlowDeploymentDescriptor = (
  input: FlowDeploymentDescriptorInput,
): readonly InfraWorkloadSpec[] => {
  assertDeploymentInput(input);
  assertEnvironmentKeys(input);
  assertNoEnvironmentKeyCollisions(input);
  const runtimeEnvironment = {
    FLOW_RUNTIME_MODULE: { kind: 'literal', value: input.runtime.module },
  } as const;
  const sharedEnvironment = mergeEnvironment(
    runtimeEnvironment,
    input.artifactStorage.environment,
    input.scheduler.environment,
  );
  const apiSecrets = secretEnvironment({ FLOW_API_TOKEN: input.api.apiToken });
  const workloads = [
    {
      artifact: { image: input.image, kind: 'image' },
      command: ['flow', 'api'],
      dependsOn: dependenciesOf(input),
      environment: mergeEnvironment(
        sharedEnvironment,
        apiSecrets,
        secretEnvironment(input.api.secretRefs),
      ),
      exposure: 'public',
      health: { kind: 'http', path: '/health', port: input.api.port },
      id: 'flow-api',
      persistence: { [input.persistence.id]: input.persistence },
      ports: { http: { port: input.api.port, protocol: 'tcp' } },
      replicas: 1,
      resources: input.api.resources,
    },
    {
      artifact: { image: input.image, kind: 'image' },
      command: ['flow', 'worker'],
      dependsOn: dependenciesOf(input),
      environment: mergeEnvironment(sharedEnvironment, secretEnvironment(input.worker.secretRefs)),
      exposure: 'internal',
      health: { command: ['flow', 'worker', 'health'], kind: 'command' },
      id: 'flow-worker',
      persistence: { [input.persistence.id]: input.persistence },
      replicas: 1,
      resources: input.worker.resources,
    },
  ] as const;
  if (!workloads.every(isInfraWorkloadSpec)) throw new Error('FLOW_DEPLOYMENT_WORKLOAD_INVALID');
  return workloads;
};

/** Reject incomplete composition rather than guessing images, credentials, storage, or scheduler behavior. */
const assertDeploymentInput = (input: FlowDeploymentDescriptorInput): void => {
  if (!isImmutableImage(input.image)) throw new Error('FLOW_DEPLOYMENT_IMAGE_DIGEST_REQUIRED');
  if (!isPositivePort(input.api.port)) throw new Error('FLOW_DEPLOYMENT_API_PORT_REQUIRED');
  if (!isSecretReference(input.api.apiToken)) throw new Error('FLOW_DEPLOYMENT_API_TOKEN_REQUIRED');
  if (!isNonEmptyRecord(input.worker.secretRefs))
    throw new Error('FLOW_DEPLOYMENT_SECRET_REFS_REQUIRED');
  if (!isText(input.runtime.module)) throw new Error('FLOW_DEPLOYMENT_RUNTIME_MODULE_REQUIRED');
  if (!isNonEmptyRecord(input.artifactStorage.environment))
    throw new Error('FLOW_DEPLOYMENT_ARTIFACT_STORAGE_REQUIRED');
  if (!isNonEmptyRecord(input.scheduler.environment))
    throw new Error('FLOW_DEPLOYMENT_SCHEDULER_REQUIRED');
  if (!isText(input.artifactStorage.dependencyId) || !isText(input.scheduler.dependencyId))
    throw new Error('FLOW_DEPLOYMENT_DEPENDENCY_REQUIRED');
};

/** Convert only published secret references to deployment-time environment values. */
const secretEnvironment = (
  secretRefs: Readonly<Record<string, InfraSecretReference>>,
): Readonly<Record<string, InfraWorkloadValue>> =>
  Object.fromEntries(
    Object.entries(secretRefs).map(([name, reference]) => [name, { kind: 'secret', reference }]),
  );

/** Merge already-validated environment sources without changing their portable value representation. */
const mergeEnvironment = (
  ...sources: readonly Readonly<Record<string, InfraWorkloadValue>>[]
): Readonly<Record<string, InfraWorkloadValue>> =>
  Object.fromEntries(sources.flatMap((source) => Object.entries(source)));

/** Reject blank deployment environment names before any platform can normalize them differently. */
const assertEnvironmentKeys = (input: FlowDeploymentDescriptorInput): void => {
  const environments = [
    input.api.secretRefs,
    input.artifactStorage.environment,
    input.scheduler.environment,
    input.worker.secretRefs,
  ];
  if (!environments.every((environment) => Object.keys(environment).every(isText)))
    throw new Error('FLOW_DEPLOYMENT_ENVIRONMENT_KEY_REQUIRED');
};

/** Reject every duplicate key across shared configuration and process-specific secret sources. */
const assertNoEnvironmentKeyCollisions = (input: FlowDeploymentDescriptorInput): void => {
  const names = [
    'FLOW_RUNTIME_MODULE',
    'FLOW_API_TOKEN',
    ...Object.keys(input.api.secretRefs),
    ...Object.keys(input.artifactStorage.environment),
    ...Object.keys(input.scheduler.environment),
    ...Object.keys(input.worker.secretRefs),
  ];
  if (new Set(names).size !== names.length)
    throw new Error('FLOW_DEPLOYMENT_ENVIRONMENT_KEY_COLLISION');
};

/** Preserve the published JSON-safe set representation for desired-state dependencies. */
const dependenciesOf = (input: FlowDeploymentDescriptorInput): Readonly<Record<string, true>> => ({
  [input.artifactStorage.dependencyId]: true,
  [input.scheduler.dependencyId]: true,
});

/** Require OCI content-addressing so image selection cannot drift after planning. */
const isImmutableImage = (value: string): boolean =>
  /^(?:[a-z\d]+(?:[._-][a-z\d]+)*(?::[\d]+)?\/)?[a-z\d]+(?:[._-][a-z\d]+)*(?:\/[a-z\d]+(?:[._-][a-z\d]+)*)*@sha256:[a-f\d]{64}$/u.test(
    value,
  );

/** Keep the public listener inside the portable TCP range. */
const isPositivePort = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && value < 65_536;

/** Reject omitted environment/secret maps before generating a desired workload. */
const isNonEmptyRecord = (value: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(value).length > 0;

/** Keep deployment identifiers and command tokens nonempty without imposing a provider naming scheme. */
const isText = (value: string): boolean => value.trim().length > 0;

/** Validate the portable identity-only reference used to bootstrap the API bearer boundary. */
const isSecretReference = (value: unknown): value is InfraSecretReference =>
  typeof value === 'object' &&
  value !== null &&
  'environment' in value &&
  'key' in value &&
  'projectId' in value &&
  'ref' in value &&
  'source' in value &&
  value.source === 'secret-store' &&
  isUnknownText(value.environment) &&
  isUnknownText(value.key) &&
  isUnknownText(value.projectId) &&
  isUnknownText(value.ref);

/** Narrow unknown fields to nonblank portable identifiers at the public deployment boundary. */
const isUnknownText = (value: unknown): value is string =>
  typeof value === 'string' && isText(value);
