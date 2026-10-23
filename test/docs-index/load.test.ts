import { beforeAll, describe, expect, it } from 'vitest';
import { loadDocsIndex, type DocsIndex } from '../../src/docs-index/load';
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
    const store = { ...artifact.store, format_version: 2 };
    expect(() => loadDocsIndex({ storeJson: JSON.stringify(store), indexJson: artifact.indexJson })).toThrow(
      /format_version 1/,
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
});
