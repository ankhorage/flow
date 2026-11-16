import { describe, expect, it } from 'bun:test';

import packageJson from '../package.json' with { type: 'json' };
import provider from '../src/cli/index.js';
import { CAPABILITIES } from '../src/capabilities/index.js';

describe('Flow capabilities', () => {
  it('matches manifest discovery metadata without duplicate CLI descriptors', () => {
    expect(CAPABILITIES.map(({ id }) => id)).toEqual(['flow.serve']);
    expect(packageJson.ankh.capabilities).toEqual(CAPABILITIES);
    expect(provider.capabilities).toBe(CAPABILITIES);
    expect(provider.commands.map(({ capability }) => capability)).toEqual(['flow.serve']);
  });
});
