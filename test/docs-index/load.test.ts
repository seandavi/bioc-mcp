import { beforeAll, describe, expect, it } from 'vitest';
import { QUERY_STOP_WORDS, SUPERSEDED_ADR_BOOST, loadDocsIndex, type DocsIndex } from '../../src/docs-index/load';
import { syntheticDocsIndex } from '../support/docs';
import type { DocsRecord } from '../../src/docs-index/schema';
import { fixtureArtifact } from './support';
import type { DocsIndexArtifact } from '../../scripts/docs-index/build';

let artifact: DocsIndexArtifact;
let index: DocsIndex;
beforeAll(async () => {
  artifact = await fixtureArtifact();
  index = loadDocsIndex(artifact);
});

describe('loadDocsIndex', () => {
  it('loads every record', () => {
    expect(index.records).toHaveLength(index.meta.record_count);
  });

  it('ranks the propagation gate page first for "propagation gate"', () => {
    expect(index.search('propagation gate')[0]?.record.id).toMatch(/^site:propagation-gate\.html/);
  });

  it('ranks the registry polling section first', () => {
    expect(index.search('why does the registry poll')[0]?.record.id).toBe(
      'site:propagation-gate.html#why-the-registry-polls',
    );
  });

  it('limits hits to 8 by default and to the given limit', () => {
    expect(index.search('registry')).toHaveLength(8);
    expect(index.search('registry', 3)).toHaveLength(3);
  });

  it('filters inside the ranked search, before the limit', () => {
    const hits = index.search('gate', 8, (record) => record.source === 'adr');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(8);
    expect(hits.every((hit) => hit.record.source === 'adr')).toBe(true);
    expect(index.search('registry', 3, (record) => record.source === 'repo')).toHaveLength(3);
  });

  it('returns nothing when the filter rejects everything, and still checks limit', () => {
    expect(index.search('registry', 8, () => false)).toEqual([]);
    expect(() => index.search('registry', 0, () => true)).toThrow(RangeError);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects limit %s', (limit) => {
    expect(() => index.search('registry', limit)).toThrow(RangeError);
  });

  it('gets a record and finds its input', () => {
    expect(index.get('site:propagation-gate.html')?.source).toBe('site');
    expect(index.get('site:nope')).toBeUndefined();
    expect(index.inputFor('site:propagation-gate.html')?.url).toBe(
      'https://seandavi.github.io/bioc-infrastructure/search.json',
    );
    expect(index.inputFor('repo:bioc-edge/DATAPLANE.md#cloudflare-workflows-v')?.url).toBe(
      'https://raw.githubusercontent.com/seandavi/bioc-edge/main/DATAPLANE.md',
    );
  });

  it('throws on a different format_version', () => {
    const store = { ...artifact.store, format_version: 1 };
    expect(() => loadDocsIndex({ storeJson: JSON.stringify(store), indexJson: artifact.indexJson })).toThrow(
      /format_version 2/,
    );
  });

  it('throws when the store and the index disagree on record count', () => {
    const records = artifact.store.records.slice(0, -1);
    const store = {
      ...artifact.store,
      meta: {
        ...artifact.store.meta,
        record_count: records.length,
        inputs: artifact.store.meta.inputs.map((input, i, all) =>
          i === all.length - 1 ? { ...input, record_count: input.record_count - 1 } : input,
        ),
      },
      records,
    };
    expect(() => loadDocsIndex({ storeJson: JSON.stringify(store), indexJson: artifact.indexJson })).toThrow(
      /documents/,
    );
  });

  it('throws when input record counts do not sum to meta.record_count', () => {
    const inputs = artifact.store.meta.inputs.map((input, i) =>
      i === 0 ? { ...input, record_count: input.record_count + 1 } : input,
    );
    const store = { ...artifact.store, meta: { ...artifact.store.meta, inputs } };
    expect(() => loadDocsIndex({ storeJson: JSON.stringify(store), indexJson: artifact.indexJson })).toThrow(
      /inputs claim/,
    );
  });

  function loadWith(records: typeof artifact.store.records) {
    return () => loadDocsIndex({ storeJson: JSON.stringify({ ...artifact.store, records }), indexJson: artifact.indexJson });
  }

  it('throws when a store id is not in the index', () => {
    const records = artifact.store.records.map((r, i) => (i === 0 ? { ...r, id: 'site:renamed.html' } : r));
    expect(loadWith(records)).toThrow(/disagree on record ids/);
  });

  it('throws on a duplicate record id', () => {
    const records = [...artifact.store.records];
    records[1] = { ...records[1]!, id: records[0]!.id };
    expect(loadWith(records)).toThrow(/duplicate record id/);
  });

  it.each(['javascript:alert(1)', 'http://example.org/'])('rejects a record url %s', (url) => {
    const records = artifact.store.records.map((r, i) => (i === 0 ? { ...r, url } : r));
    expect(loadWith(records)).toThrow(/format_version 2/);
  });

  it('uses at most 16 distinct query terms', () => {
    const scored = (query: string) => index.search(query).map((hit) => [hit.record.id, hit.score]);
    expect(scored('registry ' + 'zzz '.repeat(100))).toEqual(scored('registry zzz'));

    const misses = Array.from({ length: 16 }, (_, i) => 'zqxj' + String.fromCharCode(97 + i)).join(' ');
    expect(index.search(`${misses} registry`)).toEqual([]);
    expect(index.search(`registry ${misses}`).length).toBeGreaterThan(0);
  });

  it('ranks the rollback-worker runbook first for "how do I roll back the Worker"', () => {
    expect(index.search('how do I roll back the Worker')[0]?.record.id).toBe('site:operations.html#rollback-worker');
  });

  it('drops stop words from the query', () => {
    const scored = (query: string) => index.search(query).map((hit) => [hit.record.id, hit.score]);
    expect(scored('how do I purge the cache')).toEqual(scored('purge cache'));
  });

  it('still searches a query of only stop words', () => {
    expect(index.search('how do I').length).toBeGreaterThan(0);
  });

  it('does not count stop words against the 16-term budget', () => {
    const stops = [...QUERY_STOP_WORDS].slice(0, 16).join(' ');
    expect(index.search(`${stops} registry`)).toEqual(index.search('registry'));
  });

  describe('term length gates', () => {
    const synthetic = syntheticDocsIndex([
      { id: 'site:a.html', url: 'https://docs.test/a.html', title: 'A', section: '', crumbs: [], text: 'the cache', source: 'site' },
      { id: 'site:b.html', url: 'https://docs.test/b.html', title: 'B', section: '', crumbs: [], text: 'purging stale files', source: 'site' },
    ]);
    const ids = (query: string) => synthetic.search(query).map((hit) => hit.record.id);

    it('expands a prefix only for terms of 4 or more characters', () => {
      expect(ids('cac')).toEqual([]);
      expect(ids('cach')).toEqual(['site:a.html']);
    });

    it('matches fuzzily only for terms of 6 or more characters', () => {
      expect(ids('cachr')).toEqual([]);
      expect(ids('purgingg')).toEqual(['site:b.html']);
    });
  });

  describe('superseded ADRs', () => {
    const adr = (n: string, status: string): DocsRecord => ({
      id: `site:adr/${n}.html`,
      url: `https://docs.test/adr/${n}.html`,
      title: 'Hash the addresses',
      section: '',
      crumbs: [],
      text: `Status: ${status}\nHash the addresses at the edge.`,
      source: 'adr',
    });

    it('scores a superseded ADR SUPERSEDED_ADR_BOOST times as high as an identical current one', () => {
      const synthetic = syntheticDocsIndex([adr('0001', 'Superseded by 0002'), adr('0002', 'Accepted by 0002')]);
      const hits = synthetic.search('hash addresses');
      expect(hits.map((hit) => hit.record.id)).toEqual(['site:adr/0002.html', 'site:adr/0001.html']);
      expect(hits[1]!.score).toBeCloseTo(hits[0]!.score * SUPERSEDED_ADR_BOOST, 9);
    });
  });
});
