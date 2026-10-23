import { appendFile, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDocsIndex } from '../src/docs-index/load';
import { buildDocsIndex } from './docs-index/build';
import { parseDocsSourcesConfig } from './docs-index/config';
import { fixtureDocsFetch } from './docs-index/fixtures';
import { parseDocsEvalQuestions } from './docs-eval/questions';
import { renderDocsEvalReport } from './docs-eval/report';
import { runDocsEval } from './docs-eval/run';

const repoRoot = join(import.meta.dirname, '..');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      network: { type: 'boolean' }, // build the index from the live docs instead of test/fixtures/docs
      questions: { type: 'string', default: 'eval/docs-questions.yaml' },
      config: { type: 'string', default: 'docs-sources.yaml' },
    },
  });
  const resolve = (path: string) => (isAbsolute(path) ? path : join(repoRoot, path));
  const questionsPath = values.questions as string;

  const config = parseDocsSourcesConfig(await readFile(resolve(values.config as string), 'utf8'));
  const fetchFn = values.network
    ? (request: Request) => fetch(request)
    : fixtureDocsFetch(join(repoRoot, 'test', 'fixtures', 'docs'));
  const artifact = await buildDocsIndex(config, {
    fetch: fetchFn,
    now: () => new Date(),
    buildCommit: process.env.GITHUB_SHA ?? null,
  });
  const index = loadDocsIndex(artifact);

  const set = parseDocsEvalQuestions(await readFile(resolve(questionsPath), 'utf8'));
  const result = await runDocsEval(set, index);
  const report = renderDocsEvalReport(result, { index: values.network ? 'network' : 'fixtures', questionsPath });
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);

  const unknownAnswers = result.results.reduce((sum, r) => sum + r.unknown_answers.length, 0);
  if (unknownAnswers > 0) {
    console.error(`docs eval: ${unknownAnswers} answer URL(s) are not in the index; fix eval/docs-questions.yaml`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`docs eval failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
