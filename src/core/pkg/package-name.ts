import * as z from 'zod';

/** R package name: starts with a letter, letters/digits/'.', at least two characters, no trailing '.'. */
export const PackageNameSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/, 'Not a valid R package name')
  .describe('Package name, case-sensitive, e.g. "edgeR"');

/** Edit distance with insert, delete and substitute each costing 1 (two-row DP). */
function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Up to `limit` names from `candidates` close to `name`, best first. */
export function closeMatches(name: string, candidates: Iterable<string>, limit = 5): string[] {
  const query = name.toLowerCase();
  const scored: { candidate: string; distance: number }[] = [];
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const lower = candidate.toLowerCase();
    const distance = levenshtein(query, lower);
    const prefix = query.length >= 3 && lower.startsWith(query);
    if (distance <= 2 || prefix) scored.push({ candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.candidate);
}
