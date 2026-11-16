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
  const sharedEnvironment = {
    ...input.artifactStorage.environment,
    ...input.scheduler.environment,
  };
  const workloads = [
    {
      artifact: { image: input.image, kind: 'image' },
      command: input.api.command,
      dependsOn: dependenciesOf(input),
      environment: { ...sharedEnvironment, ...secretEnvironment(input.api.secretRefs) },
      exposure: 'public',
      health: input.api.health,
      id: 'flow-api',
      persistence: { [input.persistence.id]: input.persistence },
      ports: { http: { port: input.api.port, protocol: 'tcp' } },
      replicas: 1,
      resources: input.api.resources,
    },
    {
      artifact: { image: input.image, kind: 'image' },
      command: input.worker.command,
      dependsOn: dependenciesOf(input),
      environment: { ...sharedEnvironment, ...secretEnvironment(input.worker.secretRefs) },
      exposure: 'internal',
      health: input.worker.health,
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
  if (!isCommand(input.api.command) || !isCommand(input.worker.command))
    throw new Error('FLOW_DEPLOYMENT_COMMAND_REQUIRED');
  if (!isPositivePort(input.api.port)) throw new Error('FLOW_DEPLOYMENT_API_PORT_REQUIRED');
  if (!isNonEmptyRecord(input.api.secretRefs) || !isNonEmptyRecord(input.worker.secretRefs))
    throw new Error('FLOW_DEPLOYMENT_SECRET_REFS_REQUIRED');
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

/** Preserve the published JSON-safe set representation for desired-state dependencies. */
const dependenciesOf = (input: FlowDeploymentDescriptorInput): Readonly<Record<string, true>> => ({
  [input.artifactStorage.dependencyId]: true,
  [input.scheduler.dependencyId]: true,
});

/** Require OCI content-addressing so image selection cannot drift after planning. */
const isImmutableImage = (value: string): boolean => /\S+@sha256:[a-f\d]{64}$/u.test(value);

/** Require one executable and reject empty or whitespace-only arguments. */
const isCommand = (value: readonly string[]): boolean => value.length > 0 && value.every(isText);

/** Keep the public listener inside the portable TCP range. */
const isPositivePort = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && value < 65_536;

/** Reject omitted environment/secret maps before generating a desired workload. */
const isNonEmptyRecord = (value: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(value).length > 0;

/** Keep deployment identifiers and command tokens nonempty without imposing a provider naming scheme. */
const isText = (value: string): boolean => value.trim().length > 0;
