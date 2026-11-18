import {
  FileFlowPersistenceAdapter,
  FileFlowRuntimeStore,
  createDefaultNodeRegistry,
  createFlowRuntime,
} from '@ankhorage/flow';

/** Compose durable test state through the package API installed in the published OCI image. */
export const createFlowRuntimeAsync = async () => {
  const stateDirectory = process.env.FLOW_TEST_STATE_DIRECTORY;
  if (stateDirectory === undefined) throw new Error('FLOW_TEST_STATE_DIRECTORY_REQUIRED');
  return createFlowRuntime({
    nodeRegistry: createDefaultNodeRegistry(),
    persistence: FileFlowPersistenceAdapter(`${stateDirectory}/durable.json`),
    store: FileFlowRuntimeStore(`${stateDirectory}/runtime.json`),
  });
};
