import * as z from 'zod';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeCapability } from '../../src/core/invoke';
import { defineCapability } from '../../src/core/registry';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';

const now = () => new Date('2026-10-22T12:00:00Z');
const deps: Deps = {
  fetch: async () => {
    throw new Error('no network in invoke tests');
  },
  cache: createMemoryCache(now),
  now,
  env: {},
};

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
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(gone);
  });

  test('input that fails the schema is invalid_input and the handler is not called', async () => {
    const handler = vi.fn(async () => ({ data: { n: 1 }, summary: '', sources: [] as never[] }));
    const result = await invokeCapability(demoThing(handler), { n: 'x' }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(handler).not.toHaveBeenCalled();
  });
});
