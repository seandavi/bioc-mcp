import * as z from 'zod';
import { CapabilityError } from '../../errors';

/** next_cursor of a previous call: the 0-based offset of the next item, as decimal digits. */
export const CursorSchema = z
  .string()
  .regex(/^\d{1,6}$/, 'cursor must be the next_cursor of a previous call')
  .optional()
  .describe('next_cursor from the previous call, to get the next page; same other arguments');

/** Offset for `cursor` (0 when undefined). Throws invalid_input when the offset is not below `total` (unless 0). */
export function parseCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (offset !== 0 && offset >= total) {
    throw new CapabilityError(
      'invalid_input',
      `cursor ${cursor} is past the end of the list (${total} items); the index may have changed since the previous call. Call again without cursor.`,
    );
  }
  return offset;
}

const encoder = new TextEncoder();

/**
 * items[offset…] while the running sum of (UTF-8 bytes of JSON.stringify(item) + 1) stays within
 * budgetBytes, but always at least one item when any remain. nextCursor is String(end), or null
 * when the page reaches the end.
 */
export function takePage<T>(
  items: readonly T[],
  offset: number,
  budgetBytes: number,
): { page: T[]; nextCursor: string | null } {
  let end = offset;
  let bytes = 0;
  while (end < items.length) {
    bytes += encoder.encode(JSON.stringify(items[end])).byteLength + 1;
    if (bytes > budgetBytes && end > offset) break;
    end++;
  }
  return { page: items.slice(offset, end), nextCursor: end < items.length ? String(end) : null };
}

/** '1 package', '16 packages'. */
export function packagesPhrase(n: number): string {
  return `${n} ${n === 1 ? 'package' : 'packages'}`;
}
