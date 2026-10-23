# Spec #79: follow-ups for pkg, upstreams, ops and README (from the #10, #38, #43, #44, #46, #50, #52 and #74 reviews)

Issue: [seandavi/bioc-mcp#79](https://github.com/seandavi/bioc-mcp/issues/79). Source issues:
[#39](https://github.com/seandavi/bioc-mcp/issues/39) (review of #38, README and CONTRIBUTING),
[#47](https://github.com/seandavi/bioc-mcp/issues/47) (#43, upstream HTTP),
[#57](https://github.com/seandavi/bioc-mcp/issues/57) (#44, pkg follow-ups),
[#64](https://github.com/seandavi/bioc-mcp/issues/64) (#46, ops and deploy),
[#66](https://github.com/seandavi/bioc-mcp/issues/66) (#10, triage prompt),
[#70](https://github.com/seandavi/bioc-mcp/issues/70) (#50, repo diff),
[#72](https://github.com/seandavi/bioc-mcp/issues/72) (#52, revdeps and missing deps),
[#75](https://github.com/seandavi/bioc-mcp/issues/75) (#74, PACKAGES reader). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

Scope, from #79: `src/core/pkg/*`, `src/upstreams/*`, `src/core/ops/*`, their tests and specs, and
the README.md and CONTRIBUTING.md items. Out of bounds: `src/core/docs/*`, `src/docs-index/*`,
`scripts/docs-index/*`, `scripts/docs-eval/*` (the docs bundle owns them).

What the following notes record was checked on 2026-10-22 against `main` at d4c18f2 (zod 4.6.7,
vitest 5.0.5, Node 26.8.1 locally). Throwaway probe tests were run and deleted. **Verified**
marks what was observed.

- **Verified (already fixed on main):**
  - README.md:47 already reads "How many downloads, and from how many distinct IPs, did this
    package get each month of a year?" (#39 code-r0-2).
  - README.md:45 reads "What image, repositories and dependency versions did a build job use?",
    and First questions bullet README.md:152 reads "What image and dependency versions did that
    check run with?". Both match `PkgBuildEnvironmentDataSchema` (#39 ux-r0-3).
  - `docs_search` is live and listed under "What is live today" (README.md:52) (#39 ux-r0-7).
  - AGENTS.md:135-137 states the prompt registration dependency. Spec 10's acceptance line
    (docs/specs/10-triage-prompt.md:285-287) says pkg/ops test apps register `docsTestModule`. The
    body of PR #67 (Closes #10) says it too (#66 ux-r0-1).
  - `PACKAGES_FIELD` is `/^([^\s:]+):(.*)$/s` in `src/upstreams/packages-file.ts:14`. #74 removed
    the backtracking, and `test/upstreams/packages-file.test.ts:169` times a 200,000-space line
    before a lone `\r` (#70 security-r0-1).
  - docs/specs/52-revdeps.md step 1 (lines 120-131) and step 4 (lines 143-145) describe
    `SharedLoads`. The `getPackageList` doc comment (lines 108-111) has the "Concurrent callers …
    share one load (SharedLoads)" sentence. No "Only settled successes are stored" text is left
    (#72 security-r1-1).
- **Verified (ellmer source, tags v0.4.2 and main):** `chat_google_gemini()` reads
  `GOOGLE_API_KEY`, then `GEMINI_API_KEY` (`default_google_credentials`, R/provider-google.R). It
  then falls back to gargle and other credentials.
- **Verified (probe on the fixtures):** `closeMatches('biocset', Object.keys(index.packages))` on
  `registry/prop/bioc/index-deps.json` returns `[]`. With the index names plus
  `graph.dependents.keys()` it returns `['BiocSet']`. `BiocSett` behaves the same way. `Rcpp` has 7
  dependents and is not in the index.
- **Verified (probe, `ops_activity kind=prs`, 10 hostile bioc-mcp PRs, 100 failing checks each):**

  | Titles / check names | today, all repos | today, `repo=bioc-mcp` | byte-bounded, all repos | byte-bounded, `repo=bioc-mcp` |
  |---|---|---|---|---|
  | `'T'×200` / `` `${i}-${'c'×200}` `` | 7,156 B | 5,648 B | 7,156 B | 5,648 B |
  | `'日'×200` / `` `${i}-${'\u0001'×200}` `` | `result_too_large` | `result_too_large` | 7,116 B | 5,608 B |
  | `'a'+'😀'×200` / `` `${i}-${'é'×200}` `` | `result_too_large` | 7,538 B | 7,106 B | 5,598 B |

  "Byte-bounded" is the `truncateText` defined below. ASCII output is byte-identical.
- **Verified (live):** `GET https://bioc-mcp.seandavi.workers.dev/api/v1/pkg/revdeps?package=S4Vectors&depth=1`
  answers 200 with 876 direct dependents. `GET …/api/v1/pkg/missing_deps` answers 200.

## Goal

Settle every item in #79's scope in one PR: fix it, or mark it **moot** (already resolved) or
**declined** (with a reason). The PR body repeats this table, says `Closes #79`, and says that
#39, #47, #57, #64, #66, #70, #72 and #75 can be closed when it merges.

| Source | Id | Outcome | What changes |
|---|---|---|---|
| #39 | code-r0-2 | moot | README.md:47 already has the month/distinct-IP wording |
| #39 | ux-r0-3 | moot | README.md:45 and :152 already name the image and dependency versions |
| #39 | ux-r0-4 | fixed | README intro, `ops_activity` row and First question say "the seandavi/bioc-* infrastructure repos" |
| #39 | code-r0-3 | fixed | README "Connect": "Each client below says whether it was tested against the live server, and when." |
| #39 | code-r0-4 | fixed | CONTRIBUTING drops "Human contributors never need the factory." |
| #39 | ux-r0-6 | fixed | ellmer snippet comment names `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| #39 | ux-r0-7 | moot | `docs_search` is live (README.md:52) |
| #47 | security-r0-1 | fixed (comments and spec) | `readCapped` and `Upstream.maxBytes` comments and spec 43's Risks bullet state a peak of about 2× `maxBytes` plus the parsed JSON |
| #57 | code-r0-2 | fixed (spec) | Spec 8's year `not_found` template uses `yearRanges(years)`; spec 44's "Leave the rest" bullet notes it |
| #57 | code-r0-3 (+ ux-r0-1) | fixed | `pkg_check_output` summary: separate sentences for cut sections and omitted steps; `truncated` description names `offset` |
| #57 | code-r0-4 | fixed | rnaseqGene downloads test asserts `sources` in full |
| #57 | code-r0-5 (+ ux-r0-2, code-r1-1) | fixed | `chooseYear`'s JSDoc moves below `yearRanges` |
| #57 | ux-r0-4 | fixed | `agree` description adds "(a symlink missing from the index is not checked)" (code and spec 8) |
| #64 | code-r0-2 | fixed | imports guard matches whole `import`/`export … from '../core/…'` statements across lines; tested on a wrapped import |
| #64 | code-r0-3 | fixed (spec) | Spec 46's hostile-PR dates corrected |
| #64 | code-r0-4 | fixed (spec) | Spec 11's Files entry and test-plan row name `rateLimitKey` |
| #64 | security-r0-1 | fixed (the "better fix") | `truncateText` bounds PR titles and check names by JSON UTF-8 bytes on whole code points; `jsonTextBytes` moves to `src/envelope.ts`; spec 9 corrected |
| #66 | code-r0-2 | fixed | Triage walk calls `pkg_status` with `universe: 'bioc'` (test and spec 10) |
| #66 | code-r0-3 | fixed | No `await` on `makeTestApp`; local `Job.url` is `string \| null` |
| #66 | ux-r0-1 | moot | AGENTS.md, spec 10 and the PR #67 body already state the pkg→docs dependency |
| #70 | code-r0-1 | fixed | repo-diff scale-test comment matches `i < 2400` |
| #70 | security-r0-1 | moot | #74 made `PACKAGES_FIELD` linear and added the timing test |
| #72 | code-r0-2 | fixed | Four revdeps tests assert `sources` and `fetch.calls` |
| #72 | code-r0-3 | fixed | `bioconductorUpstream.description` lists the repositories read; spec 52 notes it |
| #72 | code-r0-4 | fixed | `codeUnitOrder` and `DEPS_UNKNOWN_LISTED` exported once from dependency-graph.ts |
| #72 | code-r0-5 | fixed | paging test uses cases that differ between UTF-8 and UTF-16 |
| #72 | ux-r0-1 | fixed | `pkg_revdeps` description and not-in-index summary clause mention CRAN/base R and `pkg_missing_deps` |
| #72 | ux-r0-2 | fixed | `pkg_revdeps` not_found suggestions include names that only have dependents (`biocset` → `BiocSet`) |
| #72 | ux-r0-3 | fixed | README First questions gain the revdeps and missing-deps questions; REST quickstart gains a revdeps call |
| #72 | ux-r0-4 | fixed | README `pkg_missing_deps` row reworded |
| #72 | ux-r0-5 | fixed | `pkg_missing_deps` description: "likely cannot be installed from the registry's repositories" |
| #72 | code-r1-2 | fixed (spec) | Spec 52 Files table gains `src/upstreams/registry.ts`; spec 6 step 2 points to shared-load.ts |
| #72 | security-r1-1 | moot | Spec 52 already describes `SharedLoads` (see Verified) |
| #75 | code-r0-1 | fixed | Two Path-stanza tests for a known name with an invalid repeat |
| #75 | code-r0-2 | fixed (spec) | Spec 74 criterion 5 matches its test plan |
| #75 | code-r0-3 | fixed | `getPackagesFile`'s empty-check comment is generic and drops "truncated" |

Nothing is declined.

## Non-goals

- No new capability, module, upstream, REST route, MCP tool, prompt or resource. No recorded
  fixture: every new test uses existing fixtures or inline bodies.
- No change to input schemas. Output *shapes* do not change. Only descriptions, summary text,
  error text and the length of cut `ops_activity` titles and check names change, and those only
  for non-ASCII or escaped text.
- `readCapped` and the per-upstream `maxBytes` values do not change (#47 says "correct the claim,
  not the code").
- No change to `src/core/docs/*`, `src/docs-index/*`, `scripts/docs-index/*`,
  `scripts/docs-eval/*`, or to any docs fixture. `test/fixtures/docs/…/bioc-mcp/main/README.md`
  is a recorded docs input. It is not re-recorded, so the docs index and the eval do not move.
- Specs are corrected only where a finding names them, or where this PR changes text a spec
  quotes (listed under each item). Specs are not rewritten.
- `pathSegment`, `fetchUpstream`, the transports and `src/index.ts` do not change.

## Design

There are no new upstream calls and no fixtures to record. MCP tool names, REST routes and
input/output schemas stay as they are, except for the description strings listed here:

| Tool | REST route | Change |
|---|---|---|
| `pkg_check_output` | `GET /api/v1/pkg/check_output` | `check.sections[].truncated` description; summary sentences |
| `pkg_release_info` | `GET /api/v1/pkg/release_info` | `agree` description |
| `pkg_revdeps` | `GET /api/v1/pkg/revdeps` | tool description; not-in-index summary clause; not_found suggestions |
| `pkg_missing_deps` | `GET /api/v1/pkg/missing_deps` | tool description |
| `ops_activity` | `GET /api/v1/ops/activity` | `title` and `failing_checks` descriptions; cut length of non-ASCII titles and check names |

`pkg_downloads`, `pkg_status` and `pkg_build_environment` change in tests only.

### Files

```
src/envelope.ts                      + jsonTextBytes() (moved from src/core/pkg/check-log.ts)
src/core/pkg/check-log.ts            imports jsonTextBytes from ../../envelope; local encoder and function removed
src/core/pkg/check-output.ts         truncated description; summarize(): cut and omitted sentences
src/core/pkg/downloads.ts            chooseYear JSDoc moved
src/core/pkg/release-info.ts         agree description
src/core/pkg/dependency-graph.ts     export codeUnitOrder, DEPS_UNKNOWN_LISTED
src/core/pkg/revdeps.ts              imports both; description; summary clause; not_found candidates
src/core/pkg/missing-deps.ts         imports both; description
src/core/ops/rules.ts                truncateText() by JSON bytes on code points; TITLE_LIMIT comment
src/core/ops/config.ts               CHECK_NAME_LIMIT comment
src/core/ops/activity.ts             title and failing_checks descriptions
src/upstreams/http.ts                Upstream.maxBytes comment; readCapped doc comment
src/upstreams/bioconductor.ts        bioconductorUpstream.description
src/upstreams/packages-file.ts       getPackagesFile empty-check comment
test/upstreams/imports.test.ts       coreStatements(); multi-line and re-export cases
test/upstreams/packages-file.test.ts two Path-stanza cases
test/core/pkg/check-log.test.ts      jsonTextBytes import; budget-0 offsets
test/core/pkg/check-output.test.ts   jsonTextBytes import; summary sentences; new short-sections test; truncated description
test/core/pkg/downloads.test.ts      rnaseqGene sources
test/core/pkg/release-info.test.ts   agree description clause
test/core/pkg/revdeps.test.ts        sources and fetch.calls in four tests; BiocSet summary; biocset suggestion
test/core/pkg/missing-deps.test.ts   description clause
test/core/pkg/paging.test.ts         UTF-8 vs UTF-16 cases
test/core/pkg/repo-diff.test.ts      comment
test/core/ops/rules.test.ts          truncateText / truncateTitle byte cases
test/core/ops/activity.test.ts       hostileRoutes(count, title, checkName?); non-ASCII hostile test
test/transports/triage.test.ts       universe 'bioc'; no await; Job.url
README.md                            #39 ux-r0-4, code-r0-3, ux-r0-6; #72 ux-r0-3, ux-r0-4
CONTRIBUTING.md                      #39 code-r0-4
docs/specs/6-pkg-status.md           step 2 note (#72 code-r1-2)
docs/specs/8-pkg-release-info.md     year template (#57 code-r0-2); agree snippet (#57 ux-r0-4)
docs/specs/9-ops-activity.md         8 KB paragraph, parity row, title/failing_checks snippets, CHECK_NAME_LIMIT and truncateText interfaces (#64 security-r0-1)
docs/specs/10-triage-prompt.md       pkg_status calls (#66 code-r0-2)
docs/specs/11-deploy.md              Files entry, test-plan row (#64 code-r0-4)
docs/specs/43-followups-upstream.md  Risks bullet (#47)
docs/specs/44-followups-pkg.md       "Leave the rest" bullet (#57 code-r0-2); summary text and truncated snippet (#57 code-r0-3)
docs/specs/46-followups-ops-deploy.md imports-guard regex (#64 code-r0-2); hostile dates (#64 code-r0-3)
docs/specs/52-revdeps.md             Files table, bioconductor.ts note, not_found, summary, descriptions (#72)
docs/specs/74-packages-reader.md     criterion 5 (#75 code-r0-2)
```

Import zod as `import * as z from 'zod'`, as the files already do. No dependency changes.

### #39: README.md and CONTRIBUTING.md

**ux-r0-4.** Three places in README.md:

- Intro (line 10): "see what is happening across the `bioc-*` repos" → "see what is happening
  across the seandavi/bioc-* infrastructure repos".
- Tool table, `ops_activity` row (line 51): "What is open, failing or stale across the
  seandavi/bioc-* infrastructure repos?"
- First questions (line 156): `- "Which workflows in the seandavi/bioc-* infrastructure repos are failing right now?" (\`ops_activity\`)`.

**code-r0-3.** README.md:63 becomes: "Run the `export` above first. Each client below says whether
it was tested against the live server, and when."

**ux-r0-6.** README.md:121 becomes:

```r
chat <- ellmer::chat_google_gemini()   # any ellmer chat_*() works; chat_google_gemini() reads GEMINI_API_KEY (or GOOGLE_API_KEY)
```

**code-r0-4.** CONTRIBUTING.md:59: delete the sentence "Human contributors never need the
factory." The paragraph ends with "(`gh issue list -l needs:human`)."

### #72 README items

**ux-r0-4.** The `pkg_missing_deps` row (README.md:50) "Answers" cell becomes: "Which published
packages have a hard dependency that is in none of the propagation index, base R, CRAN or the
Bioconductor data repositories?"

**ux-r0-3.** In "First questions to ask", after the `pkg_repo_diff` bullet, add:

```
- "If S4Vectors fails today, what is blocked downstream?" (`pkg_revdeps`)
- "Which packages depend on something that cannot be installed?" (`pkg_missing_deps`)
```

These are the #52 tester's questions, verbatim. In "REST quickstart", after the `pkg/status`
line, add:

```sh
curl -s "$BIOC_MCP/api/v1/pkg/revdeps?package=S4Vectors&depth=1"
```

### #47: `src/upstreams/http.ts` and spec 43

The code does not change. Comments only:

```ts
maxBytes?: number; // positive integer; decoded body bytes read before failing; default DEFAULT_MAX_BYTES. Peak memory per read is about 2x this plus the parsed JSON (see readCapped)
```

`readCapped`'s doc comment becomes:

```ts
/**
 * The body as UTF-8 text, like response.text(), or null once more than maxBytes have arrived. The
 * count is of decoded bytes (after Content-Encoding). Past the cap the stream is cancelled, so its
 * connection is released and nothing more is buffered. Read errors (including the timeout)
 * propagate to the caller.
 *
 * Memory: the decoded chunks in `parts` and the joined string coexist until join returns, and the
 * count is checked after a chunk arrives, so one read peaks at about 2 × maxBytes plus one chunk
 * (for ASCII bodies; V8 holds text outside Latin-1 at 2 bytes per character).
 * fetchUpstreamJson then holds the parsed value while the body string is still referenced.
 * Choose per-upstream caps on that basis: the 16 MiB registry and CRAN caps allow about 32 MB of
 * strings per uncached read on a 128 MB isolate.
 */
```

docs/specs/43-followups-upstream.md, Risks, the "Decoded size, not wire size" bullet becomes:

```
- **Decoded size, not wire size.** The count is of decoded bytes, so a small gzip body that
  inflates is caught. No `Content-Length` pre-check: a large uncompressed body is streamed up to
  the cap before failing. Memory is not bounded by `maxBytes`. `readCapped` keeps every decoded
  chunk and then joins them, so the chunks and the joined string coexist. The count is checked
  after a chunk arrives. One read therefore peaks at about 2 × `maxBytes` plus one chunk (ASCII;
  more for text V8 stores at 2 bytes per character). `fetchUpstreamJson` then adds the parsed
  object while the body string is alive. For the registry's 16 MiB cap, one `/checks` read can
  peak near 32 MB of strings before parsing, and `/checks` loads are not shared like the index
  (`SharedLoads`), so a few concurrent callers approach the 128 MB isolate limit. Pick
  per-upstream caps on this basis (#47).
```

### #57: pkg follow-ups

**code-r0-3 (+ ux-r0-1): `pkg_check_output` summary and `truncated`.** In `check-output.ts`:

```ts
truncated: z
  .boolean()
  .describe(
    'true if lines were cut to fit the size limit; the marker in text, or offset when text is empty, gives where to read them with full=true',
  ),
```

In `summarize`, replace the single `some(s => s.truncated) || sections_omitted > 0` sentence with
two independent sentences, in this order:

```ts
if (check.sections.some((s) => s.truncated)) {
  sentences.push(
    "Some output was cut to fit; each cut section's marker, or its offset when its text is empty, gives where to read it with full=true.",
  );
}
if (check.sections_omitted > 0) {
  const n = check.sections_omitted;
  sentences.push(
    `${n} more ${n === 1 ? 'step was' : 'steps were'} left out (beyond the ${MAX_SECTIONS} most severe); page the whole log with full=true.`,
  );
}
```

`MAX_SECTIONS` is already imported. docs/specs/44-followups-pkg.md: in the `check-output.ts`
section, replace the `truncated` snippet's description with the new text. Replace the paragraph
"In `summarize`, the sentence … becomes `Some output was cut to fit; each cut section's marker
gives the offset to read it with full=true.`" with the two sentences above, followed by
"(changed by #79: omitted steps have no marker, and a budget-0 section has empty text)". Also
update the acceptance-criterion line that quotes the GeneGA summary (line 502).

**code-r0-5: JSDoc order in `downloads.ts`.** Move
`/** The year to show and, when it was defaulted to an earlier one, why. Throws not_found if there is none. */`
from above `yearRanges`'s comment to directly above `function chooseYear(`. `yearRanges` keeps
only its own comment. No behaviour change.

**ux-r0-4: `agree`.** In `release-info.ts`:

```ts
agree: z
  .boolean()
  .describe(
    'true when config.yaml, the manifest index versions and its packages/release and packages/devel symlinks all name the same release and devel versions (see disagreements; a symlink missing from the index is not checked)',
  ),
```

Make the same replacement in the `PkgReleaseInfoDataSchema` snippet in
docs/specs/8-pkg-release-info.md (line 316).

**code-r0-2 (spec only).** docs/specs/8-pkg-release-info.md:493 becomes
`` `${name} (${page.category}) has no download stats for ${requested}; years with stats: ${yearRanges(years)}.` ``
with line 494's "(en dash)" replaced by "(ascending runs joined by ', ', each run with an en dash,
e.g. `2009, 2011–2026`; see Spec #44)". In docs/specs/44-followups-pkg.md, the bullet "Leave the
rest of Spec #8 as it is." becomes "Leave the rest of Spec #8 as it is, except the year
`not_found` template, which #79 updated to `yearRanges(years)`."

**code-r0-4.** In `test/core/pkg/downloads.test.ts`, 'other category: rnaseqGene…', replace the
`envelope.sources.map((s) => s.url)` assertion (keep its comment) with:

```ts
expect(envelope.sources).toEqual([
  { url: statsPageUrl('workflows', 'rnaseqGene'), as_of: AS_OF },
  { url: statsTabUrl('workflows', 'rnaseqGene', 2026), as_of: AS_OF },
]);
```

### #64: ops and deploy

**code-r0-2: the imports guard.** `test/upstreams/imports.test.ts` becomes:

```ts
/** Every import or export statement whose specifier starts with '../core/'; `[^;]` spans wrapped lines. */
function coreStatements(source: string): string[] {
  return source.match(/^(?:import|export)\s[^;]*?from\s+'\.\.\/core\/[^']*'/gm) ?? [];
}

describe('upstream adapters import core only as types', () => {
  test('there are adapters to check', () => {
    expect(adapters).toContain('github.ts');
  });

  test('the matcher finds wrapped imports and re-exports, one statement at a time', () => {
    expect(coreStatements("import {\n  X,\n} from '../core/x';")).toEqual(["import {\n  X,\n} from '../core/x'"]);
    expect(coreStatements("export { X } from '../core/x';")).toEqual(["export { X } from '../core/x'"]);
    expect(coreStatements("import { Y } from './y';\nimport type { X } from '../core/x';")).toEqual([
      "import type { X } from '../core/x'",
    ]);
  });

  test.each(adapters)('%s', (file) => {
    const source = readFileSync(join(UPSTREAMS_DIR, file), 'utf8');
    for (const statement of coreStatements(source)) expect(statement).toMatch(/^(?:import|export) type /);
  });
});
```

**Verified:** on today's `src/upstreams/*.ts` the matcher finds exactly one statement in each of
bioconductor, cran, github, http, packages-file, r-universe, registry and shared-load, all
`import type { … } from '../core/deps'`, and none in cache.ts or package-name.ts. On the wrapped
string it returns the whole statement. Spec 46 (docs/specs/46-followups-ops-deploy.md:145-147):
replace "find every line matching `/^import\s.*from\s+'\.\.\/core\//m` (global), and assert each
starts with `import type `" with "find every statement matching
`/^(?:import|export)\s[^;]*?from\s+'\.\.\/core\/[^']*'/gm` (`[^;]` spans wrapped lines), and assert
each starts with `import type ` or `export type ` (#79)".

**code-r0-3 (spec only).** docs/specs/46-followups-ops-deploy.md:454-455: "10 bioc-mcp PRs created
2026-10-21 (newer than every recorded PR)" → "10 bioc-mcp PRs created from 2026-10-22T12:00Z
(newer than every recorded PR; the newest is bioc-infrastructure#122 at 11:51)".

**code-r0-4 (spec only).** docs/specs/11-deploy.md:121 becomes
`src/rate-limit.ts                    NEW  RateLimiter, RATE_LIMIT_PERIOD_SECONDS, rateLimitKey(), rateLimitMiddleware()`.
In the test-plan row for `test/rate-limit.test.ts` (line 591), append before the closing `|`:
"; the `rateLimitKey` table; two addresses in one IPv6 /64 share a key, a neighbouring /64 gets
another".

**security-r0-1: byte-bounded titles and check names.** This takes the finding's "better fix"
and applies it to PR, issue and failure-issue titles as well as check names. Titles are
contributor-controlled too, and the probe above shows non-ASCII titles alone push `kind=prs`
over 8 KB. Docs alone (the "smallest fix") would leave `kind=prs` failing for every caller while
one hostile PR is open.

1. Move `jsonTextBytes` from `src/core/pkg/check-log.ts` to `src/envelope.ts`, unchanged except
   that it reuses a module-level `const encoder = new TextEncoder()`:

   ```ts
   /** UTF-8 bytes `s` occupies inside a JSON string: encode(JSON.stringify(s)).length - 2. */
   export function jsonTextBytes(s: string): number;
   ```

   `check-log.ts` imports it (`import { jsonTextBytes } from '../../envelope';`) and drops its own
   `encoder` and function. Its header comment ("Every size is a JSON text size (jsonTextBytes)")
   stays. `test/core/pkg/check-log.test.ts` and `test/core/pkg/check-output.test.ts` import
   `jsonTextBytes` from `../../../src/envelope`. Nothing re-exports it from check-log.ts. Why
   envelope.ts: it already owns `MAX_RESULT_BYTES` and `envelopeBytes`, and ops must not import
   from the pkg module.

2. `src/core/ops/rules.ts`:

   ```ts
   import { jsonTextBytes } from '../../envelope';

   const TITLE_LIMIT = 80; // bytes of JSON text (truncateText)

   /**
    * `text` when its JSON string form is at most `limit` UTF-8 bytes (jsonTextBytes); otherwise the
    * longest prefix of whole code points within `limit` − 1 bytes, then '…'. ASCII without JSON
    * escapes is cut to its first limit − 1 characters, as before. A cut result is at most limit + 2
    * bytes ('…' is 3) whatever the script, and never ends in half a surrogate pair.
    */
   export function truncateText(text: string, limit: number): string {
     if (jsonTextBytes(text) <= limit) return text;
     let kept = '';
     let bytes = 0;
     for (const char of text) {
       const size = jsonTextBytes(char);
       if (bytes + size > limit - 1) break;
       kept += char;
       bytes += size;
     }
     return `${kept}…`;
   }

   /** At most 80 bytes of JSON text (truncateText): 80 ASCII characters, fewer otherwise. */
   export function truncateTitle(title: string): string {
     return truncateText(title, TITLE_LIMIT);
   }
   ```

   `for…of` iterates code points, so a surrogate pair is kept or dropped whole. A lone surrogate
   counts as its 6-byte `\udXXX` escape. JSON escaping is per character, so the per-code-point
   sum equals `jsonTextBytes(kept)`.

3. `src/core/ops/config.ts`: `export const CHECK_NAME_LIMIT = 40; // bytes of JSON text per kept name (truncateText)`.
   The call site in `activity.ts` (`truncateText(name, CHECK_NAME_LIMIT)`) does not change.

4. `src/core/ops/activity.ts` descriptions. Both `title` fields:
   `title: z.string().describe("At most 80 bytes of JSON text (80 ASCII characters, fewer otherwise), ending in '…' when cut")`.
   `failing_checks`:
   `"Up to 3 failing check runs and commit statuses on the head commit (check runs first), each at most 40 bytes of JSON text (40 ASCII characters, fewer otherwise), ending in '…' when cut"`.

5. docs/specs/9-ops-activity.md:
   - Lines 452, 464 and 472: replace the three description snippets with the texts in step 4.
   - Line 140: `CHECK_NAME_LIMIT` comment → `// bytes of JSON text per kept name (truncateText)`.
   - Lines 375-379: replace the `truncateText` and `truncateTitle` signatures with the JSDoc and
     signatures in `src/core/ops/rules.ts` (byte-bounded, whole code points; "At most 80 bytes of
     JSON text (truncateText): 80 ASCII characters, fewer otherwise.").
   - Line 397 (parity table): "keeps 3 names of at most 40 characters" → "keeps 3 names of at most
     40 bytes of JSON text".
   - Lines 822-828: replace "PR titles are cut to 80 characters. Check names … are cut to 3 names
     of 40 characters …" through "remains the backstop." with:
     "PR, issue and failure-issue titles are cut to 80 bytes and check names to 40 bytes of JSON text
     (`truncateText`, whole code points), so non-ASCII or escaped text costs no more than ASCII.
     JSON escapes take up to 6 bytes per character (`\u00XX` for control characters, `\udXXX` for
     a lone surrogate), and the byte bound counts them. Check names (chosen by the PR's workflow
     file on fork PRs) are cut to 3 names and never appear in `reason` or the summary. Measured
     (spec #79): 10 PRs with 200-character titles and 100 failing 200-character checks each give a
     `kind=prs` envelope of 7,156 bytes (all repos) with ASCII text and 7,116 bytes with `日`
     titles and control-character check names. Before #79 the second was `result_too_large`. The
     guard's `result_too_large` remains the backstop."

### #66: triage test

`test/transports/triage.test.ts`:

- `connect`: `const { app, fetch } = makeTestApp({ routes: pkgRoutes, extraModules: [pkgModule, await docsTestModule()] });`
  (no `await` before `makeTestApp`; `docsTestModule()` stays awaited).
- `type Job = { config: string; check: string | null; job: string; url: string | null };`
- The walk: `const status = await call('pkg_status', { package: 'GEOfastq', universe: 'bioc' });`.
  The fetch-set assertion at the end stays as it is.

docs/specs/10-triage-prompt.md: line 227's table cell `pkg_status({ package: 'GEOfastq' })` →
`pkg_status({ package: 'GEOfastq', universe: 'bioc' })`. Line 333,
`` `pkg_status` `{ package: 'GEOfastq' }` `` → `` `pkg_status` `{ package: 'GEOfastq', universe: 'bioc' }` ``.
Line 30 is a "Verified (live)" record of a past call and stays.

### #70: repo-diff test comment

`test/core/pkg/repo-diff.test.ts`, the comment above `const name = i < 2400 ? …` becomes:

```ts
// Names 0–2,399 are in the index (every fifth at a different version); 2,400–2,499 are only on
// bioconductor.org; index entries 2,400–2,999 are only in the registry.
```

### #72: revdeps, missing deps, dependency graph

**code-r0-4.** In `src/core/pkg/dependency-graph.ts`:

```ts
/** Sort comparator by UTF-16 code units (locale-independent), for stable name lists. */
export const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How many of graph.depsUnknown the revdeps and missing-deps results list. */
export const DEPS_UNKNOWN_LISTED = 20;
```

`revdeps.ts` and `missing-deps.ts` delete their local `DEPS_UNKNOWN_LISTED` (and missing-deps.ts
its local `codeUnitOrder`) and import both from `./dependency-graph`. revdeps.ts imports only
`DEPS_UNKNOWN_LISTED`, since it does not sort. No behaviour change.

**ux-r0-1.** `pkg_revdeps` description: replace "Also works for a name that is not in the index,
listing the packages still waiting on it." with "Also works for a name that is not in the index
(a CRAN or base R package, or one missing from the registry), listing the index packages that
depend on it." Summary part 2 becomes:

```ts
if (!data.in_index) {
  summary += ` ${name} itself is not in the index (it may be on CRAN or base R; pkg_missing_deps says whether it is missing).`;
}
```

**ux-r0-2.** In the handler's not_found branch:

```ts
const matches = closeMatches(name, new Set([...Object.keys(index.packages), ...graph.dependents.keys()]));
```

The branch is reached only when `graph.dependents` has no exact key for `name`, so the candidate
set adds names that have dependents but no index entry (BiocSet, Rcpp). `closeMatches` skips the
exact name and lowercases both sides.

**ux-r0-5.** `pkg_missing_deps` description: "Such packages are published but cannot be
installed." → "Such packages are published but likely cannot be installed from the registry's
repositories."

**code-r0-3.** `src/upstreams/bioconductor.ts`:

```ts
description:
  'bioconductor.org: config.yaml (release and devel versions), the published manifest index, ' +
  'the source PACKAGES index of each repository (software, annotation and experiment data, workflows, books), ' +
  'and package download stats (/packages/stats).',
```

This is what `bioc://about` and `/api/v1/about` show. No test asserts the old string.

**Spec 52 (docs/specs/52-revdeps.md).**

- Files table: after the `src/upstreams/shared-load.ts` rows add
  `src/upstreams/registry.ts             getPropagationIndex uses SharedLoads (memo, load deadline and withinMs moved to shared-load.ts)`
  (code-r1-2). Append `, codeUnitOrder, DEPS_UNKNOWN_LISTED (#79)` to the dependency-graph.ts
  exports.
- `### src/upstreams/bioconductor.ts (additions)`: after the code block add "The upstream's
  `description` names the source PACKAGES index of each repository, including annotation and
  experiment data (#79, #72 code-r0-3)."
- Not found (line 446): `closeMatches(name, Object.keys(index.packages))` →
  `closeMatches(name, new Set([...Object.keys(index.packages), ...graph.dependents.keys()]))`, with
  "(index names and names that have dependents; #79)".
- Summary part 2 (line 472): the new clause above.
- The two `description:` snippets (lines 491 and 651): the new sentences above.

docs/specs/6-pkg-status.md, step 2 (line 151): append to the step's first sentence: "(Since #52
this memo, its load deadline and `withinMs` live in `SharedLoads` in
src/upstreams/shared-load.ts; `getPropagationIndex` calls `propagationIndexes.get`.)"

### #75: PACKAGES reader

**code-r0-1.** In `test/upstreams/packages-file.test.ts`, `describe('Path stanzas')`, add a
second `test.each` after the invalid-Path one:

```ts
test.each([
  ['an invalid version', stanza('MASS', '7.3-66') + '\n' + pathStanza('MASS', '1.0a')],
  ['no Version', stanza('MASS', '7.3-66') + '\n' + 'Package: MASS\nPath: 4.7.0/Recommended\n'],
])('a Path stanza repeating a known name with %s throws upstream_error', (_label, body) => {
  const error = errorOfParse(body, cranUpstream, URL) as CapabilityError;
  expect(error).toBeInstanceOf(CapabilityError);
  expect(error.code).toBe('upstream_error');
});
```

(An invalid *name* cannot repeat a known valid name, so there is no third case.)

**code-r0-2 (spec only).** docs/specs/74-packages-reader.md criterion 5 (lines 337-339)
becomes: "Every Spec #50 violation case (the twelve in today's `parsePackagesFile` `test.each`)
throws `upstream_error` whose message contains the URL and whose details are
`{ upstream: 'bioconductor', url }` under `bioconductorUpstream`. One case (`'Version: 1.0\n'`)
under `cranUpstream` throws with message
`CRAN returned a PACKAGES file in an unexpected format (<url>)` and details
`{ upstream: 'cran', url }`."

**code-r0-3.** `src/upstreams/packages-file.ts:100-101` comment becomes:

```ts
// Per call, outside the shared load: callers of one URL may differ in allowEmpty.
// An empty list would make every lookup a miss.
```

## Acceptance criteria

Each is checked by a test unless it says otherwise.

**pkg_check_output (#57 code-r0-3)**

- [ ] A new test in `check-output.test.ts`, "more than 12 short sections: the summary says how
      many steps were left out, and nothing was cut", serves inline a `00check.log` of 15
      sections `* checking step ${i} ... ${i < 3 ? 'ERROR' : 'NOTE'}\nbody ${i}`, then
      `Status: 3 ERRORs, 12 NOTEs`, plus `pkgdata.txt`. Asserts: 12 sections,
      `sections_omitted` 3, no section `truncated`, the summary contains
      `3 more steps were left out (beyond the 12 most severe); page the whole log with full=true.`
      and does not contain `cut to fit`.
- [ ] The existing size-budget test (15 long sections) also asserts that the summary contains both
      `each cut section's marker, or its offset when its text is empty, gives where to read it with full=true.`
      and `3 more steps were left out`.
- [ ] The GeneGA test expects
      `Some output was cut to fit; each cut section's marker, or its offset when its text is empty, gives where to read it with full=true.`
      and its summary does not contain `left out`.
- [ ] The budget-0 test in `check-log.test.ts` also asserts
      `selected.map((s) => s.offset)` equals `sections.map((s) => s.offset)`: each empty-text
      section still carries its pointer.
- [ ] A test reads `z.toJSONSchema(PkgCheckOutputDataSchema)` (or the zod `.description`) and finds
      that the `truncated` description contains `or offset when text is empty`.

**pkg_downloads, pkg_release_info (#57)**

- [ ] code-r0-4: the rnaseqGene test asserts `envelope.sources` with `toEqual` (both URLs, `as_of: AS_OF`).
- [ ] code-r0-5: in `downloads.ts` the line directly above `function chooseYear(` is its JSDoc,
      and `yearRanges` has exactly one JSDoc block (checked by reading the diff). Behaviour tests
      pass unchanged.
- [ ] ux-r0-4: a test asserts `PkgReleaseInfoDataSchema.shape.agree.description` contains
      `a symlink missing from the index is not checked`. The existing assertion on
      `packages/release and packages/devel symlinks` still passes.
- [ ] code-r0-2: spec 8:493 uses `yearRanges(years)`, and spec 44's "Leave the rest" bullet names
      the exception (checked by reading the diff).

**ops_activity and the upstream seam (#64)**

- [ ] code-r0-2: the imports guard's matcher test passes on the three inline strings above, and
      the per-adapter `test.each` passes on today's adapters.
- [ ] security-r0-1, `rules.test.ts`:
  - `truncateText('abcd', 4)` → `'abcd'` and `truncateText('abcdef', 4)` → `'abc…'` (unchanged);
  - `truncateText('日'.repeat(30), 40)` → `'日'.repeat(13) + '…'`;
  - `truncateText('\u0001'.repeat(30), 40)` → `'\u0001'.repeat(6) + '…'`;
  - `truncateText('ab' + '😀'.repeat(20), 10)` → `'ab😀…'` (the code-unit cut would have left a
    lone high surrogate);
  - `truncateText('\ud800'.repeat(10), 20)` → `'\ud800'.repeat(3) + '…'`;
  - `truncateTitle('a'.repeat(80))` and `truncateTitle('a'.repeat(81))` as today;
    `truncateTitle('日'.repeat(80))` → `'日'.repeat(26) + '…'`.
- [ ] security-r0-1, `activity.test.ts`: `hostileRoutes(count, title, checkName = (i) => \`${i}-${'c'.repeat(200)}\`)`.
      A new test, 'ten hostile PRs with non-ASCII titles and control-character check names still
      fit', uses `hostileRoutes(10, '日'.repeat(200), (i) => \`${i}-${'\u0001'.repeat(200)}\`)`. For
      `{}` and `{ repo: 'bioc-mcp' }` it asserts: 10 bioc-mcp items; `envelopeBytes(envelope) < MAX_RESULT_BYTES`;
      every bioc-mcp item's `jsonTextBytes(title) <= 82`; every kept check name's
      `jsonTextBytes(name) <= 42` and ends with `…`. The existing ASCII tests ('a PR with 100 long
      failing checks stays bounded', 'ten hostile PRs still fit') pass unchanged.
- [ ] `jsonTextBytes` is exported from `src/envelope.ts` only:
      `grep -rn "export function jsonTextBytes" src` prints one line, in envelope.ts.
- [ ] Specs 9, 11 and 46 carry the corrections listed above (checked by reading the diff).

**Triage (#66)**

- [ ] The walk calls `pkg_status` with `{ package: 'GEOfastq', universe: 'bioc' }` and passes.
      `grep -n "await makeTestApp" test/transports/triage.test.ts` prints nothing. `Job.url` is
      `string | null` (`npm run typecheck` passes).

**revdeps, missing deps, paging, repo diff (#70, #72)**

- [ ] code-r0-2: 'flowWorkspace, direct only' (using the depth-1 call's `fetch`), 'ggcyto',
      'MDSvis' and 'BiocSet' each assert `expect(envelope.sources).toEqual([INDEX_SOURCE])` and
      `expect(fetch.calls).toEqual([BIOC_INDEX_URL])`.
- [ ] ux-r0-1: the BiocSet summary assertion expects
      `… (3 directly). BiocSet itself is not in the index (it may be on CRAN or base R; pkg_missing_deps says whether it is missing).`
      followed by `NOT_IN_INDEX_SUMMARY_TAIL`. A test asserts `pkgRevdeps.description` contains
      `(a CRAN or base R package, or one missing from the registry)`.
- [ ] ux-r0-2: a new test, "a case slip on a name that only has dependents suggests it", runs
      `{ package: 'biocset' }`. It is `not_found` with message exactly
      `No bioc propagation entry named "biocset", and no package in the bioc index depends on it. Package names are case-sensitive. Did you mean: BiocSet? To check release, call again with universe 'bioc-release'.`
      and `fetch.calls` `[BIOC_INDEX_URL]`. The existing `flowWorkspac` test still passes.
- [ ] ux-r0-5: a test asserts `pkgMissingDeps.description` contains
      `likely cannot be installed from the registry's repositories` and not
      `published but cannot be installed`.
- [ ] code-r0-4: `grep -rn "const codeUnitOrder\|const DEPS_UNKNOWN_LISTED" src` prints exactly two
      lines, both in `dependency-graph.ts`. The revdeps and missing-deps tests pass unchanged.
- [ ] code-r0-5: 'multi-byte names are counted in UTF-8 bytes, not UTF-16 code units' asserts
      `takePage(['é', 'é'], 0, 9)` → `{ page: ['é'], nextCursor: '1' }` and
      `takePage(['日本', '日本'], 0, 10)` → `{ page: ['日本'], nextCursor: '1' }`, with a comment
      saying each would return both items if `takePage` measured `.length`. The `'é'×3` and
      `'a'×3` assertions are removed.
- [ ] code-r0-3: `bioconductorUpstream.description` contains
      `(software, annotation and experiment data, workflows, books)`. The about tests pass.
- [ ] #70 code-r0-1: the repo-diff comment reads as above (checked by reading the diff).
- [ ] Spec 52 and spec 6 carry the edits listed above (checked by reading the diff).

**PACKAGES reader (#75)**

- [ ] code-r0-1: both new cases throw `upstream_error`. Mutation check, done once by hand and
      not committed: moving `if (!versions.has(name)) …` above the validation in `endStanza` makes
      at least one of them fail.
- [ ] code-r0-2 and code-r0-3: spec 74 criterion 5 and the packages-file.ts comment read as above
      (checked by reading the diff).

**Upstream memory note (#47)**

- [ ] `readCapped`'s doc comment, the `Upstream.maxBytes` comment and spec 43's Risks bullet state
      "about 2 × maxBytes" and the parsed JSON (checked by reading the diff). `src/upstreams/http.ts`
      has no non-comment change: `git diff main -- src/upstreams/http.ts` touches only comment lines.

**README and CONTRIBUTING (#39, #72)**

- [ ] Every `bioc-*` in README.md is written `seandavi/bioc-*`, and the intro, the `ops_activity`
      row and the First question each say "seandavi/bioc-* infrastructure repos" (checked by
      reading the diff).
- [ ] README.md contains "Each client below says whether it was tested against the live server,
      and when." and `GEMINI_API_KEY`. CONTRIBUTING.md does not contain "never need the factory".
- [ ] README.md has the two new First questions, the revdeps curl line and the reworded
      `pkg_missing_deps` row (checked by reading the diff).

**Whole PR**

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass. `test/no-network.test.ts` passes.
- [ ] `npm run eval:docs` reports the same scores as on `main`. No docs input or fixture changed.
- [ ] No staged secrets; no fixture under `test/fixtures/` changed.
- [ ] The PR body has the outcome table from Goal, says `Closes #79`, and lists #39, #47, #57, #64,
      #66, #70, #72 and #75 as closable. It calls out the `ops_activity` output change: non-ASCII
      or escaped titles and check names are now cut by bytes and so keep fewer characters.

## Test plan

- Unit:
  - `test/core/ops/rules.test.ts`: the `truncateText`/`truncateTitle` table above.
  - `test/core/pkg/check-log.test.ts`: budget-0 offsets; import from envelope.
  - `test/core/pkg/check-output.test.ts`: the short-sections test, size-budget and GeneGA summary
    assertions, the `truncated` description; import from envelope.
  - `test/core/pkg/downloads.test.ts`, `release-info.test.ts`, `revdeps.test.ts`,
    `missing-deps.test.ts`, `paging.test.ts`, `repo-diff.test.ts` (comment only).
  - `test/upstreams/packages-file.test.ts`: two Path cases.
  - `test/upstreams/imports.test.ts`: matcher cases and the per-adapter check.
- Capability over fixtures: `test/core/ops/activity.test.ts`, the non-ASCII hostile test.
- Transport: `test/transports/triage.test.ts` (walk with `universe: 'bioc'`). The existing
  MCP-equals-REST tests in `test/transports/pkg.test.ts` and `ops.test.ts` cover the description
  and summary changes in both transports. They pass unchanged, because they compare the two
  transports rather than literal text.
- All tests use `fixtureFetch` with existing fixtures or inline bodies. None touch the network.
- Run `npm test`, `npm run typecheck`, `npm run build`, `npm run eval:docs`.

## Risks

- **`ops_activity` cuts change for non-ASCII text.** A title such as `'日'×80` used to be kept
  whole (80 code units). It is now cut to 26 characters plus `…`. That is the price of a size
  bound that does not depend on the script. ASCII output is byte-identical (probe above). The
  REST API is unstable until v1, and the PR body calls the change out.
- **`truncateText` cost.** It calls `jsonTextBytes` once on the whole text and once per kept code
  point (at most about 80). GitHub caps titles at 256 characters, and check names are short in
  practice, so this is negligible next to the GitHub fetches.
- **`jsonTextBytes` moves.** Any import of it from `check-log` breaks at typecheck. Only two test
  files import it today, and both are updated.
- **Imports guard limits.** The matcher assumes statements end with `;` (true for every file in
  `src/`). A side-effect `import '../core/x';` or a dynamic `import()` is not matched. Neither
  appears in an adapter, and both would be caught in review.
- **`closeMatches` over a larger set.** The not_found candidates grow by the dependents' keys
  (CRAN and base names included). The length filter from #44 keeps it linear. Suggestions may now
  include a CRAN name, which is a real name the tool accepts.
- **README wording drifts from the recorded docs fixture.** The docs index is built from
  `test/fixtures/docs/…/README.md`, not the working tree, so tests and the eval do not move. The
  live index picks up the new README at the next docs rebuild after merge.
- **ellmer.** The comment is true for ellmer 0.4.2 and main today (`GOOGLE_API_KEY` first, then
  `GEMINI_API_KEY`). A later ellmer could change the variable names.
