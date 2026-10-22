import * as z from 'zod';
import { defineCapability, type Module } from '../../src/core/registry';

/** Test-only capability whose handler returns a field its data schema does not declare. */
export const leakyThing = defineCapability({
  module: 'leaky',
  name: 'leaky_thing',
  title: 'Leaky thing',
  description: 'Test-only capability that returns an undeclared field.',
  input: z.object({}),
  data: z.object({ visible: z.string() }),
  async handler() {
    const data = { visible: 'yes', secret: 'internal-only' };
    return { data, summary: 'Leaky.', sources: [] };
  },
});

export const leakyModule: Module = {
  name: 'leaky',
  description: 'Test-only module.',
  upstreams: [],
  capabilities: [leakyThing],
};
