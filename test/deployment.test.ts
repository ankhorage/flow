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
    apiToken,
    hostname: '0.0.0.0',
    port: 4318,
    resources: { cpuMillis: 250, memoryMiB: 256 },
    secretRefs: {},
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
  runtime: { module: '@example/flow-runtime' },
  scheduler: {
    dependencyId: 'flow-scheduler',
    environment: { FLOW_SCHEDULER_INGRESS: { kind: 'literal', value: 'configured' } },
  },
  worker: {
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
  expect(workloads.map(({ command }) => command)).toEqual([
    ['flow', 'api'],
    ['flow', 'worker'],
  ]);
  expect(workloads[0]?.health).toEqual({ kind: 'http', path: '/health', port: 4318 });
  expect(workloads[1]?.health).toEqual({
    command: ['flow', 'worker', 'health'],
    kind: 'command',
  });
  expect(workloads[0]?.environment?.FLOW_API_TOKEN).toEqual({
    kind: 'secret',
    reference: apiToken,
  });
  expect(workloads[0]?.environment?.FLOW_RUNTIME_MODULE).toEqual({
    kind: 'literal',
    value: '@example/flow-runtime',
  });
  expect(workloads[0]?.environment?.FLOW_API_HOSTNAME).toEqual({
    kind: 'literal',
    value: '0.0.0.0',
  });
  expect(workloads[1]?.environment?.FLOW_API_HOSTNAME).toBeUndefined();
  expect(workloads[1]?.environment?.FLOW_RUNTIME_MODULE).toEqual({
    kind: 'literal',
    value: '@example/flow-runtime',
  });
});

test('fails closed before guessing an image, secret reference, artifact storage, or scheduler', () => {
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, image: 'registry.example.test/flow:latest' }),
  ).toThrow('FLOW_DEPLOYMENT_IMAGE_DIGEST_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      image:
        'garbage registry.example.test/flow@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }),
  ).toThrow('FLOW_DEPLOYMENT_IMAGE_DIGEST_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, image: 'registry.example.test/flow@sha256:xyz' }),
  ).toThrow('FLOW_DEPLOYMENT_IMAGE_DIGEST_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, worker: { ...input.worker, secretRefs: {} } }),
  ).toThrow('FLOW_DEPLOYMENT_SECRET_REFS_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      api: { ...input.api, apiToken: { ...apiToken, key: '' } },
    }),
  ).toThrow('FLOW_DEPLOYMENT_API_TOKEN_REQUIRED');
  expect(() => createFlowDeploymentDescriptor({ ...input, runtime: { module: ' ' } })).toThrow(
    'FLOW_DEPLOYMENT_RUNTIME_MODULE_REQUIRED',
  );
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, api: { ...input.api, hostname: 'localhost' } }),
  ).toThrow('FLOW_API_HOSTNAME_INVALID');
  expect(() =>
    createFlowDeploymentDescriptor({ ...input, api: { ...input.api, hostname: '127.0.0.1' } }),
  ).toThrow('FLOW_DEPLOYMENT_API_HOSTNAME_PUBLIC_REQUIRED');
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

test('rejects blank and colliding environment or secret keys before composing either process', () => {
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      artifactStorage: {
        ...input.artifactStorage,
        environment: { ' ': { kind: 'literal', value: 'configured' } },
      },
    }),
  ).toThrow('FLOW_DEPLOYMENT_ENVIRONMENT_KEY_REQUIRED');
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      scheduler: {
        ...input.scheduler,
        environment: { FLOW_ARTIFACT_STORAGE_ENDPOINT: { kind: 'literal', value: 'configured' } },
      },
    }),
  ).toThrow('FLOW_DEPLOYMENT_ENVIRONMENT_KEY_COLLISION');
  expect(() =>
    createFlowDeploymentDescriptor({
      ...input,
      worker: { ...input.worker, secretRefs: { FLOW_API_TOKEN: apiToken } },
    }),
  ).toThrow('FLOW_DEPLOYMENT_ENVIRONMENT_KEY_COLLISION');
});
