#!/usr/bin/env bun

import { api } from './commands/api.js';
import { serve } from './commands/serve.js';
import { worker } from './commands/worker.js';

/*** Start Flow directly for local standalone operation without changing Ankh command semantics. */
const startAsync = (): Promise<void> => commandFor(process.argv.slice(2))(process.argv.slice(3));

/** Route the packaged Flow executable to its canonical CLI command ownership. */
const commandFor = (argv: readonly string[]) => {
  const command = argv[0] ?? 'serve';
  if (command === 'api') return api;
  if (command === 'serve') return serve;
  if (command === 'worker') return worker;
  throw new Error(`FLOW_COMMAND_UNKNOWN:${command}`);
};

void startAsync();
