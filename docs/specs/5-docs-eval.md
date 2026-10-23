# Spec #5: Docs search evaluation set and recall@5 baseline

Issue: [seandavi/bioc-mcp#5](https://github.com/seandavi/bioc-mcp/issues/5). Builds on
[Spec #3](3-docs-index.md) (the index) and [Spec #4](4-docs-module.md) (`docs_search`). Project
design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Docs search": lexical first; try embeddings only if recall@5 on about 30 real questions falls
below about 80%). Conventions: [AGENTS.md](../../AGENTS.md).

Checked on 2026-10-22 against `main` at `41923d1`, with `npm ci` and `npm run docs:fixtures`
(418 records from 16 inputs) and throwaway scripts in `/tmp`, since deleted. **Verified** marks
what they showed:

- **Verified:** every answer URL in the question set below is the `url` of a record in the
  fixture-built index.
- **Verified:** each question in the set, sent verbatim as `query` with `limit: 10` through
  `invokeCapability(docsSearchCapability(() => index), …)` over the fixture index, gives the ranks
  in the [provisional baseline](#provisional-baseline): **recall@1 0.471 (16/34), recall@5 0.706
  (24/34), MRR@10 0.575.** That is below 0.8, so the follow-up issue in the acceptance criteria
  will be needed.
- **Verified:** `src/core/docs/search.ts`, `src/core/invoke.ts`, `src/docs-index/load.ts` and
  `scripts/docs-index/*` never import `src/docs-index/bundled.ts` (`invoke.ts` imports
  `./registry` with `import type` only). So a script that builds the index in memory with
  `buildDocsIndex` and runs `docs_search` does not need `generated/docs-index.js`, and
  `eval:docs` needs no `pre` hook.
- **Verified (zod 4.6.7, yaml 2.9.1, minisearch 7.2.0 as locked):** `z.strictObject` rejects
  unknown keys, `z.url({ protocol: /^https$/ })` rejects `http:` URLs, `.refine` on an array or
  object reports at its path, and `z.prettifyError` prints every issue with its path
  (`✖ answers must be unique\n  → at questions[1].answers`). In YAML, a plain scalar containing
  ` #` is cut at the comment (`from: operations.qmd runbook #rollback-dns` parses as
  `operations.qmd runbook`), so the set double-quotes every `question` and `from`.

No new npm package, capability, MCP tool, REST route, upstream or fixture.

## Goal

1. `eval/docs-questions.yaml`: 34 real questions about the Bioconductor infrastructure stack,
   each with the URL(s) of the docs section(s) that answer it and a note on where it came from.
   The sources are bioc-infrastructure issues #43, #67, #117 and #119, the `bioc-health` skill
   (its runbook list), the ADR titles, and the runbooks in `operations.qmd`.
2. `npm run eval:docs`: builds the docs index in memory (from `test/fixtures/docs/` by default,
   or the live docs with `--network`), sends every question verbatim to `docs_search` with
   `limit: 10`, and prints a Markdown report. The report gives recall@1, recall@5 and MRR@10 and
   lists every question not ranked first, with its expected and top URLs.
3. CI runs it after the tests and appends the report to the job summary. Scores never fail the
   step: the report is non-blocking. An invalid question set does fail it.
4. The PR records the baseline. If recall@5 is below 0.8, a follow-up issue compares query tweaks
   and field boosts first, then Cloudflare AI Search.

## Non-goals

- **No ranking change.** `DOCS_INDEX_OPTIONS`, `docs_search`, record splitting and the corpus stay
  as they are. Tuning belongs to the follow-up issue, measured on this set.
- **No query rewriting in the eval.** Questions go to `docs_search` exactly as written: the stop
  words and full sentences an agent or a person sends are part of what is measured. Keyword
  extraction is a "query tweak" for the follow-up.
- **No threshold test.** No Vitest test asserts a score, and no snapshot pins one. The blocking
  tests only check that the set is valid against the fixture index (see Test plan).
- **No eval in `deploy.yml`.** The daily network build is not evaluated. `--network` exists for a
  person comparing live docs with fixtures by hand.
- **No embeddings, Vectorize or AI Search.** That comes after the follow-up, if at all.
- **No JSON output or history file.** The report is Markdown on stdout and in the job summary.

## Design

### Files

```
eval/docs-questions.yaml          NEW: the question set (below)
scripts/eval-docs.ts              NEW: CLI (thin)
scripts/docs-eval/questions.ts    NEW: DocsEvalQuestionSchema, DocsEvalSetSchema, parseDocsEvalQuestions()
scripts/docs-eval/run.ts          NEW: runDocsEval(), DOCS_EVAL_LIMIT, result types
scripts/docs-eval/report.ts       NEW: renderDocsEvalReport()
test/docs-eval/questions.test.ts  NEW
test/docs-eval/run.test.ts        NEW
test/docs-eval/report.test.ts     NEW
package.json                      add the "eval:docs" script
.github/workflows/ci.yml          add the eval step
AGENTS.md                         Layout, Rules and Commands additions (below)
CONTRIBUTING.md                   one sentence in item 1 (below)
```

`scripts/docs-eval/` follows `scripts/docs-index/`: Node-only build-time code, never bundled,
importing from `src/` and `scripts/docs-index/` freely. `src/` never imports it. `tsconfig.json`
already includes `scripts` and `test`; `vitest.config.ts` already includes `test/**/*.test.ts`.

### `scripts/docs-eval/questions.ts`

```ts
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { DocsSearchInputSchema } from '../../src/core/docs/search';

export const DocsEvalQuestionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), // kebab-case, unique in the set
  question: DocsSearchInputSchema.shape.query, // sent verbatim as docs_search `query`
  answers: z
    .array(z.url({ protocol: /^https$/ })) // record URLs (docs_search hit.url); any one counts
    .min(1)
    .refine((answers) => new Set(answers).size === answers.length, 'answers must be unique'),
  from: z.string().min(1), // where the question came from: an issue, ADR, skill or runbook
});
export type DocsEvalQuestion = z.infer<typeof DocsEvalQuestionSchema>;

export const DocsEvalSetSchema = z
  .strictObject({ questions: z.array(DocsEvalQuestionSchema).min(1) })
  .refine((set) => new Set(set.questions.map((q) => q.id)).size === set.questions.length, 'question ids must be unique');
export type DocsEvalSet = z.infer<typeof DocsEvalSetSchema>;

/** YAML text → validated set. Throws Error(`docs-questions.yaml: ${z.prettifyError(…)}`). */
export function parseDocsEvalQuestions(yamlText: string): DocsEvalSet;
```

`parseDocsEvalQuestions` has the same shape as `parseDocsSourcesConfig` in
`scripts/docs-index/config.ts`. `DocsSearchInputSchema.shape.query` is `docs_search`'s own
constraint (1 to 256 characters, at least one non-space), so a question `docs_search` would reject
cannot enter the set. Answers are checked against an index by `runDocsEval` and by the questions
test, not by the schema, because the schema does not know the index.

### `scripts/docs-eval/run.ts`

```ts
import type { DocsIndex } from '../../src/docs-index/load';
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
export async function runDocsEval(set: DocsEvalSet, index: DocsIndex): Promise<DocsEvalResult>;
```

How it works:

- `const capability = docsSearchCapability(() => index)` (from `src/core/docs/search.ts`).
- One `Deps` for the run: `now = () => new Date()`,
  `{ fetch: () => Promise.reject(new Error('the docs eval makes no upstream calls')), cache: createMemoryCache(now), now, env: {} }`.
  One context: `{ transport: 'rest', usage: createMemoryUsageSink() }`.
- Questions run one at a time, in set order:
  `await invokeCapability(capability, { query: q.question, limit: DOCS_EVAL_LIMIT }, deps, context)`.
  When the result is not `ok`, it throws
  `` new Error(`docs_search failed for "${q.id}": ${result.error.code}: ${result.error.message}`) ``.
  Otherwise `top_urls` is `envelope.data.hits.map((hit) => hit.url)`. Going through
  `invokeCapability` measures what MCP and REST clients get, including input parsing and the
  size trimming (`omitted_for_size`).
- `unknown_answers` is `q.answers.filter((url) => !recordUrls.has(url))`, with
  `recordUrls = new Set(index.records.map((r) => r.url))`. The question is still scored, against
  whatever answers it has.
- The metrics are computed from `results` exactly as the field comments say.

**What "recall@k" means here.** A question counts as found at k when any of its answers is among
the first k hits. With several answers this is a hit rate, not the fraction of answers retrieved,
and it is the number the issue and the proposal mean by recall@5.

### `scripts/docs-eval/report.ts`

```ts
export interface DocsEvalReportContext {
  index: 'fixtures' | 'network'; // where the index was built from
  questionsPath: string; // as shown, e.g. 'eval/docs-questions.yaml'
}

/** The Markdown report; ends with exactly one '\n'. */
export function renderDocsEvalReport(result: DocsEvalResult, context: DocsEvalReportContext): string;
```

The exact format, here for a run with 34 questions where 16 rank first and 24 are in the top 5.
`<n>` is a count and `<f3>` is `value.toFixed(3)`:

```markdown
## Docs search evaluation

- Questions: 34 from eval/docs-questions.yaml, each sent verbatim to docs_search with limit 10
- Index: fixtures build, 418 records

| Metric | Value |
|---|---|
| recall@1 | 0.471 (16/34) |
| recall@5 | 0.706 (24/34) |
| MRR@10 | 0.575 |

### Not ranked first (18)

1. `runbook-failed-sync`, rank 2: bioc-sync.service is failing. How do I recover and re-upload what is missing from R2?
   - expected: https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
   - top 3: https://seandavi.github.io/bioc-infrastructure/dns-cutover.html#migration-plan, https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks, https://seandavi.github.io/bioc-infrastructure/how-it-works.html#serving
2. `runbook-purge`, rank 2: How do I purge a stale PACKAGES file from the edge cache?
   - expected: https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks, https://seandavi.github.io/bioc-infrastructure/cache.html#purging
   - top 3: https://seandavi.github.io/bioc-infrastructure/cache.html#query-strings-do-not-bust-the-cache, https://seandavi.github.io/bioc-infrastructure/cache.html#purging, https://seandavi.github.io/bioc-infrastructure/cache.html#is-this-page-cached
3. `runbook-rollback-worker`, not in top 10: How do I roll back the bioconductor.org Worker to the previous version?
   - expected: https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
   - top 3: https://seandavi.github.io/bioc-infrastructure/how-it-works.html#serving, https://seandavi.github.io/bioc-infrastructure/how-it-works.html#publishing, https://seandavi.github.io/bioc-infrastructure/adr/0007-cloudflare-workflows-for-the-release-roll-guard.html

### Answers not in the index (0)

None.
```

(Items 4 to 18 follow in the same shape. They are left out here.)

Rules:

- Header lines: `- Questions: <n> from <questionsPath>, each sent verbatim to docs_search with limit <DOCS_EVAL_LIMIT>`
  and `- Index: <index> build, <record_count> records`.
- Metric rows: `| recall@1 | <f3> (<found_at_1>/<questions>) |`,
  `| recall@5 | <f3> (<found_at_5>/<questions>) |`, `| MRR@10 | <f3> |`.
- "Not ranked first" lists every result with `rank !== 1`, in set order, numbered from 1. The
  rank text is `rank <rank>`, or `not in top 10` when `rank` is null (`10` is `DOCS_EVAL_LIMIT`).
  `expected:` joins every answer with `, `. `top 3:` joins `top_urls.slice(0, 3)` with `, `, or
  is `top 3: none` when there are no hits.
- "Answers not in the index" has one line per unknown answer, `` - `<id>`: <url> ``, in set
  order, then answers order. The count in the heading is the number of those lines.
- A section with no entries has the line `None.` under its heading.
- One blank line between blocks, as shown. No trailing spaces.

### `scripts/eval-docs.ts`

A thin CLI shaped like `scripts/build-docs-index.ts` (`parseArgs`, `repoRoot`, `main().catch`):

```ts
const { values } = parseArgs({
  options: {
    network: { type: 'boolean' }, // build the index from the live docs instead of test/fixtures/docs
    questions: { type: 'string', default: 'eval/docs-questions.yaml' },
    config: { type: 'string', default: 'docs-sources.yaml' },
  },
});
```

1. Resolve relative paths against `repoRoot`, as the build script does.
2. `config = parseDocsSourcesConfig(await readFile(config))`. `fetch` is
   `values.network ? (request) => fetch(request) : fixtureDocsFetch(join(repoRoot, 'test', 'fixtures', 'docs'))`.
3. `artifact = await buildDocsIndex(config, { fetch, now: () => new Date(), buildCommit: process.env.GITHUB_SHA ?? null })`,
   then `index = loadDocsIndex(artifact)` (the artifact has `storeJson` and `indexJson`).
   Nothing is written to `generated/`.
4. `set = parseDocsEvalQuestions(await readFile(questions))`, then `result = await runDocsEval(set, index)`.
5. `report = renderDocsEvalReport(result, { index: values.network ? 'network' : 'fixtures', questionsPath: <the --questions value as given> })`.
   Write it to stdout with `process.stdout.write(report)`. If `process.env.GITHUB_STEP_SUMMARY`
   is set, `appendFile` the report to that path.
6. Exit code: `1` when any result has `unknown_answers`, after printing the report, with
   `` console.error(`docs eval: ${n} answer URL(s) are not in the index; fix eval/docs-questions.yaml`) ``.
   Otherwise `0`, **whatever the scores**.
7. Any thrown error is printed as `` console.error(`docs eval failed: ${message}`) `` with exit code
   1, as in `build-docs-index.ts`.

### `package.json`

Add `"eval:docs": "tsx scripts/eval-docs.ts"`. Add no `preeval:docs` hook: the script does not
read `generated/` (see Verified).

### `.github/workflows/ci.yml`

After `- run: npm test`, add:

```yaml
      - name: Docs search evaluation (report only)
        run: npm run eval:docs
```

No `continue-on-error`: scores cannot fail the step (exit code rule 6), and an invalid set
already fails `npm test` (questions test). The PR's job summary shows the report.

### `AGENTS.md`

- Layout: add `eval/                 docs-questions.yaml: the docs search evaluation set (npm run eval:docs)`
  after the `docs-sources.yaml` line. Add
  `scripts/              … ; eval-docs.ts runs the docs evaluation` to the existing `scripts/` line.
- Rules, at the end of the "docs index is built" rule: "Re-recording can drop a section an eval
  question names; `test/docs-eval` then fails until `eval/docs-questions.yaml` is updated in the
  same PR."
- Rules, a new rule: "The docs evaluation (`eval/docs-questions.yaml`) holds real questions, each
  with every section URL that answers it on its own. Questions go to `docs_search` verbatim. Never
  reword a question or narrow its answers to improve a score. A ranking change reports
  `npm run eval:docs` before and after in its PR."
- Commands: "`npm run eval:docs`: recall@1, recall@5 and MRR@10 of `docs_search` on
  `eval/docs-questions.yaml`, over an index built in memory from `test/fixtures/docs/` (no
  network). Add `-- --network` to use the live docs. It fails only when an answer URL is not in
  the index; scores never fail it."

### `CONTRIBUTING.md`

In item 1, after "These become evaluation cases.", add: "The cases live in
[`eval/docs-questions.yaml`](eval/docs-questions.yaml); a PR adding a question with the URL of
the section that answers it is welcome too."

### `eval/docs-questions.yaml`

Committed exactly as below. Every question was written from its `from` source, not from search
results. One prototype run was then used to check the answer lists: it confirmed every URL is a
record, and it surfaced two sections whose text answers their question on its own, which were
added (`one-gate`: `propagation-gate.html#the-gate-check-by-check`; `scheduled-detectors`:
`operations.html#who-operates-what`). No question was reworded after the run.

Answer lists hold the specific section plus the ADR page record where the ADR's page record
carries the whole decision. Runbook questions all answer at `operations.html#runbooks`, because
Quarto's `search.json` splits that page only at `##`. The `bioc-health` skill's anchors
(`#failed-sync`, `#purge`, `#rollback-worker`, `#rollback-site`, `#yank`) are `###` headings
inside that one record.

```yaml
# Docs search evaluation set: real questions about the stack, each with every docs section that
# answers it on its own. `npm run eval:docs` sends each question verbatim to docs_search
# (limit 10) and reports recall@1, recall@5 and MRR@10. A question counts as found when any of
# its answers is among the hits. Answers are record URLs (docs_search hit.url); test/docs-eval
# checks that each one exists in the fixture index. Quote `question` and `from`: a " #" in a
# plain YAML string starts a comment.
questions:
  - id: runbook-failed-sync
    question: "bioc-sync.service is failing. How do I recover and re-upload what is missing from R2?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
    from: "bioc-health skill, runbook operations.html#failed-sync"
  - id: runbook-purge
    question: "How do I purge a stale PACKAGES file from the edge cache?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
      - https://seandavi.github.io/bioc-infrastructure/cache.html#purging
    from: "bioc-health skill, runbook operations.html#purge"
  - id: runbook-rollback-worker
    question: "How do I roll back the bioconductor.org Worker to the previous version?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
    from: "bioc-health skill, runbook operations.html#rollback-worker"
  - id: runbook-rollback-site
    question: "A bad site build is live. How do I pin bioconductor.org to an older build?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
    from: "bioc-health skill, runbook operations.html#rollback-site"
  - id: runbook-yank
    question: "How do I stop users downloading a bad package tarball before master removes it?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
    from: "bioc-health skill, runbook operations.html#yank"
  - id: runbook-rollback-dns
    question: "If Cloudflare itself fails, how do we send bioconductor.org traffic back to CloudFront?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#runbooks
      - https://seandavi.github.io/bioc-infrastructure/dns-cutover.html#migration-plan
    from: "operations.qmd runbook #rollback-dns"
  - id: who-is-alerted
    question: "Who notices when the hourly sync or the Logpush check fails, and how?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/operations.html#who-operates-what
      - https://seandavi.github.io/bioc-infrastructure/ci.html#scheduled-jobs-outside-github-actions
    from: "bioc-infrastructure#43 (detectors that alert nowhere)"
  - id: scheduled-detectors
    question: "Which timers run on onclappc02 and what does each one check?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/ci.html#scheduled-jobs-outside-github-actions
      - https://seandavi.github.io/bioc-infrastructure/operations.html#who-operates-what
    from: "bioc-infrastructure#43 (detectors and the ops checkouts)"
  - id: report-a-problem
    question: "Where do I report a broken page or a failed download on bioconductor.org?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/report.html#where-to-report
      - https://seandavi.github.io/bioc-infrastructure/report.html
    from: "bioc-infrastructure#43 (reporting and triage)"
  - id: report-triage
    question: "What happens to a problem report after it is filed? Who triages it?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/report.html#how-triage-works
    from: "bioc-infrastructure#43 (reporting and triage)"
  - id: is-page-cached
    question: "How can I tell whether a page came from the edge cache or is stale?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/cache.html#is-this-page-cached
    from: "bioc-infrastructure#43 (cache regressions found by hand)"
  - id: raw-client-addresses
    question: "Are client IP addresses stored raw in the access logs, or hashed at the edge?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0012-client-addresses-are-stored-raw-and-hashed-in-views.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0012-client-addresses-are-stored-raw-and-hashed-in-views.html#decision
    from: "ADR 0012 (supersedes ADR 0009); bioc-infrastructure#67 (bioc-traffic guards raw addresses)"
  - id: stats-static-files
    question: "Why are the download statistics static files rather than a live service?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0004-download-statistics-are-generated-static-files.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0004-download-statistics-are-generated-static-files.html#decision
    from: "ADR 0004"
  - id: logs-unfiltered
    question: "Why are the access logs mirrored unfiltered instead of dropping bots on ingest?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0002-mirror-access-logs-unfiltered.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0002-mirror-access-logs-unfiltered.html#decision
    from: "ADR 0002"
  - id: request-logging-destination
    question: "Where do the request logs go now that bioconductor.org is on Cloudflare?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0003-request-logging-after-the-cloudflare-cutover.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0003-request-logging-after-the-cloudflare-cutover.html#decision
      - https://seandavi.github.io/bioc-infrastructure/adr/0003-request-logging-after-the-cloudflare-cutover.html#amendment-2026-08-10-delivery-destination-moved-to-google-cloud-storage
    from: "ADR 0003"
  - id: old-releases-archival
    question: "Are old releases and their checkResults still synced and regenerated?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0006-old-releases-and-their-checkresults-are-archival.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0006-old-releases-and-their-checkresults-are-archival.html#decision
    from: "ADR 0006"
  - id: release-roll-approval
    question: "What makes a person approve the release roll before anything is deleted?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0007-cloudflare-workflows-for-the-release-roll-guard.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0007-cloudflare-workflows-for-the-release-roll-guard.html#decision
    from: "ADR 0007"
  - id: three-repos
    question: "Why is the new stack split across separate repositories?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0008-three-repos-and-a-strangler-migration.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0008-three-repos-and-a-strangler-migration.html#decision
    from: "ADR 0008; bioc-infrastructure#119"
  - id: manifest-not-registry
    question: "Why is the list of authorized packages called the manifest and not a registry?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0010-two-new-repos-for-the-build-system-and-the-manifest-name.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0010-two-new-repos-for-the-build-system-and-the-manifest-name.html#decision
    from: "ADR 0010; bioc-infrastructure#119 (bioc-manifest stays separate)"
  - id: one-gate
    question: "Do packages built by bioc-build go through the same propagation gate as r-universe builds?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0011-one-propagation-gate-for-every-producer.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0011-one-propagation-gate-for-every-producer.html#decision
      - https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#the-gate-check-by-check
    from: "ADR 0011"
  - id: redirect-policy
    question: "Should an old URL keep redirecting to a landing page that no longer has its content?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0013-redirects-land-on-content-or-they-go.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0013-redirects-land-on-content-or-they-go.html#decision
    from: "ADR 0013"
  - id: completeness-by-origin
    question: "How do we decide that a part of the site no longer depends on master?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0005-completeness-is-measured-by-origin-not-page-type.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0005-completeness-is-measured-by-origin-not-page-type.html#decision
    from: "ADR 0005"
  - id: publication-boundary
    question: "What must never be published on the public infrastructure docs site?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/adr/0001-public-docs-site-with-a-publication-boundary.html
      - https://seandavi.github.io/bioc-infrastructure/adr/0001-public-docs-site-with-a-publication-boundary.html#decision
    from: "ADR 0001"
  - id: who-generates-stats
    question: "Who generates the /packages/stats/ files now, and where are they served from?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/download-stats.html
      - https://seandavi.github.io/bioc-infrastructure/start-here.html#what-each-box-is
      - https://seandavi.github.io/bioc-infrastructure/how-it-works.html#serving
    from: "bioc-infrastructure#117 (stats generated by bioc-traffic, served from R2)"
  - id: empty-october-stats
    question: "Why did the package download stats stop counting after the cutover?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/download-stats.html
    from: "bioc-infrastructure#117 (follow-up to #114, the empty October)"
  - id: what-is-a-download
    question: "What counts as a download in the package statistics?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/download-stats.html#what-counts-as-a-download
    from: "bioc-infrastructure#67 (the fixed /packages/stats definition)"
  - id: stats-agree
    question: "Do bioc-traffic's download counts match the numbers published at /packages/stats/?"
    answers:
      - https://github.com/seandavi/bioc-traffic/blob/main/docs/published-comparison.md
      - https://seandavi.github.io/bioc-infrastructure/download-stats.html#do-the-two-systems-agree
    from: "bioc-infrastructure#117 (generator output sanity)"
  - id: humans-vs-bots
    question: "How are human downloads told apart from bots, mirrors and CI?"
    answers:
      - https://github.com/seandavi/bioc-traffic/blob/main/README.md#not-all-traffic-is-people
      - https://seandavi.github.io/bioc-infrastructure/improvements.html#download-statistics-that-can-tell-people-from-bots
    from: "bioc-infrastructure#67 (interpreted usage by traffic class)"
  - id: propagated-commit
    question: "Which version of edgeR propagated, and from which commit?"
    answers:
      - https://github.com/seandavi/bioc-registry/blob/main/README.md#try-it-in-30-seconds
      - https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#index-entry-shape
      - https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#get-pkguniversepackage
    from: "bioc-infrastructure#67 (registry example questions)"
  - id: registry-sql
    question: "Can I query a package's check history across observations with SQL?"
    answers:
      - https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#get-sql
    from: "bioc-infrastructure#67 (the lake: Parquet that DuckDB reads)"
  - id: intelligence-sources
    question: "Where do bioc-intelligence's citation and grant numbers come from?"
    answers:
      - https://github.com/seandavi/bioc-intelligence/blob/main/README.md#data-sources
    from: "bioc-infrastructure#67 (bioc-intelligence produces citations, grants, impact)"
  - id: add-to-manifest
    question: "How do I authorize a new package for bioc-build?"
    answers:
      - https://github.com/seandavi/bioc-manifest/blob/main/README.md#adding-a-package
      - https://github.com/seandavi/bioc-manifest/blob/main/README.md
    from: "bioc-infrastructure#119 (bioc-manifest is the trust root)"
  - id: registry-polls
    question: "Why does the registry poll r-universe instead of waiting for webhooks?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls
    from: "proposal-mcp.qmd (docs search example question)"
  - id: install-from-new-stack
    question: "Is my BiocManager install coming from the new Cloudflare stack?"
    answers:
      - https://seandavi.github.io/bioc-infrastructure/install.html#is-my-install-coming-from-the-new-stack
    from: "install.qmd; bioc-infrastructure#43 (package or install problem form)"
```

### Provisional baseline

From the prototype run (fixture index, 418 records). The implementer reruns it with
`npm run eval:docs` and reports that output in the PR. A different number is a finding to explain
there, not something to fix silently.

| Rank | Questions |
|---|---|
| 1 (16) | runbook-rollback-dns, who-is-alerted, report-triage, is-page-cached, stats-static-files, logs-unfiltered, request-logging-destination, old-releases-archival, release-roll-approval, three-repos, manifest-not-registry, redirect-policy, publication-boundary, what-is-a-download, registry-polls, install-from-new-stack |
| 2–5 (8) | runbook-failed-sync 2, runbook-purge 2, one-gate 2, stats-agree 2, humans-vs-bots 2, raw-client-addresses 3, scheduled-detectors 4, empty-october-stats 4 |
| 6–10 (2) | who-generates-stats 9, propagated-commit 9 |
| not in top 10 (8) | runbook-rollback-worker, runbook-rollback-site, runbook-yank, report-a-problem, completeness-by-origin, registry-sql, intelligence-sources, add-to-manifest |

recall@1 0.471, recall@5 0.706, MRR@10 0.575. Patterns visible in the misses, as input to the
follow-up (not acted on here):

- Long records rank on stop words. `astro-site-build.html#the-2026-08-04-build-record`,
  `dns-cutover.html#migration-plan` and `proposal-unified-search.html#invariants` sit in the top 10
  of many unrelated questions. Prefix and fuzzy matching on short words such as "the", "how" and
  "do" add to this.
- The runbooks share one long record. Four runbook questions miss or rank 2 against short records
  that only mention the same words.
- `raw-client-addresses` ranks the superseded ADR 0009 above ADR 0012. Nothing in the ranking
  knows an ADR's status.

## Acceptance criteria

- [ ] `eval/docs-questions.yaml` matches the YAML in this spec: 34 questions, every `question` and
      `from` double-quoted, and the header comment.
- [ ] `parseDocsEvalQuestions` accepts the committed file and throws an `Error` whose message
      starts `docs-questions.yaml: ` for each of: a duplicate `id`, an `http:` answer, an empty
      `answers`, a repeated answer within one question, an unknown key, a `question` of 257
      characters, and a whitespace-only `question`.
- [ ] Every answer URL in the committed file is the `url` of a record in `fixtureDocsIndex()`
      (test/docs-eval/questions.test.ts).
- [ ] `runDocsEval` on a synthetic index returns the ranks, `top_urls`, `unknown_answers` and
      metrics given in the Test plan, exactly.
- [ ] `renderDocsEvalReport` output matches the format above exactly for the Test plan's
      hand-built result, including `not in top 10`, `top 3: none` and both `None.` cases.
- [ ] `npm run eval:docs` prints the report and exits 0 on a clean clone after `npm ci`, without
      network access and without `generated/` existing. It leaves `generated/` absent if it was
      absent.
- [ ] With an answer URL edited to a non-existent anchor (a local, uncommitted edit), `npm run eval:docs`
      prints the report with that URL under "Answers not in the index (1)" and exits 1.
- [ ] With `GITHUB_STEP_SUMMARY=/tmp/summary.md`, the report is appended to that file as well as
      printed.
- [ ] `.github/workflows/ci.yml` runs `npm run eval:docs` after `npm test`. The PR's CI job
      summary shows the report.
- [ ] `npm run typecheck` and `npm test` pass. No existing test changes.
- [ ] AGENTS.md (Layout, the two Rules, Commands) and CONTRIBUTING.md (item 1) say what this spec
      lists.
- [ ] The PR description gives the baseline from `npm run eval:docs` (fixtures): recall@1,
      recall@5, MRR@10 and the list of questions not ranked first. It also gives the
      `npm run eval:docs -- --network` result from the same day, or says why it was not run.
- [ ] If the fixture recall@5 is below 0.8, a follow-up issue is opened on seandavi/bioc-mcp,
      labelled `module:docs`, and linked from the PR. Title: "Docs search: raise recall@5 on the
      eval set (query tweaks and field boosts, then AI Search)". It records the baseline and the
      misses, the patterns above, and the order the issue asks for: query tweaks and field boosts
      first, measured with `npm run eval:docs`, then Cloudflare AI Search on the same set if
      lexical tuning does not reach about 0.8.

## Test plan

All tests run in Node with the network disabled (`test/setup.ts`). They import from `scripts/`
and `src/` and never read `generated/`.

**`test/docs-eval/questions.test.ts`**

- Reads `eval/docs-questions.yaml` (path from `import.meta.dirname`), parses it, and expects
  `questions.length >= 30` and unique ids.
- Builds `recordUrls` from `await fixtureDocsIndex()` (`test/support/docs.ts`). It expects the
  list of `` `${id}: ${url}` `` for answers not in `recordUrls` to equal `[]`, so a failure names
  every stale answer at once.
- One case per rejection in the acceptance criteria, each starting from a valid one-question YAML
  string and changing one thing. Each expects `toThrow(/^docs-questions\.yaml: /)`.

**`test/docs-eval/run.test.ts`** over `syntheticDocsIndex` (`test/support/docs.ts`), with records
on `https://docs.test/…`:

| record id / url | title | section | text |
|---|---|---|---|
| `a` / `https://docs.test/a` | Alpha page | | `alpha only here` |
| `b` / `https://docs.test/b` | Bravo page | | `bravo in the title` |
| `c` / `https://docs.test/c` | Other page | | `bravo in the text only` |

(`crumbs: []`, `source: 'site'`, no `repo`.) The set:

| id | question | answers | expected rank | expected unknown_answers |
|---|---|---|---|---|
| `found-first` | `alpha` | `[…/a]` | 1 | `[]` |
| `found-second` | `bravo` | `[…/c]` | 2 (title boost puts `b` first) | `[]` |
| `not-found` | `zulu` | `[…/a]` | null, `top_urls` `[]` | `[]` |
| `unknown` | `alpha` | `[…/missing, …/a]` | 1 | `[https://docs.test/missing]` |

Expected metrics: `questions 4, found_at_1 2, found_at_5 3, recall_at_1 0.5, recall_at_5 0.75,
mrr_at_10 (1 + 0.5 + 0 + 1) / 4 = 0.625`, and `record_count 3`. **Verified:** over these three
records, `index.search` gives `alpha` → `[a]`, `bravo` → `[b, c]` and `zulu` → `[]`.

**`test/docs-eval/report.test.ts`**

- A hand-built `DocsEvalResult` (no index): three results with rank 1, rank 3, and `null` with no
  hits, plus one unknown answer. Expects the exact full string, including `rank 3`,
  `not in top 10`, `top 3: none`, `Answers not in the index (1)` and the metric rows with
  `toFixed(3)`.
- An all-rank-1 result with no unknown answers. Expects `### Not ranked first (0)\n\nNone.` and
  `### Answers not in the index (0)\n\nNone.\n` at the end.

**By hand:** the CLI acceptance items (clean clone, the unknown-answer exit code,
`GITHUB_STEP_SUMMARY`) and `npm run eval:docs -- --network` for the PR.

## Risks

- **The set measures what its author thought to ask.** The questions and their answers were
  picked while reading the corpus, so the phrasing may lean toward the docs' own words. Paraphrasing and
  the `from` note limit this. The AGENTS.md rule (never reword a question or narrow its answers to
  improve a score) keeps the set from drifting toward the index. New cases from "wrong answer"
  issues (CONTRIBUTING.md) are the long-term fix.
- **Fixture drift.** The baseline is over fixtures recorded on 2026-10-22. The live docs move
  daily, so live numbers drift from the PR's baseline. `--network` measures that. Re-recording
  fixtures can remove a section an answer names. The questions test then fails, and AGENTS.md
  says to fix the set in the same PR.
- **Coarse records cap precision.** Answers are whole records. The runbooks are one record, and
  ADR page records duplicate their sections, so several questions accept two or three URLs. A
  record split change (for example at `###`) changes URLs and needs the answer lists updated.
- **Small n.** With 34 questions, one question moves recall by about 0.03, so a 0.8 threshold
  is a guide, not a precise test. The follow-up should compare per-question ranks, which the
  report lists, not only the totals.
- **Verbatim questions are a choice.** An agent may send keywords rather than full sentences, and
  would then score higher than this set suggests. That is deliberate: it is the harder case, and
  the follow-up's query tweaks measure how far keyword handling closes the gap.
