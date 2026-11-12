import type { DataSchemaRegistry } from '@ankhorage/contracts/data';
import type { FlowNode } from '@ankhorage/contracts/flow';

import { assertFlowDataSchemaSupported } from './validateFlowDataSchema.js';

/*** Validate every declared graph port schema before any operation can perform a side effect. */
export const assertFlowGraphSchemasSupported = (
  nodes: readonly FlowNode[],
  schemas: DataSchemaRegistry | undefined,
): void => {
  for (const node of nodes)
    for (const port of node.ports) {
      const schema =
        port.data?.schema ?? (port.data?.schemaRef ? { ref: port.data.schemaRef } : undefined);
      if (schema) assertFlowDataSchemaSupported(schema, schemas);
    }
};
