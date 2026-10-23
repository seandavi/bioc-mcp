import * as z from 'zod';
import { describe, expect, test } from 'vitest';
import { metaModule } from '../../src/core/meta';
import { metaPing } from '../../src/core/meta/ping';
import {
  defineCapability,
  modules,
  restPath,
  validateRegistry,
  type Module,
  type PromptDef,
  type ResourceTemplateDef,
} from '../../src/core/registry';
import type { Upstream } from '../../src/upstreams/http';
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

  test.each([
    ['is not https:', 'http://upstream.test/', /must use https:/],
    ['does not end with "/"', 'https://upstream.test/api', /must end with "\/"/],
    ['has a query string', 'https://upstream.test/?x=1', /query string or fragment/],
    ['has a fragment', 'https://upstream.test/#top', /query string or fragment/],
    ['is not a URL', 'upstream.test/', /not an absolute URL/],
  ])('rejects an upstream baseUrl that %s', (_label, baseUrl, message) => {
    const wrong = demoModule({ upstreams: [{ ...exampleUpstream, baseUrl }] });
    expect(() => validateRegistry([wrong])).toThrow(message);
  });

  test('accepts the same upstream declared with keys in a different order', () => {
    const reordered: Upstream = {
      description: 'Synthetic upstream used only in tests.',
      timeoutMs: 50,
      ttlSeconds: 300,
      baseUrl: 'https://upstream.test/',
      name: 'Example upstream',
      id: 'example',
    };
    const a = demoModule({ upstreams: [exampleUpstream] });
    const b = demoModule({ name: 'demob', capabilities: [], upstreams: [reordered] });
    expect(() => validateRegistry([a, b])).not.toThrow();
  });

  test('rejects the same upstream when only timeoutMs differs', () => {
    const a = demoModule({ upstreams: [exampleUpstream] });
    const b = demoModule({ name: 'demob', capabilities: [], upstreams: [{ ...exampleUpstream, timeoutMs: 51 }] });
    expect(() => validateRegistry([a, b])).toThrow(/Upstream "example" is declared twice/);
  });

  test('rejects the same upstream when only maxBytes differs', () => {
    const a = demoModule({ upstreams: [exampleUpstream] });
    const b = demoModule({ name: 'demob', capabilities: [], upstreams: [{ ...exampleUpstream, maxBytes: 1 }] });
    expect(() => validateRegistry([a, b])).toThrow(/Upstream "example" is declared twice/);
  });

  test.each([
    ['a username', 'https://user@upstream.test/'],
    ['a username and password', 'https://user:secret@upstream.test/'],
    ['a password only', 'https://:secret@upstream.test/'],
    ['credentials on http:', 'http://user:secret@upstream.test/'],
    ['credentials and no scheme (parsed as scheme "user:")', 'user:secret@upstream.test/'],
    ['credentials and an unparseable host', 'https://user:secret@'],
  ])('rejects an upstream baseUrl with %s, without echoing the password', (_label, baseUrl) => {
    const wrong = demoModule({ upstreams: [{ ...exampleUpstream, baseUrl }] });
    let message = '';
    try {
      validateRegistry([wrong]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Upstream "example" baseUrl (must not include credentials|must use https:|is not an absolute URL)/);
    expect(message).not.toContain('secret');
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects ttlSeconds %s', (ttlSeconds) => {
    const wrong = demoModule({ upstreams: [{ ...exampleUpstream, ttlSeconds }] });
    expect(() => validateRegistry([wrong])).toThrow(/ttlSeconds must be a positive integer/);
  });

  test.each([0, -1, 1.5, 2 ** 32, 60_001, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeoutMs %s', (timeoutMs) => {
    const wrong = demoModule({ upstreams: [{ ...exampleUpstream, timeoutMs }] });
    expect(() => validateRegistry([wrong])).toThrow(/timeoutMs must be a positive integer no greater than 60000/);
  });

  test('accepts timeoutMs 60000', () => {
    const upstream = { ...exampleUpstream, timeoutMs: 60_000 };
    expect(() => validateRegistry([demoModule({ upstreams: [upstream] })])).not.toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects maxBytes %s', (maxBytes) => {
    const wrong = demoModule({ upstreams: [{ ...exampleUpstream, maxBytes }] });
    expect(() => validateRegistry([wrong])).toThrow(/maxBytes must be a positive integer/);
  });

  test('accepts an upstream without timeoutMs', () => {
    const { timeoutMs: _omit, ...noTimeout } = exampleUpstream;
    expect(() => validateRegistry([demoModule({ upstreams: [noTimeout] })])).not.toThrow();
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

describe('validateRegistry: idempotent input', () => {
  test.each([
    ['a transform', z.object({ t: z.string().transform((value) => value.trim()) }), /input field "t" has a transform/],
    [
      'a pipe to another type',
      z.object({ t: z.string().pipe(z.coerce.number()) }),
      /input field "t" parses to a different type than it accepts/,
    ],
    ['z.stringbool()', z.object({ t: z.stringbool() }), /input field "t" parses to a different type than it accepts/],
  ])('rejects %s', (_label, input, message) => {
    const wrong = capability({ input });
    expect(() => validateRegistry([demoModule({ capabilities: [wrong] })])).toThrow(message);
  });

  test('accepts defaults, prefault, catch, trim, toLowerCase and coerce.number', () => {
    const fine = capability({
      input: z.object({
        d: z.string().default('x'),
        p: z.string().prefault('x'),
        c: z.number().catch(0),
        t: z.string().trim(),
        l: z.string().toLowerCase(),
        n: z.coerce.number(),
      }),
    });
    expect(() => validateRegistry([demoModule({ capabilities: [fine] })])).not.toThrow();
  });
});

function template(overrides: Partial<ResourceTemplateDef> = {}): ResourceTemplateDef {
  return {
    name: 'demo-page',
    uriTemplate: 'bioc://demo/{+path}',
    title: 'Page',
    description: 'A page.',
    mimeType: 'text/markdown',
    list: () => [],
    read: () => '',
    ...overrides,
  };
}

function prompt(overrides: Partial<PromptDef> = {}): PromptDef {
  return {
    name: 'explain-thing',
    title: 'Explain',
    description: 'Explains a thing.',
    args: z.object({ topic: z.string() }),
    tools: ['demo_thing'],
    render: () => 'Explain it.',
    ...overrides,
  };
}

describe('validateRegistry: resources and prompts', () => {
  test('accepts a module with a valid template and prompt', () => {
    expect(() => validateRegistry([demoModule({ resources: [template()], prompts: [prompt()] })])).not.toThrow();
  });

  test('accepts a prompt naming a tool of another module', () => {
    const other = demoModule({ name: 'other', capabilities: [] });
    const withPrompt = demoModule({ prompts: [prompt()] });
    expect(() => validateRegistry([withPrompt, other])).not.toThrow();
    const reverse = demoModule({ name: 'first', capabilities: [], prompts: [prompt()] });
    expect(() => validateRegistry([reverse, demoModule()])).not.toThrow();
  });

  test.each(['Demo_Page', 'demo--page', '-demo', 'demo1'])('rejects the template name %j', (name) => {
    expect(() => validateRegistry([demoModule({ resources: [template({ name })] })])).toThrow(
      `Resource template "${name}" must match`,
    );
  });

  test('rejects a duplicate template name', () => {
    const other = demoModule({ name: 'other', capabilities: [], resources: [template({ uriTemplate: 'bioc://other/{+p}' })] });
    expect(() => validateRegistry([demoModule({ resources: [template()] }), other])).toThrow(
      'Duplicate resource template name "demo-page"',
    );
  });

  test('rejects a uriTemplate outside bioc://<module>/', () => {
    expect(() => validateRegistry([demoModule({ resources: [template({ uriTemplate: 'bioc://other/{+path}' })] })])).toThrow(
      'Resource template "demo-page" uriTemplate must start with "bioc://demo/"',
    );
  });

  test('rejects a prompt name that does not match', () => {
    expect(() => validateRegistry([demoModule({ prompts: [prompt({ name: 'Explain_Thing' })] })])).toThrow(
      'Prompt "Explain_Thing" must match',
    );
  });

  test('rejects a duplicate prompt name', () => {
    expect(() => validateRegistry([demoModule({ prompts: [prompt(), prompt()] })])).toThrow(
      'Duplicate prompt name "explain-thing"',
    );
  });

  test('rejects an empty prompt description', () => {
    expect(() => validateRegistry([demoModule({ prompts: [prompt({ description: ' ' })] })])).toThrow(
      'Prompt "explain-thing" has an empty description',
    );
  });

  test('rejects a prompt argument that is not a string', () => {
    const wrong = prompt({ args: z.object({ count: z.number() }) });
    expect(() => validateRegistry([demoModule({ prompts: [wrong] })])).toThrow(
      'Prompt "explain-thing" argument "count" must be a string; MCP prompt arguments are strings',
    );
  });

  test('rejects a prompt naming an unknown tool', () => {
    const wrong = prompt({ tools: ['demo_thing', 'demo_missing'] });
    expect(() => validateRegistry([demoModule({ prompts: [wrong] })])).toThrow(
      'Prompt "explain-thing" names unknown tool "demo_missing"',
    );
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
