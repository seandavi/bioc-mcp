import { describe, expect, it } from 'vitest';
import type { DocsEvalSet } from '../../scripts/docs-eval/questions';
import { runDocsEval } from '../../scripts/docs-eval/run';
import type { DocsRecord } from '../../src/docs-index/schema';
import { syntheticDocsIndex } from '../support/docs';

// Real index ids are '<source>:<path>' (site:…, repo:…); docs_search groups records into pages by them.
const record = (id: string, title: string, text: string): DocsRecord => ({
  id: `site:${id}`,
  url: `https://docs.test/${id}`,
  title,
  section: '',
  crumbs: [],
  text,
  source: 'site',
});

const index = syntheticDocsIndex([
  record('a', 'Alpha page', 'alpha only here'),
  record('b', 'Bravo page', 'bravo in the title'),
  record('c', 'Other page', 'bravo in the text only'),
]);

const set: DocsEvalSet = {
  questions: [
    { id: 'found-first', question: 'alpha', answers: ['https://docs.test/a'], from: 'test' },
    { id: 'found-second', question: 'bravo', answers: ['https://docs.test/c'], from: 'test' },
    { id: 'not-found', question: 'zulu', answers: ['https://docs.test/a'], from: 'test' },
    { id: 'unknown', question: 'alpha', answers: ['https://docs.test/missing', 'https://docs.test/a'], from: 'test' },
  ],
};

describe('runDocsEval', () => {
  it('ranks each question, lists top urls and unknown answers, and computes the metrics', async () => {
    const result = await runDocsEval(set, index);
    expect(result.record_count).toBe(3);
    expect(result.results.map((r) => [r.id, r.rank, r.top_urls, r.unknown_answers])).toEqual([
      ['found-first', 1, ['https://docs.test/a'], []],
      ['found-second', 2, ['https://docs.test/b', 'https://docs.test/c'], []],
      ['not-found', null, [], []],
      ['unknown', 1, ['https://docs.test/a'], ['https://docs.test/missing']],
    ]);
    expect(result.metrics).toEqual({
      questions: 4,
      found_at_1: 2,
      found_at_5: 3,
      recall_at_1: 0.5,
      recall_at_5: 0.75,
      mrr_at_10: 0.625,
    });
  });
});
