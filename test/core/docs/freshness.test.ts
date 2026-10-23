import { describe, expect, it } from 'vitest';
import {
  ageDays,
  commitUrl,
  docsFreshness,
  DocsFreshnessSchema,
  indexStaleWarning,
  inputNote,
  inputStaleWarning,
} from '../../../src/core/docs/freshness';
import type { DocsIndexMeta, DocsInput, DocsInputCommit } from '../../../src/docs-index/schema';

const BUILT = '2026-10-22T00:00:00.000Z';
const at = (iso: string) => new Date(iso);

const commit: DocsInputCommit = {
  repo: 'seandavi/bioc-registry',
  ref: 'main',
  sha: 'a'.repeat(40),
  head_sha: 'a'.repeat(40),
  head_committed_at: '2026-10-16T23:21:08Z',
};
const behind: DocsInputCommit = { ...commit, head_sha: 'b'.repeat(40), head_committed_at: '2026-10-20T08:09:10Z' };

function input(overrides: Partial<DocsInput> = {}): DocsInput {
  return {
    url: 'https://raw.githubusercontent.com/seandavi/bioc-registry/main/README.md',
    record_count: 1,
    last_modified: null,
    fetched_at: BUILT,
    sha256: '0'.repeat(64),
    commit,
    ...overrides,
  };
}

function metaOf(inputs: DocsInput[], built_at = BUILT): DocsIndexMeta {
  return { built_at, build_commit: null, record_count: inputs.length, inputs };
}

describe('ageDays', () => {
  it('rounds down to whole days', () => {
    expect(ageDays(BUILT, at('2026-10-22T23:59:59Z'))).toBe(0);
    expect(ageDays(BUILT, at('2026-10-23T00:00:00Z'))).toBe(1);
    expect(ageDays(BUILT, at('2026-10-24T23:59:59Z'))).toBe(2);
  });

  it('is 0 for a future timestamp', () => {
    expect(ageDays('2026-10-23T00:00:00Z', at(BUILT))).toBe(0);
  });

  it('is 0 for a timestamp that is not a date', () => {
    expect(ageDays('not a date', at(BUILT))).toBe(0);
    expect(ageDays('', at(BUILT))).toBe(0);
  });
});

describe('commitUrl', () => {
  it('is the GitHub commit page', () => {
    expect(commitUrl(commit)).toBe(`https://github.com/seandavi/bioc-registry/commit/${'a'.repeat(40)}`);
  });
});

describe('indexStaleWarning', () => {
  const meta = metaOf([input()]);

  it('is null at 47:59:59 and the exact warning at 48:00:00', () => {
    expect(indexStaleWarning(meta, at('2026-10-23T23:59:59Z'))).toBeNull();
    expect(indexStaleWarning(meta, at('2026-10-24T00:00:00Z'))).toBe(
      'The docs index was built 2026-10-22, 2 days ago; it is rebuilt daily, so docs changed since then are not in it.',
    );
  });

  it('counts whole days', () => {
    expect(indexStaleWarning(meta, at('2026-10-29T13:00:00Z'))).toContain('7 days ago');
  });
});

describe('inputStaleWarning', () => {
  const now = at('2026-10-22T00:00:00Z');

  it('says the input may lag its branch when its commit is behind the head', () => {
    expect(inputStaleWarning(input({ commit: behind }), now)).toBe(
      'https://raw.githubusercontent.com/seandavi/bioc-registry/main/README.md comes from seandavi/bioc-registry@aaaaaaa, ' +
        'but main was already at bbbbbbb (committed 2026-10-20) when the index was built; it may lag main.',
    );
  });

  it('is null for a commit at its head, however old the input is', () => {
    expect(inputStaleWarning(input({ fetched_at: '2025-09-17T00:00:00Z' }), now)).toBeNull();
  });

  it('flags an unknown commit at 14 days of as_of, not at 13', () => {
    const unknown = input({ commit: null, last_modified: '2026-10-08T00:00:00Z' });
    expect(inputStaleWarning(unknown, at('2026-10-21T23:59:59Z'))).toBeNull();
    expect(inputStaleWarning(unknown, at('2026-10-22T00:00:00Z'))).toBe(
      'https://raw.githubusercontent.com/seandavi/bioc-registry/main/README.md is 14 days old (as of 2026-10-08) and its source commit is unknown.',
    );
  });

  it('uses last_modified, else fetched_at, for the age of an unknown commit', () => {
    const fresh = input({ commit: null, last_modified: '2026-10-21T00:00:00Z', fetched_at: '2026-01-01T00:00:00Z' });
    expect(inputStaleWarning(fresh, now)).toBeNull();
    expect(inputStaleWarning(input({ commit: null, fetched_at: '2026-01-01T00:00:00Z' }), now)).toContain('294 days old');
  });
});

describe('inputNote', () => {
  it('gives the date, and the short commit when there is one', () => {
    expect(inputNote(input())).toBe('as of 2026-10-22, commit aaaaaaa');
    expect(inputNote(input({ commit: null, last_modified: '2026-10-16T23:22:32.000Z' }))).toBe('as of 2026-10-16');
  });
});

describe('docsFreshness', () => {
  const a = input();
  const b = input({ url: 'https://raw.githubusercontent.com/seandavi/bioc-edge/main/README.md', commit: behind });

  it('is clean for a current index and inputs at their heads', () => {
    expect(docsFreshness(metaOf([a]), [a], at('2026-10-22T06:00:00Z'))).toEqual({
      index_built_at: BUILT,
      index_age_days: 0,
      possibly_stale: [],
    });
  });

  it('lists the index warning first, then each distinct input once, in first-appearance order', () => {
    const c = input({ url: 'https://docs.test/search.json', commit: null, fetched_at: '2026-09-01T00:00:00Z' });
    const result = docsFreshness(metaOf([a, b, c]), [b, a, b, c, c], at('2026-10-25T00:00:00Z'));
    expect(result.index_age_days).toBe(3);
    expect(result.possibly_stale).toEqual([
      indexStaleWarning(metaOf([a]), at('2026-10-25T00:00:00Z')),
      inputStaleWarning(b, at('2026-10-25T00:00:00Z')),
      inputStaleWarning(c, at('2026-10-25T00:00:00Z')),
    ]);
    expect(result.possibly_stale).toHaveLength(3);
    expect(() => DocsFreshnessSchema.parse(result)).not.toThrow();
  });

  it('leaves out inputs that are not in `inputs`', () => {
    expect(docsFreshness(metaOf([a, b]), [a], at(BUILT)).possibly_stale).toEqual([]);
  });
});
