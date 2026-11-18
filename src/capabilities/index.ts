import type { Capability } from '@ankhorage/contracts/capability';

/*** Declare the canonical Flow process capabilities shared by package metadata and Ankh discovery. */
export const CAPABILITIES = [
  {
    id: 'flow.api',
    owner: '@ankhorage/flow',
    access: ['invoke'],
    binding: { kind: 'action', bindableAs: ['target'] },
    label: 'Start Flow API',
    description: 'Start a Flow HTTP API against an explicitly composed shared durable runtime.',
  },
  {
    id: 'flow.serve',
    owner: '@ankhorage/flow',
    access: ['invoke'],
    binding: { kind: 'action', bindableAs: ['target'] },
    label: 'Start Flow server',
    description: 'Start an authenticated standalone Flow workflow server.',
  },
  {
    id: 'flow.worker',
    owner: '@ankhorage/flow',
    access: ['invoke'],
    binding: { kind: 'action', bindableAs: ['target'] },
    label: 'Start Flow worker',
    description: 'Start a Flow durable worker against an explicitly composed shared runtime.',
  },
] as const satisfies readonly Capability[];
