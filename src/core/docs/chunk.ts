/** UTF-8 bytes of JSON.stringify(chunk) minus the quotes: the docs_read text budget per call. */
export const DOCS_READ_TEXT_BUDGET = 5500;

const MIN_BUDGET = 6; // the largest cost of one code point

/** Bytes JSON.stringify spends on one code point (or lone surrogate) of a string. */
function jsonCost(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint === 0x08 || codePoint === 0x0c || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x09) {
    return 2;
  }
  if (codePoint < 0x20 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The part of `text` from `start` whose JSON-escaped UTF-8 size is at most `budget`, ending after
 * the last '\n' (else ' ') in the part's second half when the part is not the end of the text.
 * Never splits a surrogate pair. `end` is the offset of the next part (=== text.length at the end).
 * Throws RangeError unless 0 <= start <= text.length (start === text.length gives { text: '', end: start })
 * and unless budget >= 6 (the largest cost of one code point), so every call advances.
 */
export function chunkText(text: string, start: number, budget = DOCS_READ_TEXT_BUDGET): { text: string; end: number } {
  if (!Number.isInteger(start) || start < 0 || start > text.length) {
    throw new RangeError(`start must be an integer in [0, ${text.length}], got ${start}`);
  }
  if (!Number.isFinite(budget) || budget < MIN_BUDGET) {
    throw new RangeError(`budget must be at least ${MIN_BUDGET}, got ${budget}`);
  }

  let hard = start;
  let used = 0;
  while (hard < text.length) {
    const codePoint = text.codePointAt(hard)!;
    const cost = jsonCost(codePoint);
    if (used + cost > budget) break;
    used += cost;
    hard += codePoint > 0xffff ? 2 : 1;
  }

  let end = hard;
  if (hard < text.length) {
    const half = start + Math.floor((hard - start) / 2);
    const window = text.slice(half, hard);
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    if (newline !== -1) end = half + newline + 1;
    else if (space !== -1) end = half + space + 1;
  }
  return { text: text.slice(start, end), end };
}
