import type {
  InfraSecretReference,
  InfraWorkloadHealthSpec,
  InfraWorkloadResourceSpec,
  InfraWorkloadValue,
  InfraWorkloadVolumeSpec,
} from '@ankhorage/contracts/infra';

/** Public, provider-neutral composition input for separately operated Flow API and worker workloads. */
export interface FlowDeploymentDescriptorInput {
  readonly api: {
    readonly command: readonly string[];
    readonly health: InfraWorkloadHealthSpec;
    readonly port: number;
    readonly resources: InfraWorkloadResourceSpec;
    readonly secretRefs: Readonly<Record<string, InfraSecretReference>>;
  };
  readonly artifactStorage: {
    readonly dependencyId: string;
    readonly environment: Readonly<Record<string, InfraWorkloadValue>>;
  };
  readonly image: string;
  readonly persistence: InfraWorkloadVolumeSpec;
  readonly scheduler: {
    readonly dependencyId: string;
    readonly environment: Readonly<Record<string, InfraWorkloadValue>>;
  };
  readonly worker: {
    readonly command: readonly string[];
    readonly health: InfraWorkloadHealthSpec;
    readonly resources: InfraWorkloadResourceSpec;
    readonly secretRefs: Readonly<Record<string, InfraSecretReference>>;
  };
}
