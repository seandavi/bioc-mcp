import * as z from 'zod';
import type { DocsIndexMeta, DocsInput } from '../../docs-index/schema';
import { docsSource } from './pages';

/** The Deploy workflow rebuilds the index daily; at this age at least one rebuild failed or did not run. */
export const DOCS_INDEX_STALE_AFTER_DAYS = 2;
/** An input whose source commit is unknown is possibly stale at this age (of its as_of). */
export const DOCS_INPUT_STALE_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

/** Whole days from `timestamp` to `now`, rounded down; 0 if `timestamp` is in the future or unparseable. */
export function ageDays(timestamp: string, now: Date): number {
  const elapsed = now.getTime() - Date.parse(timestamp);
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed / DAY_MS) : 0;
}

/** null unless ageDays(meta.built_at, now) >= DOCS_INDEX_STALE_AFTER_DAYS. */
export function indexStaleWarning(meta: DocsIndexMeta, now: Date): string | null {
  const days = ageDays(meta.built_at, now);
  if (days < DOCS_INDEX_STALE_AFTER_DAYS) return null;
  return `The docs index was built ${meta.built_at.slice(0, 10)}, ${days} days ago; it is rebuilt daily, so docs changed since then are not in it.`;
}

/**
 * The URL every page built from `input` starts with: for a raw.githubusercontent.com file, its GitHub blob URL
 * (https://github.com/<owner>/<repo>/blob/<ref>/<path>, as scripts/docs-index/markdown.ts links it); otherwise the
 * directory of the input URL (the site root for search.json).
 */
export function inputPagesUrl(input: DocsInput): string {
  const url = new URL(input.url);
  const segments = url.pathname.split('/').slice(1);
  if (url.hostname === 'raw.githubusercontent.com' && segments.length >= 4) {
    const [owner, repo, ref, ...path] = segments;
    return `https://github.com/${owner}/${repo}/blob/${ref}/${path.join('/')}`;
  }
  return new URL('./', url).href;
}

/** null, or the warning that the input's commit is behind its branch, or that its commit is unknown and it is old. */
export function inputStaleWarning(input: DocsInput, now: Date): string | null {
  const { commit } = input;
  if (commit !== null) {
    if (commit.sha === commit.head_sha) return null;
    return (
      `Docs under ${inputPagesUrl(input)} come from ${commit.repo}@${commit.sha.slice(0, 7)}, but ${commit.ref} was already at ` +
      `${commit.head_sha.slice(0, 7)} (committed ${commit.head_committed_at.slice(0, 10)}) when the index was built; ` +
      `they may lag ${commit.ref}.`
    );
  }
  const { as_of } = docsSource(input);
  const days = ageDays(as_of, now);
  if (days < DOCS_INPUT_STALE_AFTER_DAYS) return null;
  return `Docs under ${inputPagesUrl(input)} are ${days} days old (as of ${as_of.slice(0, 10)}) and their source commit is unknown.`;
}

/** 'as of <YYYY-MM-DD>' or 'as of <YYYY-MM-DD>, commit <sha 7>'. */
export function inputNote(input: DocsInput): string {
  const asOf = `as of ${docsSource(input).as_of.slice(0, 10)}`;
  return input.commit ? `${asOf}, commit ${input.commit.sha.slice(0, 7)}` : asOf;
}

export const DocsFreshnessSchema = z.object({
  index_built_at: z.string().describe('When the docs index was built (ISO 8601); it is rebuilt daily'),
  index_age_days: z.number().int().nonnegative().describe('Whole days since index_built_at'),
  possibly_stale: z
    .array(z.string())
    .describe(
      'Why this result may be out of date: the index is 2+ days old, a source was behind its branch, or a ' +
        "source's commit is unknown and it is 14+ days old. A source's warning starts with the URL its pages " +
        'start with; [] when none',
    ),
});
export type DocsFreshness = z.output<typeof DocsFreshnessSchema>;

/**
 * The index's age and why a result built from `inputs` may be out of date: the index warning (if
 * any), then the warning of each distinct input (by url, first-appearance order).
 */
export function docsFreshness(meta: DocsIndexMeta, inputs: readonly DocsInput[], now: Date): DocsFreshness {
  const seen = new Set<string>();
  const warnings = [indexStaleWarning(meta, now)];
  for (const input of inputs) {
    if (seen.has(input.url)) continue;
    seen.add(input.url);
    warnings.push(inputStaleWarning(input, now));
  }
  return {
    index_built_at: meta.built_at,
    index_age_days: ageDays(meta.built_at, now),
    possibly_stale: warnings.filter((warning): warning is string => warning !== null),
  };
}
