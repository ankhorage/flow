import type { FlowDataRef, FlowNodeConfigValue } from '@ankhorage/contracts/flow';

import type { FlowNodeOperation, FlowNodeRegistry } from '../../../types/execution.js';

/*** Create the built-in operations that have no provider or host dependency. */
export const createDefaultNodeRegistry = (): FlowNodeRegistry => ({
  condition: { executeAsync: () => Promise.resolve({}) },
  noop: { executeAsync: () => Promise.resolve({}) },
  transform: { executeAsync: transformAsync },
});

/*** Copy configured inline or artifact values to matching output ports without evaluating code. */
const transformAsync: FlowNodeOperation['executeAsync'] = ({ config, node }) => {
  const outputIds = new Set(
    node.ports.filter((port) => port.direction === 'output').map(({ id }) => id),
  );
  const output = Object.fromEntries(
    Object.entries(config ?? {}).filter(
      (entry): entry is [string, FlowDataRef] => outputIds.has(entry[0]) && isDataRef(entry[1]),
    ),
  );
  return Promise.resolve({ output });
};

/*** Narrow a configuration value to data that may safely leave a node. */
const isDataRef = (value: FlowNodeConfigValue): value is FlowDataRef => value.kind !== 'secret';
