import { DocsSearchDataSchema, docsSearchCapability } from '../../src/core/docs/search';
import type { Deps } from '../../src/core/deps';
import { invokeCapability, type InvokeContext } from '../../src/core/invoke';
import type { DocsIndex } from '../../src/docs-index/load';
import { createMemoryCache } from '../../src/upstreams/cache';
import { createMemoryUsageSink } from '../../src/usage';
import type { DocsEvalSet } from './questions';

/** docs_search `limit` for every question; also the MRR cutoff. */
export const DOCS_EVAL_LIMIT = 10;

export interface DocsEvalQuestionResult {
  id: string;
  question: string;
  answers: string[];
  rank: number | null; // 1-based position of the first hit whose url is in answers; null when none of the hits is
  top_urls: string[]; // the hits' urls in rank order (at most DOCS_EVAL_LIMIT)
  unknown_answers: string[]; // answers that are no record's url in the index, in answers order
}

export interface DocsEvalMetrics {
  questions: number;
  found_at_1: number; // questions with rank === 1
  found_at_5: number; // questions with rank !== null && rank <= 5
  recall_at_1: number; // found_at_1 / questions, unrounded
  recall_at_5: number; // found_at_5 / questions, unrounded
  mrr_at_10: number; // mean of (rank === null ? 0 : 1 / rank), unrounded
}

export interface DocsEvalResult {
  record_count: number; // index.records.length
  metrics: DocsEvalMetrics;
  results: DocsEvalQuestionResult[]; // set order
}

/** Runs every question through docs_search over `index`. Throws Error if a call does not return ok. */
export async function runDocsEval(set: DocsEvalSet, index: DocsIndex): Promise<DocsEvalResult> {
  const capability = docsSearchCapability(() => index);
  const now = () => new Date();
  const deps: Deps = {
    fetch: () => Promise.reject(new Error('the docs eval makes no upstream calls')),
    cache: createMemoryCache(now),
    now,
    env: {},
  };
  const context: InvokeContext = { transport: 'rest', usage: createMemoryUsageSink() };
  const recordUrls = new Set(index.records.map((record) => record.url));

  const results: DocsEvalQuestionResult[] = [];
  for (const q of set.questions) {
    const result = await invokeCapability(capability, { query: q.question, limit: DOCS_EVAL_LIMIT }, deps, context);
    if (!result.ok) {
      throw new Error(`docs_search failed for "${q.id}": ${result.error.code}: ${result.error.message}`);
    }
    const data = DocsSearchDataSchema.parse(result.envelope.data);
    const topUrls = data.hits.map((hit) => hit.url);
    const position = topUrls.findIndex((url) => q.answers.includes(url));
    results.push({
      id: q.id,
      question: q.question,
      answers: q.answers,
      rank: position === -1 ? null : position + 1,
      top_urls: topUrls,
      unknown_answers: q.answers.filter((url) => !recordUrls.has(url)),
    });
  }

  const questions = results.length;
  const foundAt1 = results.filter((r) => r.rank === 1).length;
  const foundAt5 = results.filter((r) => r.rank !== null && r.rank <= 5).length;
  const reciprocalRanks = results.map((r) => (r.rank === null ? 0 : 1 / r.rank));
  return {
    record_count: index.records.length,
    metrics: {
      questions,
      found_at_1: foundAt1,
      found_at_5: foundAt5,
      recall_at_1: foundAt1 / questions,
      recall_at_5: foundAt5 / questions,
      mrr_at_10: reciprocalRanks.reduce((sum, value) => sum + value, 0) / questions,
    },
    results,
  };
}
