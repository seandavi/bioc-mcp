import { describe, expect, it } from 'vitest';
import { chunkText, DOCS_READ_TEXT_BUDGET } from '../../../src/core/docs/chunk';

const jsonBytes = (s: string) => new TextEncoder().encode(JSON.stringify(s)).length - 2;

describe('chunkText', () => {
  it('returns text under the budget as one part', () => {
    expect(chunkText('short text', 0)).toEqual({ text: 'short text', end: 10 });
  });

  it('cuts after the last newline in the second half', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd';
    // hard = 12 ('aaaa\nbbbb\ncc'), half = 6; last \n in [6, 12) is at 9
    expect(chunkText(text, 0, 12)).toEqual({ text: 'aaaa\nbbbb\n', end: 10 });
  });

  it('falls back to the last space, then to the hard limit', () => {
    expect(chunkText('aaaa bbbb cccc dddd', 0, 12)).toEqual({ text: 'aaaa bbbb ', end: 10 });
    expect(chunkText('abcdefghijklmnopqrstuvwxyz', 0, 12)).toEqual({ text: 'abcdefghijkl', end: 12 });
  });

  it('ignores a newline in the first half', () => {
    expect(chunkText('a\nbcdefghijklmnop', 0, 12)).toEqual({ text: 'a\nbcdefghij', end: 11 });
  });

  it('counts JSON escapes', () => {
    expect(chunkText('""""""', 0, 6).end).toBe(3);
    expect(chunkText('\n\n\n\n', 0, 6).end).toBe(3);
    expect(chunkText('\u0001\u0001', 0, 6)).toEqual({ text: '\u0001', end: 1 });
  });

  it('counts 3- and 4-byte characters and never splits an emoji', () => {
    expect(chunkText('€€€', 0, 6).end).toBe(2);
    const emoji = '😀'.repeat(5);
    const part = chunkText(emoji, 0, 10);
    expect(part.end).toBe(4);
    expect(part.text).toBe('😀😀');
    expect(chunkText('a😀😀', 0, 8).end).toBe(3);
  });

  it('returns an empty part at the end of the text', () => {
    expect(chunkText('abc', 3)).toEqual({ text: '', end: 3 });
  });

  it('throws RangeError for a bad start or a budget under 6', () => {
    expect(() => chunkText('abc', 4)).toThrow(RangeError);
    expect(() => chunkText('abc', -1)).toThrow(RangeError);
    expect(() => chunkText('abc', 0, 5)).toThrow(RangeError);
  });

  it('covers the text exactly, within budget, advancing on every call', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `line "${i}" é😀\t\n`).join('');
    let start = 0;
    let rebuilt = '';
    let parts = 0;
    while (start < text.length) {
      const part = chunkText(text, start, 500);
      expect(part.end).toBeGreaterThan(start);
      expect(jsonBytes(part.text)).toBeLessThanOrEqual(500);
      rebuilt += part.text;
      start = part.end;
      parts++;
    }
    expect(rebuilt).toBe(text);
    expect(parts).toBeGreaterThan(1);
    expect(DOCS_READ_TEXT_BUDGET).toBe(5500);
  });
});
