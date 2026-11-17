import type {
  InfraSecretReference,
  InfraWorkloadResourceSpec,
  InfraWorkloadValue,
  InfraWorkloadVolumeSpec,
} from '@ankhorage/contracts/infra';

/** Public, provider-neutral composition input for separately operated Flow API and worker workloads. */
export interface FlowDeploymentDescriptorInput {
  readonly api: {
    /** Dedicated bootstrap reference for the token required by `flow api`. */
    readonly apiToken: InfraSecretReference;
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
  /** Dedicated bootstrap configuration shared by the separate API and worker processes. */
  readonly runtime: {
    readonly module: string;
  };
  readonly scheduler: {
    readonly dependencyId: string;
    readonly environment: Readonly<Record<string, InfraWorkloadValue>>;
  };
  readonly worker: {
    readonly resources: InfraWorkloadResourceSpec;
    readonly secretRefs: Readonly<Record<string, InfraSecretReference>>;
  };
}
