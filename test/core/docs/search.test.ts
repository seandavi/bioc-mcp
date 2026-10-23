import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { docsSearchCapability, DocsSearchHitSchema, DocsSearchInputSchema, snippet } from '../../../src/core/docs/search';
import type { Deps } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import type { Capability } from '../../../src/core/capability';
import { envelopeBytes, MAX_RESULT_BYTES } from '../../../src/envelope';
import type { DocsIndex } from '../../../src/docs-index/load';
import type { DocsRecord } from '../../../src/docs-index/schema';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { fixtureDocsIndex, fixtureDocsIndexWith, syntheticDocsIndex } from '../../support/docs';
import { fixtureFetch } from '../../support/fixture-fetch';
import { testContext } from '../../support/invoke-context';

const BASE = 'https://seandavi.github.io/bioc-infrastructure/';

let index: DocsIndex;
let search: Capability;
beforeAll(async () => {
  index = await fixtureDocsIndex();
  search = docsSearchCapability(() => index);
});

function deps() {
  const now = () => new Date('2026-10-22T12:00:00Z');
  const fetch = fixtureFetch({});
  return { fetch, deps: { fetch, cache: createMemoryCache(now), now, env: {} } satisfies Deps };
}

async function run(capability: Capability, input: unknown) {
  const d = deps();
  const result = await invokeCapability(capability, input, d.deps, testContext());
  expect(d.fetch.calls).toEqual([]);
  return result;
}

async function ok(input: unknown, capability = search) {
  const result = await run(capability, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.envelope as { data: any; summary: string; sources: { url: string; as_of: string }[] };
}

describe('ranking questions', () => {
  it.each([
    ['why does the registry poll', undefined, `${BASE}propagation-gate.html#why-the-registry-polls`],
    ['how are download stats counted', undefined, `${BASE}download-stats.html#what-counts-as-a-download`],
    ['purging the cache', undefined, `${BASE}cache.html#purging`],
    ['DuckDB sql console', undefined, 'https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#get-sql'],
  ])('%j (source %j) ranks %s first', async (query, source, url) => {
    const { data } = await ok({ query, ...(source ? { source } : {}) });
    expect(data.hits[0].url).toBe(url);
  });

  it('"why are client addresses hashed" (source "adr") ranks a record of ADR 0009 first', async () => {
    const { data } = await ok({ query: 'why are client addresses hashed', source: 'adr' });
    expect(data.hits[0].url.startsWith(`${BASE}adr/0009-client-addresses-are-hashed-at-the-edge.html`)).toBe(true);
  });
});

describe('source filter', () => {
  it('adr returns only ADR hits, with redirects ranking ADR 0013 first', async () => {
    const { data } = await ok({ query: 'redirects', source: 'adr' });
    expect(data.hits[0].url).toContain('/adr/0013-');
    expect(data.hits.every((h: any) => h.source === 'adr')).toBe(true);
    expect(data.source).toBe('adr');
  });

  it('repo:bioc-edge returns only that repo', async () => {
    const { data, summary } = await ok({ query: 'data plane', source: 'repo:bioc-edge' });
    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits.every((h: any) => h.repo === 'bioc-edge')).toBe(true);
    expect(summary).toContain('in repo:bioc-edge');
  });

  it('site returns only site hits', async () => {
    const { data } = await ok({ query: 'registry', source: 'site' });
    expect(data.hits.every((h: any) => h.source === 'site')).toBe(true);
  });

  it('an unknown repo is invalid_input listing the valid sources', async () => {
    const result = await run(search, { query: 'edge', source: 'repo:nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain('repo:bioc-registry');
      expect(result.error.message).toContain('Valid: site, adr,');
    }
  });
});

describe('input validation', () => {
  it.each([
    ['limit 11', { query: 'registry', limit: 11 }],
    ['limit 0', { query: 'registry', limit: 0 }],
    ['blank query', { query: '   ' }],
    ['257-character query', { query: 'a'.repeat(257) }],
    ['empty repo name', { query: 'registry', source: 'repo:' }],
    ['unknown source kind', { query: 'registry', source: 'wiki' }],
    ['205-character source', { query: 'registry', source: 'repo:' + 'a'.repeat(200) }],
  ])('rejects %s', async (_label, input) => {
    const result = await run(search, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
  });

  it('does not echo an over-long source in the message', async () => {
    const result = await run(search, { query: 'registry', source: 'repo:' + 'a'.repeat(200) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain('a'.repeat(200));
  });

  it('accepts a real repo source and says site excludes ADRs', async () => {
    expect((await ok({ query: 'registry', source: 'repo:bioc-registry' })).data.hits.length).toBeGreaterThan(0);
    const properties = (z.toJSONSchema(DocsSearchInputSchema) as any).properties;
    expect(properties.source.description).toContain('pages other than ADRs');
  });
});

describe('query words', () => {
  const Q18 =
    'registry poll webhooks gate propagation edge traffic build manifest website universe check status release download cache worker deploy';

  it('says in the query describe that only 16 words are searched', () => {
    const properties = (z.toJSONSchema(DocsSearchInputSchema) as any).properties;
    expect(properties.query.description).toContain('only the first 16 other distinct words are searched');
  });

  it('names the words it did not search', async () => {
    const { summary } = await ok({ query: Q18 });
    expect(summary).toContain('not searched: worker deploy. Put the key words first.');
  });

  it('says nothing about skipped words for 16 distinct words', async () => {
    const { summary } = await ok({ query: Q18.split(' ').slice(0, 16).join(' ') });
    expect(summary).not.toContain('not searched');
  });
});

describe('results', () => {
  it('defaults to 8 hits and honours limit', async () => {
    expect((await ok({ query: 'registry' })).data.hits).toHaveLength(8);
    expect((await ok({ query: 'registry', limit: 3 })).data.hits.length).toBeLessThanOrEqual(3);
  });

  it('returns hits of the declared shape with short snippets', async () => {
    const { data } = await ok({ query: 'registry' });
    for (const hit of data.hits) {
      expect(DocsSearchHitSchema.safeParse(hit).success).toBe(true);
      expect(hit.snippet.length).toBeLessThanOrEqual(202);
      expect(Number.isFinite(hit.score)).toBe(true);
    }
    expect(data.omitted_for_size).toBe(0);
  });

  it('labels ADR sections from their anchors', async () => {
    const { data } = await ok({ query: 'client addresses hashed decision', source: 'adr' });
    const sections = data.hits.map((h: any) => h.section);
    expect(sections).toContain('Decision');
    expect(sections.every((s: string) => typeof s === 'string')).toBe(true);
  });

  it('lists the distinct page urls of the hits', async () => {
    const { data, sources } = await ok({ query: 'registry' });
    const pageUrls = [...new Set<string>(data.hits.map((h: any) => h.url.split('#')[0]))];
    expect(sources.map((s) => s.url)).toEqual(pageUrls);
    for (const source of sources) {
      const record = index.records.find((r) => r.url.split('#')[0] === source.url)!;
      expect(source.as_of).toBe(index.inputFor(record.id)!.fetched_at);
      expect(source.url.endsWith('search.json')).toBe(false);
    }
  });

  it('summarises hits with a numbered list of urls', async () => {
    const { summary, data } = await ok({ query: 'purging the cache', limit: 2 });
    expect(summary.startsWith('2 docs sections for "purging the cache":\n1. ')).toBe(true);
    expect(summary).toContain(data.hits[0].url);
  });

  it('says so, and points at pkg_status, with no hits', async () => {
    const { data, summary, sources } = await ok({ query: 'zzzqqqxxx', source: 'adr' });
    expect(data.hits).toEqual([]);
    expect(sources).toEqual([]);
    expect(summary).toBe(
      'No docs sections match "zzzqqqxxx" in adr. Try other words or drop source. For live package state use pkg_status; for open issues or failing workflows use ops_activity.',
    );
  });
});

describe('size guard', () => {
  it('drops trailing hits so the envelope stays under 8 KB', async () => {
    const long = (c: string) => c.repeat(190);
    const records: DocsRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: `site:p${i}.html#s`,
      url: `https://docs.test/${long('u')}${i}.html`.slice(0, 190) + `#${i}`,
      title: `${long('t')}${i}`.slice(0, 190),
      section: `${long('s')}${i}`.slice(0, 190),
      crumbs: [long('c')],
      text: `needle ${'filler words '.repeat(40)}`,
      source: 'site',
    }));
    const synthetic = docsSearchCapability(() => syntheticDocsIndex(records));
    const envelope = await ok({ query: 'needle', limit: 10 }, synthetic);
    expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(envelope.data.omitted_for_size).toBeGreaterThan(0);
    expect(envelope.data.hits.length + envelope.data.omitted_for_size).toBe(10);
    expect(envelope.summary).toMatch(/\d+ more hits? (was|were) dropped to stay under 8 KB/);
    expect(envelope.summary).toContain('they rank below these. Narrow with source or more specific words to see others.');
    expect(envelope.summary).not.toContain('lower limit');
  });
});

describe('heading-only sections', () => {
  it('cuts the snippet from the subsections when the hit text is only its heading', async () => {
    const { data } = await ok({ query: 'cloudflare account migration procedure', limit: 1 });
    expect(data.hits[0].url).toBe(`${BASE}cloudflare-account-migration.html#procedure`);
    expect(data.hits[0].snippet.startsWith('Procedure A. Prepare the new account')).toBe(true);
  });
});

describe('snippet', () => {
  const filler = 'lorem ipsum dolor sit amet '.repeat(30);

  it('returns short text unchanged, with whitespace collapsed', () => {
    expect(snippet('a  b\n\nc', 'b')).toBe('a b c');
  });

  it('starts at the beginning and ends with … when nothing matches', () => {
    const out = snippet(filler, 'zzz');
    expect(out.startsWith('lorem ipsum')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(202);
  });

  it('centres on a match in the middle of the text, with leading and trailing …', () => {
    const text = filler + 'the needle is here ' + filler;
    const out = snippet(text, 'find needle');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toContain('needle');
    expect(out.length).toBeLessThanOrEqual(202);
  });

  it('matches only at word starts', () => {
    const text = 'xxneedle '.repeat(3) + filler + 'needle here ' + filler;
    expect(snippet(text, 'needle')).toContain('needle here');
  });

  it('ignores query words shorter than 3 characters', () => {
    expect(snippet(filler + 'ab marker ' + filler, 'ab').startsWith('lorem')).toBe(true);
  });

  it('never ends between the halves of a surrogate pair', () => {
    const text = 'a'.repeat(199) + '😀' + 'b'.repeat(50);
    const out = snippet(text, 'zzz');
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('freshness', () => {
  const BUILT = new Date('2026-10-22T00:00:00Z');
  const LIVE_SHA = '256fd62eab16312a6188bef6bf74ea2bbab5f830';
  const INDEX_WARNING = (days: number) =>
    `The docs index was built 2026-10-22, ${days} days ago; it is rebuilt daily, so docs changed since then are not in it.`;

  async function at(now: Date, input: unknown, capability: Capability = search) {
    const d = deps();
    const result = await invokeCapability(capability, input, { ...d.deps, now: () => now }, testContext());
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.envelope as { data: any; summary: string; sources: { url: string; as_of: string }[] };
  }

  const record: DocsRecord = {
    id: 'site:p.html#s',
    url: 'https://docs.test/p.html#s',
    title: 'T',
    section: 'S',
    crumbs: [],
    text: 'needle in a haystack',
    source: 'site',
  };

  it('gives each hit as_of and source_commit: the live deployment for the site, the branch head for a repo', async () => {
    const { data } = await ok({ query: 'data plane', limit: 10 });
    const site = data.hits.find((hit: any) => hit.source !== 'repo');
    const repo = data.hits.find((hit: any) => hit.source === 'repo');
    expect(site).toMatchObject({ as_of: index.meta.inputs[0]!.fetched_at, source_commit: LIVE_SHA });
    const input = index.meta.inputs.find((i) => i.url.includes(`/${repo.repo}/`))!;
    expect(repo).toMatchObject({ as_of: input.fetched_at, source_commit: input.commit!.sha });
    expect(repo.source_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('gives source_commit null for an input with an unknown commit', async () => {
    const unknown = docsSearchCapability(() => syntheticDocsIndex([record]));
    const { data } = await at(BUILT, { query: 'needle' }, unknown);
    expect(data.hits[0]).toMatchObject({ as_of: '2026-10-22T00:00:00.000Z', source_commit: null });
  });

  it('ends each summary line with the as-of date and short commit, then says when the index was built', async () => {
    const { summary, data } = await at(BUILT, { query: 'propagation gate', limit: 2 });
    expect(data.freshness).toEqual({ index_built_at: '2026-10-22T00:00:00.000Z', index_age_days: 0, possibly_stale: [] });
    const lines = summary.split('\n');
    expect(lines[0]).toBe('2 docs sections for "propagation gate":');
    expect(lines[1]!.startsWith('1. ')).toBe(true);
    expect(lines[1]!.endsWith(` ${data.hits[0].url} (as of 2026-10-22, commit 256fd62)`)).toBe(true);
    expect(lines[2]!.endsWith(` ${data.hits[1].url} (as of 2026-10-22, commit 256fd62)`)).toBe(true);
    expect(lines[3]).toBe('Index built 2026-10-22 (0 days old).');
    expect(lines).toHaveLength(4);
  });

  it('says "1 day old" at one day', async () => {
    const { summary } = await at(new Date('2026-10-23T12:00:00Z'), { query: 'propagation gate', limit: 1 });
    expect(summary).toContain('\nIndex built 2026-10-22 (1 day old).');
  });

  it('puts the index warning in the data and the summary at 2 days, not at 1 day 23:59', async () => {
    const stale = await at(new Date('2026-10-24T00:00:00Z'), { query: 'propagation gate', limit: 1 });
    expect(stale.data.freshness).toMatchObject({ index_age_days: 2, possibly_stale: [INDEX_WARNING(2)] });
    expect(stale.summary).toContain(`\nPossibly stale: ${INDEX_WARNING(2)}`);
    // The warning follows the "Index built" line.
    expect(stale.summary.indexOf('Index built')).toBeLessThan(stale.summary.indexOf('Possibly stale'));

    const fresh = await at(new Date('2026-10-23T23:59:00Z'), { query: 'propagation gate', limit: 1 });
    expect(fresh.data.freshness.possibly_stale).toEqual([]);
    expect(fresh.summary).not.toContain('Possibly stale');
  });

  it('puts the index warning in a no-hits summary too', async () => {
    const stale = await at(new Date('2026-10-25T00:00:00Z'), { query: 'zzzqqqxxx', source: 'adr' });
    expect(stale.data.hits).toEqual([]);
    expect(stale.summary).toBe(
      'No docs sections match "zzzqqqxxx" in adr. Try other words or drop source. For live package state use pkg_status; for open issues or failing workflows use ops_activity.' +
        `\nPossibly stale: ${INDEX_WARNING(3)}`,
    );
    const fresh = await at(BUILT, { query: 'zzzqqqxxx', source: 'adr' });
    expect(fresh.summary).not.toContain('Possibly stale');
  });

  it('warns about an input behind its branch only when a kept hit comes from it', async () => {
    const behindIndex = await fixtureDocsIndexWith((inputs) => {
      const edge = inputs.find((i) => i.url.includes('/bioc-edge/main/DATAPLANE.md'))!;
      edge.commit = { ...edge.commit!, head_sha: 'b'.repeat(40), head_committed_at: '2026-10-20T08:09:10Z' };
    });
    const behind = docsSearchCapability(() => behindIndex);
    const edgeSha = behindIndex.meta.inputs.find((i) => i.url.includes('/bioc-edge/main/DATAPLANE.md'))!.commit!.sha;
    const warning =
      `Docs under https://github.com/seandavi/bioc-edge/blob/main/DATAPLANE.md come from seandavi/bioc-edge@${edgeSha.slice(0, 7)}, ` +
      'but main was already at bbbbbbb (committed 2026-10-20) when the index was built; they may lag main.';

    const hit = await at(BUILT, { query: 'data plane', source: 'repo:bioc-edge' }, behind);
    expect(hit.data.freshness.possibly_stale).toEqual([warning]);
    expect(hit.summary).toContain(`\nPossibly stale: ${warning}`);

    const other = await at(BUILT, { query: 'purging the cache', source: 'site' }, behind);
    expect(other.data.freshness.possibly_stale).toEqual([]);
    expect(other.summary).not.toContain('Possibly stale');
  });

  it('warns about an unknown commit at 14 days of age, not at 13', async () => {
    const unknown = docsSearchCapability(() => syntheticDocsIndex([record]));
    const warning = 'Docs under https://docs.test/ are 14 days old (as of 2026-10-22) and their source commit is unknown.';
    const at14 = await at(new Date('2026-11-05T00:00:00Z'), { query: 'needle' }, unknown);
    expect(at14.data.freshness.possibly_stale).toContain(warning);
    expect(at14.summary).toContain(`\nPossibly stale: ${warning}`);
    const at13 = await at(new Date('2026-11-04T23:59:59Z'), { query: 'needle' }, unknown);
    expect(at13.data.freshness.possibly_stale.some((w: string) => w.includes('source commit is unknown'))).toBe(false);
  });

  it('never warns about an input at its branch head, however old', async () => {
    const atHead = docsSearchCapability(() =>
      syntheticDocsIndex([record], {
        repo: 'seandavi/docs',
        ref: 'main',
        sha: 'c'.repeat(40),
        head_sha: 'c'.repeat(40),
        head_committed_at: '2025-01-01T00:00:00Z',
      }),
    );
    const { data } = await at(new Date('2027-11-22T00:00:00Z'), { query: 'needle' }, atHead);
    expect(data.freshness.possibly_stale).toEqual([INDEX_WARNING(396)]);
  });

  it('keeps the envelope within 8 KB at limit 10 for a stale, behind index', async () => {
    const behindIndex = await fixtureDocsIndexWith((inputs) => {
      for (const input of inputs) input.commit = { ...input.commit!, head_sha: 'b'.repeat(40), head_committed_at: '2026-10-20T08:09:10Z' };
    });
    const behind = docsSearchCapability(() => behindIndex);
    for (const query of ['why does the registry poll', 'how are download stats counted', 'purging the cache']) {
      const envelope = await at(new Date('2026-12-01T00:00:00Z'), { query, limit: 10 }, behind);
      expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    }
  });
});
