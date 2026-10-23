import { DOCS_EVAL_LIMIT, type DocsEvalResult } from './run';

export interface DocsEvalReportContext {
  index: 'fixtures' | 'network'; // where the index was built from
  questionsPath: string; // as shown, e.g. 'eval/docs-questions.yaml'
}

/** The Markdown report; ends with exactly one '\n'. */
export function renderDocsEvalReport(result: DocsEvalResult, context: DocsEvalReportContext): string {
  const { metrics } = result;
  const missed = result.results.filter((r) => r.rank !== 1);
  const unknown = result.results.flatMap((r) => r.unknown_answers.map((url) => `- \`${r.id}\`: ${url}`));

  const missedLines = missed.flatMap((r, i) => [
    `${i + 1}. \`${r.id}\`, ${r.rank === null ? `not in top ${DOCS_EVAL_LIMIT}` : `rank ${r.rank}`}: ${r.question}`,
    `   - expected: ${r.answers.join(', ')}`,
    `   - top 3: ${r.top_urls.length === 0 ? 'none' : r.top_urls.slice(0, 3).join(', ')}`,
  ]);

  const blocks = [
    '## Docs search evaluation',
    [
      `- Questions: ${metrics.questions} from ${context.questionsPath}, each sent verbatim to docs_search with limit ${DOCS_EVAL_LIMIT}`,
      `- Index: ${context.index} build, ${result.record_count} records`,
    ].join('\n'),
    [
      '| Metric | Value |',
      '|---|---|',
      `| recall@1 | ${metrics.recall_at_1.toFixed(3)} (${metrics.found_at_1}/${metrics.questions}) |`,
      `| recall@5 | ${metrics.recall_at_5.toFixed(3)} (${metrics.found_at_5}/${metrics.questions}) |`,
      `| MRR@10 | ${metrics.mrr_at_10.toFixed(3)} |`,
    ].join('\n'),
    `### Not ranked first (${missed.length})`,
    missedLines.length === 0 ? 'None.' : missedLines.join('\n'),
    `### Answers not in the index (${unknown.length})`,
    unknown.length === 0 ? 'None.' : unknown.join('\n'),
  ];
  return `${blocks.join('\n\n')}\n`;
}
