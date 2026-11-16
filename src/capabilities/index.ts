import type { Capability } from '@ankhorage/contracts/capability';

/*** Declare the canonical Flow server capability shared by package metadata and Ankh discovery. */
export const CAPABILITIES = [
  {
    id: 'flow.serve',
    owner: '@ankhorage/flow',
    access: ['invoke'],
    binding: { kind: 'action', bindableAs: ['target'] },
    label: 'Start Flow server',
    description: 'Start an authenticated standalone Flow workflow server.',
  },
] as const satisfies readonly Capability[];
