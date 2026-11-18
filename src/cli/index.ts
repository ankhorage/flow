import type { AnkhRuntimeCommandProvider } from '@ankhorage/ankh';

import packageJson from '../../package.json' with { type: 'json' };
import { CAPABILITIES } from '../capabilities/index.js';
import { api } from './commands/api.js';
import { serve } from './commands/serve.js';
import { worker } from './commands/worker.js';

/*** Register Flow standalone-server startup with canonical Ankh provider discovery. */
const provider = {
  capabilities: CAPABILITIES,
  category: 'flow',
  commands: [
    {
      capability: 'flow.api',
      path: ['api'],
      summary: 'Start the Flow HTTP API against a shared durable runtime.',
    },
    {
      capability: 'flow.serve',
      path: ['serve'],
      summary: 'Start an authenticated standalone Flow server.',
    },
    {
      capability: 'flow.worker',
      path: ['worker'],
      summary: 'Start the Flow durable worker against a shared durable runtime.',
    },
  ],
  handlers: [
    { handler: ({ argv }) => api(argv), path: ['api'] },
    { handler: ({ argv }) => serve(argv), path: ['serve'] },
    { handler: ({ argv }) => worker(argv), path: ['worker'] },
  ],
  id: 'flow',
  version: packageJson.version,
} satisfies AnkhRuntimeCommandProvider;

export default provider;
