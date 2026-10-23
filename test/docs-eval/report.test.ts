import { describe, expect, it } from 'vitest';
import { renderDocsEvalReport } from '../../scripts/docs-eval/report';
import type { DocsEvalResult } from '../../scripts/docs-eval/run';

const context = { index: 'fixtures', questionsPath: 'eval/docs-questions.yaml' } as const;

describe('renderDocsEvalReport', () => {
  it('lists every question not ranked first and every unknown answer', () => {
    const result: DocsEvalResult = {
      record_count: 5,
      metrics: { questions: 3, found_at_1: 1, found_at_5: 2, recall_at_1: 1 / 3, recall_at_5: 2 / 3, mrr_at_10: (1 + 1 / 3) / 3 },
      results: [
        { id: 'first', question: 'q1', answers: ['https://docs.test/a'], rank: 1, top_urls: ['https://docs.test/a'], unknown_answers: [] },
        {
          id: 'third',
          question: 'q2',
          answers: ['https://docs.test/c', 'https://docs.test/d'],
          rank: 3,
          top_urls: ['https://docs.test/a', 'https://docs.test/b', 'https://docs.test/c', 'https://docs.test/e'],
          unknown_answers: [],
        },
        { id: 'lost', question: 'q3', answers: ['https://docs.test/gone'], rank: null, top_urls: [], unknown_answers: ['https://docs.test/gone'] },
      ],
    };
    expect(renderDocsEvalReport(result, context)).toBe(
      [
        '## Docs search evaluation',
        '',
        '- Questions: 3 from eval/docs-questions.yaml, each sent verbatim to docs_search with limit 10',
        '- Index: fixtures build, 5 records',
        '',
        '| Metric | Value |',
        '|---|---|',
        '| recall@1 | 0.333 (1/3) |',
        '| recall@5 | 0.667 (2/3) |',
        '| MRR@10 | 0.444 |',
        '',
        '### Not ranked first (2)',
        '',
        '1. `third`, rank 3: q2',
        '   - expected: https://docs.test/c, https://docs.test/d',
        '   - top 3: https://docs.test/a, https://docs.test/b, https://docs.test/c',
        '2. `lost`, not in top 10: q3',
        '   - expected: https://docs.test/gone',
        '   - top 3: none',
        '',
        '### Answers not in the index (1)',
        '',
        '- `lost`: https://docs.test/gone',
        '',
      ].join('\n'),
    );
  });

  it('prints None. for empty sections', () => {
    const result: DocsEvalResult = {
      record_count: 1,
      metrics: { questions: 1, found_at_1: 1, found_at_5: 1, recall_at_1: 1, recall_at_5: 1, mrr_at_10: 1 },
      results: [{ id: 'first', question: 'q', answers: ['https://docs.test/a'], rank: 1, top_urls: ['https://docs.test/a'], unknown_answers: [] }],
    };
    const report = renderDocsEvalReport(result, { index: 'network', questionsPath: 'x.yaml' });
    expect(report).toContain('- Index: network build, 1 records');
    expect(report).toContain('### Not ranked first (0)\n\nNone.\n\n');
    expect(report.endsWith('### Answers not in the index (0)\n\nNone.\n')).toBe(true);
  });
});
