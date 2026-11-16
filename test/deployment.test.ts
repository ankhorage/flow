import { expect, test } from 'bun:test';

import { isInfraWorkloadSpec } from '@ankhorage/contracts/infra';
import type { InfraSecretReference } from '@ankhorage/contracts/infra';

import { createFlowDeploymentDescriptor } from '../src/deployment.js';
import type { FlowDeploymentDescriptorInput } from '../src/deployment.js';

const apiToken = {
  environment: 'production',
  key: 'token',
  projectId: 'project',
  ref: 'flow/api',
  source: 'secret-store',
} as const satisfies InfraSecretReference;

const input: FlowDeploymentDescriptorInput = {
  api: {
    command: ['flow-api'],
    health: { kind: 'http', path: '/health', port: 4318 },
    port: 4318,
    resources: { cpuMillis: 250, memoryMiB: 256 },
    secretRefs: { FLOW_API_TOKEN: apiToken },
  },
  artifactStorage: {
    dependencyId: 'flow-artifact-storage',
    environment: { FLOW_ARTIFACT_STORAGE_ENDPOINT: { kind: 'literal', value: 'configured' } },
  },
  image:
    'registry.example.test/flow@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  persistence: {
    id: 'flow-state',
    mountPath: '/var/lib/flow',
    retention: 'retain',
    sizeGiB: 1,
  },
  scheduler: {
    dependencyId: 'flow-scheduler',
    environment: { FLOW_SCHEDULER_INGRESS: { kind: 'literal', value: 'configured' } },
  },
  worker: {
    command: ['flow-worker'],
    health: { command: ['flow-worker', 'health'], kind: 'command' },
    resources: { cpuMillis: 250, memoryMiB: 256 },
    secretRefs: {
      FLOW_ARTIFACT_STORAGE_TOKEN: {
        environment: 'production',
        key: 'token',
        projectId: 'project',
        ref: 'flow/artifact-storage',
        source: 'secret-store',
      },
    },
  },
};

test('composes independent, validated API and worker workloads from exact adapter input', () => {
  const workloads = createFlowDeploymentDescriptor(input);

  expect(workloads.map(({ id }) => id)).toEqual(['flow-api', 'flow-worker']);
  expect(workloads.every(isInfraWorkloadSpec)).toBe(true);
  expect(workloads[0]?.persistence).toEqual(workloads[1]?.persistence);
  expect(workloads[0]?.command).not.toEqual(workloads[1]?.command);
  expect(workloads[0]?.environment?.FLOW_API_TOKEN).toEqual({
    kind: 'secret',
    reference: apiToken,
  });
});

test('fails closed before guessing an image, secret reference, artifact storage, or scheduler', () => {
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, image: 'registry.example.test/flow:latest' }),
  ).toThrow('FLOW_DEPLOYMENT_IMAGE_DIGEST_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, worker: { ...input.worker, secretRefs: {} } }),
  ).toThrow('FLOW_DEPLOYMENT_SECRET_REFS_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      artifactStorage: { ...input.artifactStorage, environment: {} },
    }),
  ).toThrow('FLOW_DEPLOYMENT_ARTIFACT_STORAGE_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      scheduler: { ...input.scheduler, environment: {} },
    }),
  ).toThrow('FLOW_DEPLOYMENT_SCHEDULER_REQUIRED');
});
