import * as z from 'zod';
import { describe, expect, test } from 'vitest';
import {
  assertEnvelopeSize,
  envelopeBytes,
  envelopeSchema,
  envelopeTextBlocks,
  MAX_RESULT_BYTES,
  type Envelope,
} from '../src/envelope';
import { CapabilityError } from '../src/errors';

/** An envelope whose JSON is exactly `bytes` long, padded with ASCII. */
function envelopeOfSize(bytes: number): Envelope<unknown> {
  const base: Envelope<unknown> = { data: '', summary: '', sources: [] };
  const room = bytes - envelopeBytes(base);
  return { ...base, data: 'a'.repeat(room) };
}

describe('envelopeSchema', () => {
  const schema = envelopeSchema(z.object({ n: z.number() }));

  test('accepts data, summary and sources', () => {
    const value = { data: { n: 1 }, summary: 's', sources: [{ url: 'https://x.test/', as_of: '2026-10-01' }] };
    expect(schema.parse(value)).toEqual(value);
  });

  test('requires all three keys', () => {
    expect(schema.safeParse({ data: { n: 1 }, summary: 's' }).success).toBe(false);
    expect(Object.keys(z.toJSONSchema(schema).properties ?? {})).toEqual(['data', 'summary', 'sources']);
  });
});

describe('envelopeBytes', () => {
  test('counts UTF-8 bytes, not characters', () => {
    const ascii = envelopeBytes({ data: 'e'.repeat(10), summary: '', sources: [] });
    const accented = envelopeBytes({ data: 'é'.repeat(10), summary: '', sources: [] });
    expect(accented - ascii).toBe(10);
  });
});

describe('assertEnvelopeSize', () => {
  test('accepts exactly 8192 bytes', () => {
    const envelope = envelopeOfSize(MAX_RESULT_BYTES);
    expect(envelopeBytes(envelope)).toBe(8192);
    expect(() => assertEnvelopeSize(envelope, 'x_tool')).not.toThrow();
  });

  test('rejects 8193 bytes', () => {
    const envelope = envelopeOfSize(MAX_RESULT_BYTES + 1);
    expect(envelopeBytes(envelope)).toBe(8193);
    expect(() => assertEnvelopeSize(envelope, 'x_tool')).toThrow(CapabilityError);
    expect(() => assertEnvelopeSize(envelope, 'x_tool')).toThrow(
      'x_tool returned 8193 bytes; the limit is 8192. If the tool takes a limit or filter, narrow the request; ' +
        'otherwise this is a server bug, please report it at https://github.com/seandavi/bioc-mcp/issues.',
    );
  });

  test('counts bytes, not characters: 4096 é is under 8192 characters but over 8192 bytes', () => {
    const envelope: Envelope<unknown> = { data: 'é'.repeat(4096), summary: '', sources: [] };
    expect(JSON.stringify(envelope).length).toBeLessThan(MAX_RESULT_BYTES);
    expect(() => assertEnvelopeSize(envelope, 'x_tool')).toThrow(CapabilityError);
  });
});

describe('envelopeTextBlocks', () => {
  const textBytes = (envelope: Envelope<unknown>) =>
    envelopeTextBlocks(envelope).reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);

  test('returns the summary, then JSON of data and sources', () => {
    const envelope = {
      data: { a: 1 },
      summary: 'S.',
      sources: [{ url: 'https://x.test/', as_of: '2026-10-22' }],
    };
    expect(envelopeTextBlocks(envelope)).toEqual([
      'S.',
      '{"data":{"a":1},"sources":[{"url":"https://x.test/","as_of":"2026-10-22"}]}',
    ]);
  });

  test('is 13 bytes smaller than the envelope when the summary needs no escaping', () => {
    const envelope: Envelope<unknown> = { data: { a: [1, 2] }, summary: 'Plain ASCII summary.', sources: [] };
    expect(textBytes(envelope)).toBe(envelopeBytes(envelope) - 13);
  });

  test('escapes in the summary widen the gap', () => {
    const envelope: Envelope<unknown> = { data: { a: 1 }, summary: 'say "hi"\nthere', sources: [] };
    expect(textBytes(envelope)).toBeLessThan(envelopeBytes(envelope) - 13);
  });

  test('an envelope at the limit gives text under the limit', () => {
    expect(textBytes(envelopeOfSize(MAX_RESULT_BYTES))).toBe(MAX_RESULT_BYTES - 13);
  });
});
