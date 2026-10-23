import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Capability } from '../../../src/core/capability';
import type { Deps } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import { docsPages, renderPage, renderSection, type DocsPages } from '../../../src/core/docs/pages';
import { DOCS_READ_TEXT_BUDGET } from '../../../src/core/docs/chunk';
import { docsReadCapability, resolveDocsTarget } from '../../../src/core/docs/read';
import { MAX_RESULT_BYTES, envelopeBytes } from '../../../src/envelope';
import type { DocsIndex } from '../../../src/docs-index/load';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { fixtureDocsIndex, syntheticDocsIndex } from '../../support/docs';
import { fixtureFetch } from '../../support/fixture-fetch';
import { testContext } from '../../support/invoke-context';

const BASE = 'https://seandavi.github.io/bioc-infrastructure/';
const GATE = `${BASE}propagation-gate.html`;
const POLLS = `${GATE}#why-the-registry-polls`;

let index: DocsIndex;
let pages: DocsPages;
let read: Capability;
beforeAll(async () => {
  index = await fixtureDocsIndex();
  pages = docsPages(index);
  read = docsReadCapability(() => index);
});

function deps() {
  const now = () => new Date('2026-10-22T12:00:00Z');
  const fetch = fixtureFetch({});
  return { fetch, deps: { fetch, cache: createMemoryCache(now), now, env: {} } satisfies Deps };
}

async function run(input: unknown) {
  const d = deps();
  const result = await invokeCapability(read, input, d.deps, testContext());
  expect(d.fetch.calls).toEqual([]);
  return result;
}

async function ok(input: unknown) {
  const result = await run(input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.envelope as { data: any; summary: string; sources: { url: string; as_of: string }[] };
}

async function failure(input: unknown) {
  const result = await run(input);
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

describe('resolution', () => {
  it.each([GATE, 'site:propagation-gate.html', 'bioc://docs/propagation-gate.html', `  ${GATE}  `])(
    '%j reads the whole page',
    async (input) => {
      const { data } = await ok({ id_or_url: input });
      expect(data.kind).toBe('page');
      expect(data.url).toBe(GATE);
      expect(data.resource_uri).toBe('bioc://docs/propagation-gate.html');
      expect(data.section).toBe('');
      expect(data.text.startsWith('# ')).toBe(true);
    },
  );

  it.each([POLLS, 'site:propagation-gate.html#why-the-registry-polls', 'bioc://docs/propagation-gate.html#why-the-registry-polls'])(
    '%j reads that section',
    async (input) => {
      const { data, summary } = await ok({ id_or_url: input });
      expect(data).toMatchObject({ kind: 'section', url: POLLS, section: 'Why the registry polls', title: expect.any(String) });
      expect(data.text.startsWith('## Why the registry polls\n\n' + POLLS)).toBe(true);
      expect(summary).toMatch(/^".+" › Why the registry polls \(.+\), full text, \d+ characters\.$/);
    },
  );

  it('reads a repo document by resource URI', async () => {
    const { data } = await ok({ id_or_url: 'bioc://docs/repo/bioc-edge/DATAPLANE.md' });
    expect(data).toMatchObject({ kind: 'page', source: 'repo', repo: 'bioc-edge' });
    expect(data.url).toBe('https://github.com/seandavi/bioc-edge/blob/main/DATAPLANE.md');
  });

  it('treats a trailing # as the whole page', () => {
    expect(resolveDocsTarget(pages, `${GATE}#`).kind).toBe('page');
  });

  it('cites the page url, dated by its input', async () => {
    const asOf = index.meta.inputs[0]!.fetched_at;
    expect((await ok({ id_or_url: GATE })).sources).toEqual([{ url: GATE, as_of: asOf }]);
    expect((await ok({ id_or_url: POLLS })).sources).toEqual([{ url: GATE, as_of: asOf }]);
    const repo = await ok({ id_or_url: 'bioc://docs/repo/bioc-edge/DATAPLANE.md' });
    expect(repo.sources).toHaveLength(1);
    expect(repo.sources[0]!.url).toBe('https://github.com/seandavi/bioc-edge/blob/main/DATAPLANE.md');
  });
});

describe('pagination', () => {
  it('splits the largest page into several parts that each fit in 8 KB', async () => {
    const first = (await ok({ id_or_url: `${BASE}proposal-unified-search.html` })).data;
    expect(first.next_cursor).not.toBeNull();
    expect(first.offset).toBe(0);
  });

  it('summarises one part and several parts', async () => {
    const single = await ok({ id_or_url: POLLS });
    expect(single.summary).toContain(', full text, ');
    const big = await ok({ id_or_url: `${BASE}proposal-unified-search.html` });
    expect(big.summary).toContain(`, characters 1–${big.data.next_cursor} of ${big.data.total_chars}.`);
    expect(big.summary).toContain(`Call docs_read again with cursor "${big.data.next_cursor}" for the rest.`);
    const next = await ok({ id_or_url: `${BASE}proposal-unified-search.html`, cursor: big.data.next_cursor });
    expect(next.summary).toContain(`characters ${Number(big.data.next_cursor) + 1}–`);
  });

  it('reads every page and every section in full within the size limit', async () => {
    const targets = [
      ...pages.list.map((page) => ({ input: page.id, full: renderPage(page) })),
      ...pages.list.flatMap((page) =>
        page.records.filter((r) => r.id !== page.id).map((r) => ({ input: r.id, full: renderSection(r) })),
      ),
    ];
    expect(targets.length).toBeGreaterThan(index.records.length - 1);
    for (const { input, full } of targets) {
      let cursor: string | undefined;
      let rebuilt = '';
      let previous: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const result = await run({ id_or_url: input, ...(cursor ? { cursor } : {}) });
        if (!result.ok) throw new Error(`${input}: ${result.error.message}`);
        expect(envelopeBytes(result.envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
        const data = result.envelope.data as any;
        expect(data.offset).toBe(previous === null ? 0 : Number(previous));
        expect(data.total_chars).toBe(full.length);
        rebuilt += data.text;
        previous = data.next_cursor;
        if (previous === null) break;
        cursor = previous;
      }
      expect(previous).toBeNull();
      expect(rebuilt).toBe(full);
    }
  });
});

describe('budget', () => {
  it('fits a page with very long metadata', async () => {
    const idx = syntheticDocsIndex([
      {
        id: 'site:big.html',
        url: `https://docs.test/${'u'.repeat(800)}.html`,
        title: 'T'.repeat(1000),
        section: '',
        crumbs: Array.from({ length: 4 }, () => 'C'.repeat(250)),
        text: 'word '.repeat(6000).trim(),
        source: 'site',
      },
    ]);
    const capability = docsReadCapability(() => idx);
    const full = renderPage(docsPages(idx).list[0]!);
    let cursor: string | undefined;
    let rebuilt = '';
    let firstText: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const result = await invokeCapability(
        capability,
        { id_or_url: 'site:big.html', ...(cursor ? { cursor } : {}) },
        deps().deps,
        testContext(),
      );
      if (!result.ok) throw new Error(result.error.message);
      expect(envelopeBytes(result.envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      const data = result.envelope.data as any;
      firstText ??= data.text;
      rebuilt += data.text;
      if (data.next_cursor === null) break;
      cursor = data.next_cursor;
    }
    expect(rebuilt).toBe(full);
    expect(new TextEncoder().encode(JSON.stringify(firstText)).length - 2).toBeLessThan(DOCS_READ_TEXT_BUDGET);
  });
});

describe('cursor', () => {
  it('rejects a cursor past the end', async () => {
    const error = await failure({ id_or_url: POLLS, cursor: '9999999' });
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('past the end');
  });

  it('rejects a cursor at the end of the text', async () => {
    const total = (await ok({ id_or_url: POLLS })).data.total_chars;
    expect((await failure({ id_or_url: POLLS, cursor: String(total) })).code).toBe('invalid_input');
  });

  it.each(['abc', '-1', '1.5', '', '12345678'])('rejects the cursor %j', async (cursor) => {
    expect((await failure({ id_or_url: POLLS, cursor })).code).toBe('invalid_input');
  });
});

describe('not_found', () => {
  it('lists close matches for a mistyped page URL', async () => {
    const error = await failure({ id_or_url: `${BASE}propagation-gates.html` });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain(GATE);
    expect(error.message).toContain('never fetches URLs');
    expect(error.message).toContain('Close matches:');
  });

  it('refuses a foreign host without a request', async () => {
    const error = await failure({ id_or_url: 'https://evil.example/x' });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('never fetches URLs');
  });

  it('names the page and lists its own sections for an unknown section', async () => {
    const error = await failure({ id_or_url: `${GATE}#nope` });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain(`No section "#nope" on ${GATE}.`);
    const listed = error.message.match(/https:\/\/[^\s,]+#[^\s,.]+/g) ?? [];
    expect(listed.length).toBeGreaterThan(0);
    const page = pages.byUrl.get(GATE)!;
    for (const url of listed) expect(page.records.some((r) => r.url === url)).toBe(true);
  });

  it('ranks sections of that page by the fragment words', async () => {
    const error = await failure({ id_or_url: `${GATE}#registry-polling` });
    expect(error.message).toContain(POLLS);
  });

  it.each(['a b', '---', 'https://www.github.com/seandavi/main', 'site.html'])(
    'gives no close matches for %j when no usable words remain',
    async (input) => {
      const error = await failure({ id_or_url: input });
      expect(error.code).toBe('not_found');
      expect(error.message).toContain('Use docs_search to find one.');
    },
  );

  it('truncates a long input to 200 characters in the message', async () => {
    const error = await failure({ id_or_url: 'x'.repeat(500) });
    expect(error.message).toContain(`"${'x'.repeat(200)}…"`);
    expect(error.message).not.toContain('x'.repeat(201));
  });

  it('truncates a long section fragment to 200 characters in the message', async () => {
    const error = await failure({ id_or_url: `${GATE}#${'x'.repeat(2000)}`.slice(0, 2048) });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain(`"#${'x'.repeat(200)}…"`);
    expect(error.message).not.toContain('x'.repeat(201));
    expect(error.message.length).toBeLessThan(1500);
  });

  it('answers an http: URL from the index only', async () => {
    const error = await failure({ id_or_url: 'http://seandavi.github.io/bioc-infrastructure/propagation-gate.html' });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain(GATE);
  });
});

describe('close-match search bound', () => {
  const MAX_TERMS = 8;
  const MAX_TERM_LENGTH = 32;

  /** n distinct 3-letter words joined by `separator`: 'aaa', 'aab', … */
  function words(n: number, separator: string): string {
    return Array.from({ length: n }, (_, i) => 'a' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26))).join(separator);
  }

  function spiedIndex() {
    const search = vi.fn(index.search);
    return { search, index: { ...index, search } satisfies DocsIndex };
  }

  /** The search calls made while docs_read fails on `input`, as arrays of query terms. */
  async function termsSearched(input: string): Promise<string[][]> {
    const spied = spiedIndex();
    const result = await invokeCapability(docsReadCapability(() => spied.index), { id_or_url: input }, deps().deps, testContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
    return spied.search.mock.calls.map(([query]) => query.split(' '));
  }

  function expectBounded(calls: string[][]) {
    for (const terms of calls) {
      expect(terms.length).toBeLessThanOrEqual(MAX_TERMS);
      expect(new Set(terms).size).toBe(terms.length);
      for (const term of terms) expect(term.length).toBeLessThanOrEqual(MAX_TERM_LENGTH);
    }
  }

  it('caps a ~2,000-character section fragment of distinct words at 8 terms', async () => {
    const fragment = words(500, '.');
    const calls = await termsSearched(`${GATE}#${fragment}`.slice(0, 2048));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(MAX_TERMS);
    expectBounded(calls);
  });

  it('searches once, with one term, for a fragment of repeated words', async () => {
    const calls = await termsSearched(`${GATE}#${'abc.'.repeat(500)}`.slice(0, 2048));
    expect(calls).toEqual([['abc']]);
  });

  it('does not search for a fragment of one- and two-letter words', async () => {
    expect(await termsSearched(`${GATE}#${'a.'.repeat(1000)}`.slice(0, 2048))).toEqual([]);
  });

  it('caps a 2,048-character unknown URL of distinct 3-letter words at 8 terms', async () => {
    const calls = await termsSearched(`https://docs.example/${words(500, '-')}`.slice(0, 2048));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(MAX_TERMS);
    expectBounded(calls);
  });

  it('searches once, with one term, for an unknown URL of repeated words', async () => {
    const calls = await termsSearched(`site:${'foo-'.repeat(500)}`.slice(0, 2048));
    expect(calls).toEqual([['foo']]);
  });

  it('cuts a very long word to 32 characters', async () => {
    const calls = await termsSearched(`${GATE}#${'x'.repeat(2000)}`.slice(0, 2048));
    expect(calls).toEqual([['x'.repeat(MAX_TERM_LENGTH)]]);
  });
});
