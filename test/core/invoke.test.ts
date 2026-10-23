import * as z from 'zod';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeCapability } from '../../src/core/invoke';
import { fetchUpstream } from '../../src/upstreams/http';
import { defineCapability } from '../../src/core/registry';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import { createMemoryUsageSink } from '../../src/usage';
import { exampleUpstream } from '../support/example-module';
import { ALPHA_ROUTE, ALPHA_URL } from '../support/app';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';

const now = () => new Date('2026-10-22T12:00:00Z');
const deps: Deps = {
  fetch: async () => {
    throw new Error('no network in invoke tests');
  },
  cache: createMemoryCache(now),
  now,
  env: {},
};

const context = () => ({ transport: 'rest' as const, usage: createMemoryUsageSink() });

function demoThing(handler: () => Promise<{ data: unknown; summary: string; sources: never[] }>) {
  return defineCapability({
    module: 'demo',
    name: 'demo_thing',
    title: 'Thing',
    description: 'Answers things.',
    input: z.object({ n: z.number() }),
    data: z.object({ n: z.number() }),
    handler: handler as never,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invokeCapability', () => {
  test('a handler that throws a plain Error becomes internal and is logged', async () => {
    const boom = new Error('boom');
    const result = await invokeCapability(
      demoThing(async () => {
        throw boom;
      }),
      { n: 1 },
      deps,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('demo_thing failed unexpectedly');
    expect(console.error).toHaveBeenCalledWith('demo_thing', boom);
  });

  test('data the output schema rejects becomes internal', async () => {
    const result = await invokeCapability(
      demoThing(async () => ({ data: { n: 'x' }, summary: '', sources: [] })),
      { n: 1 },
      deps,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('demo_thing produced output that does not match its schema');
  });

  test('a CapabilityError from the handler is passed through unchanged', async () => {
    const gone = new CapabilityError('not_found', 'gone');
    const result = await invokeCapability(
      demoThing(async () => {
        throw gone;
      }),
      { n: 1 },
      deps,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(gone);
  });

  test('input that fails the schema is invalid_input and the handler is not called', async () => {
    const handler = vi.fn(async () => ({ data: { n: 1 }, summary: '', sources: [] as never[] }));
    const result = await invokeCapability(demoThing(handler), { n: 'x' }, deps, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the size guard', () => {
  test('sizes the parsed output: a transform that pads the data is result_too_large', async () => {
    const padding = defineCapability({
      module: 'demo',
      name: 'demo_thing',
      title: 'Thing',
      description: 'Answers things.',
      input: z.object({ n: z.number() }),
      data: z.object({ pad: z.string().transform((s) => s.padEnd(9000, 'x')) }),
      handler: async () => ({ data: { pad: 'x' }, summary: '', sources: [] }),
    });
    const result = await invokeCapability(padding, { n: 1 }, deps, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('result_too_large');
  });

  test('an envelope that is oversized and off-schema is internal', async () => {
    const result = await invokeCapability(
      demoThing(async () => ({ data: { n: 'x'.repeat(9000) }, summary: '', sources: [] })),
      { n: 1 },
      deps,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('demo_thing produced output that does not match its schema');
  });
});

describe('invokeCapability usage events', () => {
  const EVENT_KEYS = ['capability', 'error_code', 'latency_ms', 'ok', 'transport', 'upstream_status'];

  test('records one event with exactly the six keys', async () => {
    const usage = createMemoryUsageSink();
    await invokeCapability(
      demoThing(async () => ({ data: { n: 1 }, summary: '', sources: [] })),
      { n: 1 },
      deps,
      { transport: 'mcp', usage },
    );
    expect(usage.events).toHaveLength(1);
    expect(Object.keys(usage.events[0]!).sort()).toEqual(EVENT_KEYS);
    expect(usage.events[0]).toEqual({
      transport: 'mcp',
      capability: 'demo_thing',
      latency_ms: 0,
      upstream_status: 0,
      ok: true,
      error_code: null,
    });
  });

  test('latency_ms is the clock advance during the handler', async () => {
    let clock = Date.parse('2026-10-22T12:00:00Z');
    const usage = createMemoryUsageSink();
    await invokeCapability(
      demoThing(async () => {
        clock += 250;
        return { data: { n: 1 }, summary: '', sources: [] };
      }),
      { n: 1 },
      { ...deps, now: () => new Date(clock) },
      { transport: 'rest', usage },
    );
    expect(usage.events[0]!.latency_ms).toBe(250);
  });

  test('a handler that throws a plain Error records internal with upstream_status 0', async () => {
    const usage = createMemoryUsageSink();
    await invokeCapability(
      demoThing(async () => {
        throw new Error('boom');
      }),
      { n: 1 },
      deps,
      { transport: 'rest', usage },
    );
    expect(usage.events[0]).toMatchObject({ ok: false, error_code: 'internal', upstream_status: 0 });
  });

  test('invalid input records invalid_input with upstream_status 0', async () => {
    const usage = createMemoryUsageSink();
    await invokeCapability(
      demoThing(async () => ({ data: { n: 1 }, summary: '', sources: [] })),
      { n: 'x' },
      deps,
      { transport: 'rest', usage },
    );
    expect(usage.events[0]).toMatchObject({ ok: false, error_code: 'invalid_input', upstream_status: 0 });
  });

  describe('upstream_status', () => {
    function fetching(routes: Record<string, FixtureRoute>) {
      const usage = createMemoryUsageSink();
      const callDeps: Deps = { ...deps, fetch: fixtureFetch(routes), cache: createMemoryCache(now) };
      const capability = defineCapability({
        module: 'demo',
        name: 'demo_thing',
        title: 'Thing',
        description: 'Answers things.',
        input: z.object({ n: z.number() }),
        data: z.object({ n: z.number() }),
        async handler(_input, handlerDeps) {
          await fetchUpstream(handlerDeps, exampleUpstream, 'items/alpha.json');
          return { data: { n: 1 }, summary: '', sources: [] };
        },
      });
      const call = () => invokeCapability(capability, { n: 1 }, callDeps, { transport: 'rest', usage });
      return { call, usage };
    }

    test('a fetched 200 records 200, then a cache hit records 0', async () => {
      const { call, usage } = fetching({ [ALPHA_URL]: ALPHA_ROUTE });
      await call();
      await call();
      expect(usage.events.map((event) => [event.ok, event.upstream_status])).toEqual([
        [true, 200],
        [true, 0],
      ]);
    });

    test('an upstream 404 records 404 and not_found', async () => {
      const { call, usage } = fetching({ [ALPHA_URL]: { status: 404 } });
      await call();
      expect(usage.events[0]).toMatchObject({ ok: false, error_code: 'not_found', upstream_status: 404 });
    });

    test('a timeout records 0 and upstream_timeout', async () => {
      const { call, usage } = fetching({ [ALPHA_URL]: 'timeout' });
      await call();
      expect(usage.events[0]).toMatchObject({ ok: false, error_code: 'upstream_timeout', upstream_status: 0 });
    });

    test('a followed redirect records the final 200, not the 302', async () => {
      const moved = 'https://upstream.test/items/moved.json';
      const { call, usage } = fetching({
        [ALPHA_URL]: { status: 302, headers: { location: moved } },
        [moved]: ALPHA_ROUTE,
      });
      await call();
      expect(usage.events[0]).toMatchObject({ ok: true, upstream_status: 200 });
    });
  });
});
