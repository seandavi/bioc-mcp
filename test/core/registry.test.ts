import * as z from 'zod';
import { describe, expect, test } from 'vitest';
import { metaModule } from '../../src/core/meta';
import { metaPing } from '../../src/core/meta/ping';
import { defineCapability, modules, restPath, validateRegistry, type Module } from '../../src/core/registry';
import { exampleItem, exampleModule, exampleUpstream } from '../support/example-module';

function capability(overrides: Partial<Parameters<typeof defineCapability>[0]> = {}) {
  return defineCapability({
    module: 'demo',
    name: 'demo_thing',
    title: 'Thing',
    description: 'Answers things.',
    input: z.object({}),
    data: z.object({}),
    async handler() {
      return { data: {}, summary: '', sources: [] };
    },
    ...overrides,
  });
}

function demoModule(overrides: Partial<Module> = {}): Module {
  return { name: 'demo', description: 'Demo.', upstreams: [], capabilities: [capability()], ...overrides };
}

describe('validateRegistry', () => {
  test('accepts the production registry', () => {
    expect(() => validateRegistry(modules)).not.toThrow();
  });

  test('accepts the test registry', () => {
    expect(() => validateRegistry([metaModule, exampleModule])).not.toThrow();
  });

  test('rejects a module name that is not lowercase letters', () => {
    expect(() => validateRegistry([demoModule({ name: 'Demo_1', capabilities: [] })])).toThrow(/Module name "Demo_1"/);
  });

  test('rejects duplicate module names', () => {
    expect(() => validateRegistry([demoModule(), demoModule({ capabilities: [] })])).toThrow(
      /Duplicate module name "demo"/,
    );
  });

  test('rejects a capability whose module differs from its container', () => {
    const wrong = capability({ module: 'other', name: 'other_thing' });
    expect(() => validateRegistry([demoModule({ capabilities: [wrong] })])).toThrow(/says module "other"/);
  });

  test('rejects a capability name that does not match the pattern', () => {
    const wrong = capability({ name: 'demo_Thing' });
    expect(() => validateRegistry([demoModule({ capabilities: [wrong] })])).toThrow(/must match/);
  });

  test('rejects a capability name without the module prefix', () => {
    const wrong = capability({ name: 'thing_demo' });
    expect(() => validateRegistry([demoModule({ capabilities: [wrong] })])).toThrow(/start with "demo_"/);
  });

  test('rejects an empty description', () => {
    const wrong = capability({ description: '  ' });
    expect(() => validateRegistry([demoModule({ capabilities: [wrong] })])).toThrow(/empty description/);
  });

  test('rejects duplicate capability names', () => {
    expect(() => validateRegistry([demoModule({ capabilities: [capability(), capability()] })])).toThrow(
      /Duplicate capability name "demo_thing"/,
    );
  });

  test('rejects two upstreams with the same id but different fields', () => {
    const a = demoModule({ upstreams: [exampleUpstream] });
    const b = demoModule({ name: 'demob', capabilities: [], upstreams: [{ ...exampleUpstream, ttlSeconds: 1 }] });
    expect(() => validateRegistry([a, b])).toThrow(/Upstream "example" is declared twice/);
  });

  test('accepts the same upstream declared identically by two modules', () => {
    const a = demoModule({ upstreams: [exampleUpstream] });
    const b = demoModule({ name: 'demob', capabilities: [], upstreams: [{ ...exampleUpstream }] });
    expect(() => validateRegistry([a, b])).not.toThrow();
  });

  test.each([
    ['a nested object', z.object({ nested: z.object({ a: z.string() }) })],
    ['a nullable field', z.object({ maybe: z.string().nullable() })],
    ['a union', z.object({ either: z.union([z.string(), z.number()]) })],
    ['an array of objects', z.object({ rows: z.array(z.object({ a: z.string() })) })],
  ])('rejects an input field REST cannot carry: %s', (_label, input) => {
    const wrong = capability({ input });
    expect(() => validateRegistry([demoModule({ capabilities: [wrong] })])).toThrow(/cannot be carried by REST/);
  });

  test('accepts scalars, enums, defaults, optionals and arrays of scalars', () => {
    const fine = capability({
      input: z.object({
        s: z.string(),
        n: z.number().optional(),
        i: z.number().int().default(1),
        b: z.boolean(),
        e: z.enum(['a', 'b']),
        list: z.array(z.string()),
      }),
    });
    expect(() => validateRegistry([demoModule({ capabilities: [fine] })])).not.toThrow();
  });
});

describe('defineCapability', () => {
  test('sets output to the envelope schema of data', () => {
    expect(Object.keys(metaPing.output.shape)).toEqual(['data', 'summary', 'sources']);
    expect(exampleItem.output.shape.data).toBe(exampleItem.data);
  });
});

describe('restPath', () => {
  test('drops the module prefix', () => {
    expect(restPath(metaPing)).toBe('/api/v1/meta/ping');
    expect(restPath(exampleItem)).toBe('/api/v1/example/item');
  });
});
