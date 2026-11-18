import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FlowRuntime } from '../types/headless.js';

/*** Load the deployment-selected runtime composition that owns a shared durable backend. */
export const loadFlowRuntimeAsync = async (): Promise<FlowRuntime> => {
  const moduleSpecifier = process.env.FLOW_RUNTIME_MODULE;
  if (moduleSpecifier === undefined || moduleSpecifier.trim().length === 0)
    throw new Error('FLOW_RUNTIME_MODULE_REQUIRED');
  const module: unknown = await import(runtimeModuleSpecifier(moduleSpecifier));
  if (!isFlowRuntimeFactoryModule(module)) throw new Error('FLOW_RUNTIME_FACTORY_REQUIRED');
  return module.createFlowRuntimeAsync();
};

/** Resolve explicit paths relative to the launched process while preserving package specifiers. */
const runtimeModuleSpecifier = (value: string): string =>
  value.startsWith('.') || value.startsWith('/') ? pathToFileURL(resolve(value)).href : value;

/** Narrow the external adapter boundary before invoking its declared runtime factory. */
const isFlowRuntimeFactoryModule = (
  value: unknown,
): value is { readonly createFlowRuntimeAsync: () => Promise<FlowRuntime> } =>
  typeof value === 'object' &&
  value !== null &&
  'createFlowRuntimeAsync' in value &&
  typeof value.createFlowRuntimeAsync === 'function';
