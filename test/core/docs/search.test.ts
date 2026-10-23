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
import { fixtureDocsIndex, syntheticDocsIndex } from '../../support/docs';
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
