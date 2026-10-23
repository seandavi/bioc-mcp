import { describe, expect, test } from 'vitest';
import { CapabilityError } from '../../../src/errors';
import { CursorSchema, packagesPhrase, parseCursor, takePage } from '../../../src/core/pkg/paging';

describe('parseCursor', () => {
  test('undefined is offset 0', () => {
    expect(parseCursor(undefined, 5)).toBe(0);
  });

  test("'0' with total 0 is offset 0", () => {
    expect(parseCursor('0', 0)).toBe(0);
  });

  test('an offset at the total is invalid_input saying to call again without cursor', () => {
    try {
      parseCursor('5', 5);
      throw new Error('expected a CapabilityError');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityError);
      expect((error as CapabilityError).code).toBe('invalid_input');
      expect((error as CapabilityError).message).toBe(
        'cursor 5 is past the end of the list (5 items); the index may have changed since the previous call. Call again without cursor.',
      );
    }
  });

  test("'4' with total 5 is offset 4", () => {
    expect(parseCursor('4', 5)).toBe(4);
  });
});

describe('CursorSchema', () => {
  test.each(['abc', '-1', '1.5', '', '1234567'])('rejects %j', (value) => {
    expect(CursorSchema.safeParse(value).success).toBe(false);
  });

  test('accepts undefined and digits', () => {
    expect(CursorSchema.safeParse(undefined).success).toBe(true);
    expect(CursorSchema.safeParse('307').success).toBe(true);
  });
});

describe('takePage', () => {
  const items = ['aaaa', 'bbbb', 'cccc', 'dddd']; // each is 6 bytes as JSON, +1

  test('honours the byte budget', () => {
    expect(takePage(items, 0, 14)).toEqual({ page: ['aaaa', 'bbbb'], nextCursor: '2' });
    expect(takePage(items, 0, 13)).toEqual({ page: ['aaaa'], nextCursor: '1' });
  });

  test('starts at the offset', () => {
    expect(takePage(items, 2, 100)).toEqual({ page: ['cccc', 'dddd'], nextCursor: null });
  });

  test('one oversized item is still returned alone', () => {
    expect(takePage(['x'.repeat(500), 'y'], 0, 10)).toEqual({ page: ['x'.repeat(500)], nextCursor: '1' });
  });

  test('nextCursor is null at the end', () => {
    expect(takePage(items, 0, 1000)).toEqual({ page: items, nextCursor: null });
    expect(takePage([], 0, 10)).toEqual({ page: [], nextCursor: null });
  });

  test('multi-byte names are counted in UTF-8 bytes, not UTF-16 code units', () => {
    // Each case would return both items if takePage measured `.length` instead of UTF-8 bytes.
    expect(takePage(['é', 'é'], 0, 9)).toEqual({ page: ['é'], nextCursor: '1' }); // '"é"' is 4 bytes + 1 = 5; two = 10
    expect(takePage(['日本', '日本'], 0, 10)).toEqual({ page: ['日本'], nextCursor: '1' }); // 8 + 1 = 9; two = 18
  });
});

describe('packagesPhrase', () => {
  test('singular and plural', () => {
    expect(packagesPhrase(1)).toBe('1 package');
    expect(packagesPhrase(0)).toBe('0 packages');
    expect(packagesPhrase(16)).toBe('16 packages');
  });
});
