import type { AnkhRuntimeCommandProvider } from '@ankhorage/ankh';

import packageJson from '../../package.json' with { type: 'json' };
import { CAPABILITIES } from '../capabilities/index.js';
import { serve } from './commands/serve.js';

/*** Register Flow standalone-server startup with canonical Ankh provider discovery. */
const provider = {
  capabilities: CAPABILITIES,
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
