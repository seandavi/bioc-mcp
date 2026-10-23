import MiniSearch from 'minisearch';
import {
  DOCS_FORMAT_VERSION,
  DOCS_INDEX_OPTIONS,
  DocsStoreSchema,
  type DocsIndexMeta,
  type DocsInput,
  type DocsRecord,
} from './schema';
import * as z from 'zod';

export interface DocsSearchHit {
  record: DocsRecord;
  score: number;
}

export interface DocsIndex {
  readonly meta: DocsIndexMeta;
  readonly records: readonly DocsRecord[]; // store order
  get(id: string): DocsRecord | undefined;
  /** The input (search.json or raw file) a record was built from, for provenance. */
  inputFor(id: string): DocsInput | undefined;
  /**
   * Ranked with DOCS_INDEX_OPTIONS.searchOptions over the first MAX_SEARCH_TERMS distinct terms of `query`;
   * at most `limit` (default 8) hits; RangeError unless `limit` is a positive integer. `filter` keeps only hits
   * whose record it accepts; applied inside the ranked search, before `limit`.
   */
  search(query: string, limit?: number, filter?: (record: DocsRecord) => boolean): DocsSearchHit[];
}

export interface DocsIndexJson {
  storeJson: string;
  indexJson: string;
}

const DEFAULT_LIMIT = 8;

/** search() uses at most this many distinct query terms: each costs one prefix and one fuzzy sub-query. */
export const MAX_SEARCH_TERMS = 16;

const tokenize: (text: string) => string[] = MiniSearch.getDefault('tokenize');

/** The first MAX_SEARCH_TERMS distinct lower-cased tokens of `query`, joined by ' '. */
function boundedQuery(query: string): string {
  const terms = new Set<string>();
  for (const token of tokenize(query)) {
    const term = token.toLowerCase();
    if (term === '') continue;
    terms.add(term);
    if (terms.size === MAX_SEARCH_TERMS) break;
  }
  return [...terms].join(' ');
}

/** Parses and checks both strings. Throws Error on any mismatch; never returns a partial index. */
export function loadDocsIndex(json: DocsIndexJson): DocsIndex {
  const parsed = DocsStoreSchema.safeParse(JSON.parse(json.storeJson));
  if (!parsed.success) {
    throw new Error(
      `Docs index store does not match format_version ${DOCS_FORMAT_VERSION}: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { meta, records } = parsed.data;

  if (meta.record_count !== records.length) {
    throw new Error(`Docs index store has ${records.length} records but meta.record_count is ${meta.record_count}`);
  }
  const inputTotal = meta.inputs.reduce((sum, input) => sum + input.record_count, 0);
  if (inputTotal !== records.length) {
    throw new Error(`Docs index inputs claim ${inputTotal} records but the store has ${records.length}`);
  }

  const byId = new Map<string, DocsRecord>();
  const inputById = new Map<string, DocsInput>();
  let offset = 0;
  for (const input of meta.inputs) {
    for (const record of records.slice(offset, offset + input.record_count)) {
      if (byId.has(record.id)) throw new Error(`Docs index store has a duplicate record id: ${record.id}`);
      byId.set(record.id, record);
      inputById.set(record.id, input);
    }
    offset += input.record_count;
  }

  const miniSearch = MiniSearch.loadJSON<DocsRecord>(json.indexJson, DOCS_INDEX_OPTIONS);
  if (miniSearch.documentCount !== records.length) {
    throw new Error(
      `Docs index has ${miniSearch.documentCount} documents but the store has ${records.length} records`,
    );
  }
  const missing = records.find((record) => !miniSearch.has(record.id));
  if (missing) throw new Error(`Docs index and store disagree on record ids: ${missing.id} is not in the index`);

  return {
    meta,
    records,
    get: (id) => byId.get(id),
    inputFor: (id) => inputById.get(id),
    search(query, limit = DEFAULT_LIMIT, filter) {
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
      const q = boundedQuery(query);
      const hits: DocsSearchHit[] = [];
      const results = filter
        ? miniSearch.search(q, {
            filter: (result) => {
              const record = byId.get(result.id as string);
              return record !== undefined && filter(record);
            },
          })
        : miniSearch.search(q);
      for (const result of results) {
        const record = byId.get(result.id as string);
        if (record) hits.push({ record, score: result.score });
      }
      return hits.slice(0, limit);
    },
  };
}
