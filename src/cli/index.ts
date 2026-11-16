import type { AnkhRuntimeCommandProvider } from '@ankhorage/ankh';

import packageJson from '../../package.json' with { type: 'json' };
import { serve } from './commands/serve.js';

/*** Register Flow standalone-server startup with canonical Ankh provider discovery. */
const provider = {
  capabilities: [
    {
      access: ['invoke'],
      binding: { bindableAs: ['target'], kind: 'action' },
      description: 'Start an authenticated standalone Flow workflow server.',
      id: 'flow.serve',
      label: 'Start Flow server',
      owner: '@ankhorage/flow',
    },
  ],
  category: 'flow',
  commands: [
    {
      capability: 'flow.serve',
      path: ['serve'],
      summary: 'Start an authenticated standalone Flow server.',
    },
  ],
  handlers: [{ handler: serve, path: ['serve'] }],
  id: 'flow',
  version: packageJson.version,
} satisfies AnkhRuntimeCommandProvider;

export default provider;
