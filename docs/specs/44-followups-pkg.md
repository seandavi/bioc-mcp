# Spec #44: pkg follow-ups from the #6, #7 and #8 reviews

Issue: [seandavi/bioc-mcp#44](https://github.com/seandavi/bioc-mcp/issues/44). Source issues:
[#20](https://github.com/seandavi/bioc-mcp/issues/20) (review of #6, `pkg_status`),
[#24](https://github.com/seandavi/bioc-mcp/issues/24) (review of #8, `pkg_release_info` and
`pkg_downloads`), [#28](https://github.com/seandavi/bioc-mcp/issues/28) (review of #7,
`pkg_check_output` and `pkg_build_environment`). Builds on [Spec #6](6-pkg-status.md),
[Spec #7](7-pkg-check-output.md) and [Spec #8](8-pkg-release-info.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

The following was checked on 2026-10-22 against `main` at 41923d1 (zod 4.6.7, vitest 5.0.5), with
a throwaway test that was deleted afterwards. **Verified** marks what it showed:

- **Verified:** the README items are already done. After the #40 rewrite, README.md has a tool
  table listing all five pkg tools (lines 42–46) and the REST example
  `curl -s "$BIOC_MCP/api/v1/pkg/status?package=edgeR&universe=bioc-release"` (line 156). The
  sentence "Today the only tool is `meta_ping`" is gone.
- **Verified:** #35 already did what #28 ux-r0-6 asks. `src/transports/mcp.ts:75` builds `content`
  with `envelopeTextBlocks` (summary, then `JSON.stringify({ data, sources })`).
- **Verified:** current `pkg_status` summaries and sources for the scenarios that #20 code-r0-2
  names. Every r-universe source except trackViewer has `as_of` equal to the test clock, because
  only trackViewer's route sends `last-modified`:
  - ClustIRR: `ClustIRR (bioc) is propagated at 1.11.0 (seeded from Bioconductor, never gated, 2026-08-14). r-universe builds 1.11.6: status success, failing linux-devel-arm64 (ERROR), linux-devel-x86_64 (ERROR), linux-release-arm64 (ERROR) and 10 more. Upstream 1.11.6 is newer than propagated 1.11.0.`
  - SEMPLR: `SEMPLR (bioc) is propagated at 1.1.2 (passed the gate via r-universe, 2026-08-08). r-universe builds 1.1.2: status success.` (5,494 bytes, the largest status envelope)
- **Verified:** the registry serves `POST /gate`. `POST https://bioc-registry.seandavi.workers.dev/gate`
  with an empty body answers 400 `{"error":"invalid JSON body"}`. It is documented under the
  heading `` ### `POST /gate` `` in
  <https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#post-gate>.
- **Verified:** #28 security-r0-1 is real. `HEADER.exec('* ' + ' ... ['.repeat(n))` took 10 ms at
  12,000 characters, 40 ms at 24,000 and 153 ms at 48,000. That is quadratic, so a 240,000-character
  line would take about 4 s.
- **Verified:** job `96299707840`'s build manifest installs `httr2` and `biomaRt`. Today,
  `dependencies: ['biomart', 'HTTR2', 'biomaRt']` gives the summary
  `Versions: biomart not installed, HTTR2 not installed, biomaRt 2.69.0.`
- **Verified:** the rnaseqGene workflows page says `Data as of Thu. 22 Oct 2026` and links
  `rnaseqGene_{2014..2026}_stats.tab` with no gaps. Its 2026 file has `Jan 43 74`, `Oct 514 789` and
  `all 2690 4730`. The edgeR page links each year from 2009 to 2026 exactly once
  (`href="edgeR_2010_stats.tab"` occurs once).
- **Verified** in Spec #7 (line 153), from 154 observed jobs: `bioc-checks` jobs have only
  `00BiocCheck.log` and `output.log`, and `source` jobs have only `pkgdata.txt`.

## Goal

Settle every item in #44's scope in one PR: fix it, or mark it moot or out of scope. The PR body
repeats the table below so #20, #24 and #28 can be closed when it merges.

| Item | Outcome | What changes |
|---|---|---|
| #20 code-r0-1 | out of scope | Moved to the upstream bundle by #44 |
| #20 code-r0-2 | fix | Every `pkg_status` scenario test asserts the full `sources`; ClustIRR and SEMPLR assert a summary substring |
| #20 code-r0-3 / ux-r0-1 | moot | README lists every pkg tool and has a `pkg/status` example since #40 |
| #20 ux-r0-2 | fix | The `pkg_status` `not_found` message names the other universe |
| #20 security-r0-2 | fix | `closeMatches` skips the edit distance for candidates it can never match |
| #20 code-r0-4 | fix | Local alias `Upstream` in status.ts → `UpstreamState` |
| #20 code-r0-5 / security-r0-3 | fix | `historySql` checks its name with `PackageNameSchema.parse` |
| #20 ux-r0-3 | fix | The fallback `behind_reason` gives the absolute `/gate` URL and its docs; the summary gets a clause |
| #20 ux-r0-4 | fix | The package-name regex message states the rule |
| #24 code-r0-1 / ux-r0-1 | fix | The `agree` description (code and Spec #8 snippet) covers the symlink checks |
| #24 code-r0-2 | fix | The 2025, rnaseqGene and January downloads tests assert `sources` and the missing fields |
| #24 code-r0-3 | fix (spec only) | Spec #8's Files list names `isoDate()`, `readBiocFixture()` and `NOT_FOUND` |
| #24 ux-r0-2 | fix | The year `not_found` message lists years as ranges, so gaps show |
| #24 ux-r0-3 | fix | `manifest.build` gets a description |
| #24 ux-r0-4 | moot | Same README finding as #20 code-r0-3 |
| #28 code-r0-2 | fix | The size-budget test pins that the budget loop stepped down |
| #28 ux-r0-2 | fix | The `file` and tool descriptions say what bioc-checks and source jobs hold; the missing-file message says "Pass one of them as file." |
| #28 ux-r0-3 | fix | `pkg_status` emits `job` as a digit string (the cleaner fix in the finding) |
| #28 ux-r0-4 | fix | `pkg_build_environment` deps get `did_you_mean`; descriptions and summary say a null version may be a misspelling |
| #28 ux-r0-5 | fix | Each check section carries its `offset`; the omitted-lines marker gives the `full=true` offset |
| #28 ux-r0-6 | moot | #35 added the JSON text block (`envelopeTextBlocks`) |
| #28 ux-r0-7 | fix (description) | `job_url` and `jobs[].url` descriptions say they are the same page |
| #28 ux-r0-8 | fix | `total_chars` and `files_total` get descriptions |
| #28 security-r0-1 | fix | `parseCheckLog` runs `HEADER` only on lines of at most 1,000 characters |
| #28 security-r0-2 | fix | The missing-file message caps the file list at 40, "and N more" |
| #28 ux-r1-1 | fix | Three test names say "has not captured" instead of "never captured" |
| #28 main-1 | out of scope | Moved to the upstream bundle by #44 |

Nothing is declined.

## Non-goals

- No new capability, module, upstream, REST route or MCP tool, and no recorded fixture. Every new
  test uses existing fixtures, or edits a fixture inline in the test.
- #20 code-r0-1 (the propagation-index memo keeps the body) and #28 main-1 (`getCheckFiles`
  buffers the whole response) are not touched. `src/upstreams/registry.ts` does not change.
- Specs #6 and #7 are not rewritten. Their snippets show the schemas as they merged, for example
  `job: z.number()`. Only Spec #8 changes, because #24 code-r0-1 and code-r0-3 ask for it.
- `pkg_status` keeps its `…/actions/runs/<run>/job/<job>` URLs, and the job tools keep
  `…/runs/<job>`. #28 ux-r0-7 is fixed in the descriptions only (see Design › #28 ux-r0-7).
- No paging of dependency names in `pkg_build_environment` (#28 ux-r0-4 calls it a further
  follow-up).
- The README does not change.

## Design

There are no new capabilities. Each change below lists the file, the exact new text, and the
test. Unless a section says otherwise, MCP tool names, REST routes, input schemas and upstream
calls stay as they are:

| Tool | REST route | Input change | Output change |
|---|---|---|---|
| `pkg_status` | `GET /api/v1/pkg/status` | none | `upstream.jobs[].job` and `upstream.newer_commit_failed.job.job` become strings; descriptions |
| `pkg_check_output` | `GET /api/v1/pkg/check_output` | description of `file` only | `check.sections[].offset` (new); descriptions |
| `pkg_build_environment` | `GET /api/v1/pkg/build_environment` | none | `deps[].did_you_mean` (new); descriptions |
| `pkg_release_info` | `GET /api/v1/pkg/release_info` | none | descriptions only |
| `pkg_downloads` | `GET /api/v1/pkg/downloads` | none | none (error text only) |

There are no new upstream calls and no fixtures to record.

### Files

```
src/core/pkg/package-name.ts       regex message; closeMatches length filter
src/core/pkg/status.ts             JobSchema.job string + descriptions; UpstreamState; historySql parse;
                                   not_found universe hint; /gate URL in reason; summary clause
src/core/pkg/check-log.ts          CheckSection.offset; fitSectionText(text, maxBytes, offset);
                                   marker with offset; MAX_HEADER_LINE_CHARS
src/core/pkg/check-output.ts       CheckSectionSchema.offset; descriptions; missing-file message; summary
src/core/pkg/build-environment.ts  did_you_mean; descriptions; summary
src/core/pkg/release-info.ts       agree and build descriptions
src/core/pkg/downloads.ts          yearRanges(); not_found message
docs/specs/8-pkg-release-info.md   agree and build snippet; Files list; bioconductor-routes exports
test/core/pkg/status.test.ts
test/core/pkg/package-name.test.ts
test/core/pkg/check-log.test.ts
test/core/pkg/check-output.test.ts
test/core/pkg/build-environment.test.ts
test/core/pkg/release-info.test.ts
test/core/pkg/downloads.test.ts
test/transports/pkg.test.ts        two test names
```

Import zod as `import * as z from 'zod'`, as the files already do. No dependency changes.

### `package-name.ts`

**#20 ux-r0-4.** The regex message becomes:

```ts
.regex(
  /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/,
  "Not a valid R package name: it must start with a letter, contain only letters, digits and '.', and not end with '.'",
)
```

The `.describe()` text, `.min(2)` and `.max(100)` stay as they are. `invokeCapability` reports
`z.prettifyError(...)`, which contains this message.

**#20 security-r0-2.** In `closeMatches`, work out `prefix` before the distance, and skip
candidates that can match neither way. Edit distance is at least the length difference, so this
changes no result:

```ts
for (const candidate of candidates) {
  if (candidate === name) continue;
  const lower = candidate.toLowerCase();
  const prefix = query.length >= 3 && lower.startsWith(query);
  // The edit distance is at least the length difference, so this candidate can never be within 2.
  if (!prefix && Math.abs(lower.length - query.length) > 2) continue;
  const distance = levenshtein(query, lower);
  if (distance <= 2 || prefix) scored.push({ candidate, distance });
}
```

The optional early return for very long queries is not added: the length filter already makes
such a call O(number of candidates).

### `status.ts`

**#28 ux-r0-3: `job` as a string.** In `JobSchema`:

```ts
job: z
  .string()
  .describe(
    'GitHub Actions job id, as a string of digits; pass it unchanged as job to pkg_check_output and pkg_build_environment',
  ),
url: z
  .string()
  .nullable()
  .describe(
    'GitHub Actions job page; null if the build URL is not a GitHub Actions run. pkg_check_output and ' +
      "pkg_build_environment return the same page as job_url, in the short form …/runs/<job>",
  ),
```

`toJob` sets `job: String(j.job)`. The `url` template stays `` `${buildUrl}/job/${j.job}` ``.
`RUniverseJobSchema.job` in `src/upstreams/r-universe.ts` stays `z.number().int()`, because the
upstream sends a number. The same `JobSchema` covers `newer_commit_failed.job`.

Why the string rather than only a description: both job tools take `job` as a digit string
(`JobIdSchema`), so an agent that copies `pkg_status`'s value now passes the type they accept. The
REST API is unstable until v1 (AGENTS.md). The only client-visible effect is that the JSON value
is quoted.

**#20 code-r0-4.** Rename the local alias `type Upstream = …` to `type UpstreamState = …` and
update its three uses (`shapeUpstream`'s return type, `behindReasons`' parameter). Nothing else
uses the name.

**#20 code-r0-5 / security-r0-3.** `historySql` enforces its precondition:

```ts
/** The check-history query for /sql. `name` must be a valid package name, so it holds no quote; parse enforces it. */
export function historySql(universe: Universe, name: string): string {
  PackageNameSchema.parse(name);
  return [ /* unchanged */ ].join('\n');
}
```

A bad name throws zod's `ZodError`. Callers always pass an already-validated name, so this only
fires on programmer error, and a thrown non-`CapabilityError` becomes `internal_error` in
`invokeCapability`.

**#20 ux-r0-2.** In the handler's `not_found` branch, append a universe hint after the
did-you-mean part:

```ts
const otherUniverse =
  universe === 'bioc'
    ? " To check release, call again with universe 'bioc-release'."
    : " To check devel, call again with universe 'bioc'.";
throw new CapabilityError(
  'not_found',
  `No ${universe} propagation entry and no r-universe build for "${name}". Package names are case-sensitive.` +
    (matches.length > 0 ? ` Did you mean: ${matches.join(', ')}?` : '') +
    otherUniverse,
);
```

There is no extra fetch.

**#20 ux-r0-3.** The fallback reason in `behindReasons` (r-universe status success, no failing
check) becomes:

```ts
reasons.push(
  'r-universe shows no failing build or check for this version, so the gate rejected it on another rule ' +
    '(platform families, dependencies, manifest) or has not evaluated it yet; ' +
    `POST ${new URL('gate', REGISTRY_BASE_URL).href} ` +
    '(https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#post-gate) gives the rule-by-rule decision.',
);
```

The URL renders as `https://bioc-registry.seandavi.workers.dev/gate`. In `summarize`, right after
the `Upstream X is newer than propagated Y.` sentence and under the same `behind === true` guard,
add one sentence when `upstream.status === 'success'` and `failingChecks(upstream.jobs).length === 0`:

```ts
`r-universe shows no failure for ${upstream.version}, so the gate's reason is not visible here; see behind_reasons.`
```

### `check-log.ts`

**#28 ux-r0-5: section offsets.**

```ts
export interface CheckSection {
  check: string;
  verdict: SectionVerdict;
  offset: number; // where the body starts in the normalized text (the character after the header's '\n'), ≤ text.length
  text: string;
}
```

`parseCheckLog` tracks each line's start while it iterates `text.split('\n')`
(`lineStart += line.length + 1` after each line). When it opens a section on a header line, it
records `offset: Math.min(lineStart + line.length + 1, text.length)`. `close()` copies `offset`
into the pushed section.

`fitSectionText` gets a required third parameter:

```ts
export function fitSectionText(text: string, maxBytes: number, offset: number): { text: string; truncated: boolean };

const omittedMarker = (lines: number, offset: number) =>
  `[… ${lines} lines omitted; read them with full=true and offset=${offset} …]`;
```

- The head-and-tail form (`withTail(k)`) omits `rest[0 .. rest.length - k)`, which always starts at
  body line 2. Its marker offset is `offset + lines[0].length + 1 + lines[1].length + 1`. Compute
  it once as `restOffset`.
- The marker-alone fallback omits every line. Its marker offset is `offset`.
- Everything else stays the same: the binary search, the 2 head lines, and the empty string when
  even the marker does not fit.

`selectSections` passes `section.offset` to `fitSectionText` and copies `offset` into each
`FittedSection` (it extends `CheckSection`, so the type requires it).

**#28 security-r0-1.**

```ts
const MAX_HEADER_LINE_CHARS = 1000; // real step headers are well under 300 characters
…
const match = line.length <= MAX_HEADER_LINE_CHARS ? HEADER.exec(line) : null;
```

A longer `* ` line still closes the open section, as any `* ` line does today. It just never opens
one. The `HEADER` regex does not change.

### `check-output.ts`

**#28 ux-r0-5.** `CheckSectionSchema`:

```ts
const CheckSectionSchema = z.object({
  check: z.string().describe("The R CMD check step, e.g. 'checking examples'"),
  verdict: z.enum(SECTION_VERDICTS),
  offset: z
    .number()
    .int()
    .describe("Character offset in the normalized 00check.log where this step's output starts; pass it as offset with full=true to read the step whole"),
  text: z.string().describe('What R CMD check printed under this step'),
  truncated: z
    .boolean()
    .describe('true if lines were cut to fit the size limit; the marker in text gives the offset to read them with full=true'),
});
```

The handler passes `selected.sections` through unchanged, so `offset` reaches the output. In
`summarize`, the sentence `Some output was cut to fit; read the whole log with full=true.` becomes
`Some output was cut to fit; each cut section's marker gives the offset to read it with full=true.`

**#28 ux-r0-8.** In `TextPageSchema`:
`total_chars: z.number().int().describe('Length of the normalized file (CRLF → LF, ANSI removed), in the same units as offset')`.
In `PkgCheckOutputDataSchema`:
`` files_total: z.number().int().describe(`Number of captured files; files lists at most ${MAX_LISTED_FILES}`) ``.

**#28 ux-r0-7.** `job_url: z.string().describe("GitHub Actions job page; the same page as pkg_status's jobs[].url, in its short form")`.
`build-environment.ts` uses the same text.

**#28 ux-r0-2.** The `file` input description becomes:

```ts
"Captured file to read, by basename (default '00check.log'); the result lists the job's files. " +
  "bioc-checks jobs have no 00check.log: use file='output.log' (BiocCheck's results). source jobs hold only pkgdata.txt"
```

In the tool description, insert this sentence after `… output.log, …).`:
`bioc-checks jobs have no 00check.log; pass file='output.log' for BiocCheck's results.`

**#28 ux-r0-2 and security-r0-2: the missing-file message.** Add a module-private helper with the
same "and N more" form that `summarize()` uses, and use it in the error:

```ts
function listFiles(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_FILES);
  return shown.join(', ') + (names.length > shown.length ? ` and ${names.length - shown.length} more` : '');
}
…
throw new CapabilityError(
  'not_found',
  `${universe} job ${job} has no file "${file}". Its files: ${listFiles(names)}. Pass one of them as file.`,
);
```

`summarize()` keeps its `Files:` sentence as it is: it builds the same text from `data.files` and
`files_total`. The echoed `file` stays: the schema already caps it at 255 characters.

### `build-environment.ts`

**#28 ux-r0-4.**

```ts
deps: z
  .array(
    z.object({
      package: z.string(),
      version: z
        .string()
        .nullable()
        .describe('Installed version; null if the build did not install it or the name is misspelled (names are case-sensitive; see did_you_mean)'),
      did_you_mean: z
        .array(z.string())
        .describe('When version is null: installed names close to this one, best first, at most 3; empty otherwise'),
    }),
  )
  .describe('The requested dependencies in request order (duplicates removed)'),
```

In the handler:

```ts
const installedNames = Object.keys(installed);
deps: [...new Set(dependencies)].map((name) => {
  const version = Object.hasOwn(installed, name) ? installed[name]! : null;
  return { package: name, version, did_you_mean: version === null ? closeMatches(name, installedNames, 3) : [] };
}),
```

Import `closeMatches` from `./package-name`. In `summarize`, a null version renders as
`${d.package} not installed` when `did_you_mean` is empty, and as
`${d.package} not installed (did you mean ${d.did_you_mean.join(', ')}?)` otherwise. The 10-entry
cap and the "and N more" suffix stay.

The tool description gets this sentence after "…the exact installed versions of the dependencies
you name.": `Names are case-sensitive; a misspelled name has version null and did_you_mean suggestions.`

### `release-info.ts`

**#24 code-r0-1 / ux-r0-1.**
`agree: z.boolean().describe('true when config.yaml, the manifest index versions and its packages/release and packages/devel symlinks all name the same release and devel versions (see disagreements)')`.

**#24 ux-r0-3.**
`build: z.string().nullable().describe('Identifier of the manifest build that produced the index (a commit-run id); null if the index gives none')`.

### `downloads.ts`

**#24 ux-r0-2.** Add a module-private helper and use it in `chooseYear`'s requested-year
`not_found`:

```ts
/** Ascending years as runs: [2009, 2011, 2012, 2013] → '2009, 2011–2013'. */
function yearRanges(years: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < years.length; ) {
    let j = i;
    while (j + 1 < years.length && years[j + 1] === years[j]! + 1) j++;
    runs.push(j > i ? `${years[i]}–${years[j]}` : String(years[i]));
    i = j + 1;
  }
  return runs.join(', ');
}
…
`${name} (${page.category}) has no download stats for ${requested}; years with stats: ${yearRanges(years)}.`
```

For contiguous years the message does not change (`2009–2026`).

### `docs/specs/8-pkg-release-info.md`

- **#24 code-r0-1:** in the `PkgReleaseInfoDataSchema` snippet, replace the `agree` line with the
  new description above. **#24 ux-r0-3:** replace `build: z.string().nullable(),` with the
  described form above.
- **#24 code-r0-3:** in the Files block, add `isoDate()` to the `src/upstreams/bioconductor.ts`
  row, with the note `(shared Date.UTC round-trip used by parseDataAsOf and parseReleaseDate)`.
  Append `; readBiocFixture(), NOT_FOUND` to the `test/support/bioconductor-routes.ts` row. In the
  "`test/support/bioconductor-routes.ts` exports" list, add a bullet:
  `` `readBiocFixture(path)` (reads a file under test/fixtures/bioconductor/) and `NOT_FOUND` (the inline 404 route below). ``
- Leave the rest of Spec #8 as it is.

## Acceptance criteria

Each is checked by a test unless it says otherwise.

**pkg_status (#20, #28 ux-r0-3)**

- [ ] #20 code-r0-2: the RMassBank, biomaRt, ClustIRR, BiocSet, SEMPLR and Chromatograms tests
      each assert
      `expect(envelope.sources).toEqual([{ url: BIOC_INDEX_URL, as_of: NOW }, { url: ruUrl('bioc', name), as_of: NOW }])`.
      The edgeR test asserts the same with `RELEASE_INDEX_URL` and `ruUrl('bioc-release', 'edgeR')`.
      ClustIRR's summary contains `ClustIRR (bioc) is propagated at 1.11.0 (seeded from Bioconductor, never gated`.
      SEMPLR's summary contains `r-universe builds 1.1.2: status success.`
- [ ] #20 ux-r0-2: the `edgr` not_found message ends with
      `Did you mean: edge, edgeR? To check release, call again with universe 'bioc-release'.`
      A new test calls `{ package: 'edgr', universe: 'bioc-release' }` with inline 404 routes for
      `ruUrl('bioc-release', 'edgr')`. Its message contains
      `To check devel, call again with universe 'bioc'.`
- [ ] #20 ux-r0-3: a new test overrides `ruUrl('bioc', 'trackViewer')` with the recorded
      trackViewer record, with `Version` set to `'1.49.4'` (read the fixture, edit the JSON,
      serve it inline with no `last-modified`). It asserts `behind: true`, exactly one
      `behind_reasons` entry, and that the entry contains
      `POST https://bioc-registry.seandavi.workers.dev/gate` and
      `https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#post-gate`. The summary
      contains `Upstream 1.49.4 is newer than propagated 1.49.3. r-universe shows no failure for 1.49.4, so the gate's reason is not visible here; see behind_reasons.`
      The Chromatograms summary does not contain `shows no failure`.
- [ ] #20 code-r0-5: `expect(() => historySql('bioc', "a'b")).toThrow()`. The exact-query test
      still passes.
- [ ] #20 code-r0-4: `grep -n "type Upstream\b" src/core/pkg/status.ts` finds nothing, and
      `type UpstreamState` exists (`npm run typecheck` passes).
- [ ] #28 ux-r0-3: in the trackViewer test every `data.upstream.jobs[].job` is a string matching
      `/^[1-9][0-9]*$/`, and the first one is `'109690330754'`. RMassBank's
      `newer_commit_failed.job.job` is a string. The existing URL assertions
      (`` `${build_url}/job/${job.job}` ``) still pass.

**package-name (#20 ux-r0-4, security-r0-2)**

- [ ] The invalid-name test in `status.test.ts` (`"a'b"`, `'1abc'`, `'edgeR.'`) asserts the
      message contains `must start with a letter, contain only letters, digits and '.', and not end with '.'`.
- [ ] Every existing `closeMatches` test passes unchanged. A new test
      `closeMatches('Bioc', ['BiocParallel', 'Biobase'])` returns `['BiocParallel']`: the prefix
      match survives the length filter (length difference 8), and `Biobase` (length difference 3,
      not a prefix) is skipped.
- [ ] A new test: `closeMatches('a'.repeat(100), names)`, with `names` 3,000 distinct short
      strings, returns `[]`. It shows that a long query against a large candidate list is
      handled; the length filter is what keeps it cheap.

**pkg_check_output (#28)**

- [ ] ux-r0-5, parser: in `check-log.test.ts`, for yarn, GeneGA and the synthetic logs,
      `text.slice(section.offset)` starts with the first body line of each section. For a section
      whose header is the last line with no trailing newline, `offset === text.length`.
- [ ] ux-r0-5, marker: the `fitSectionText` tests pass a body offset (e.g. `100`), and their
      expected markers read `[… n lines omitted; read them with full=true and offset=<o> …]`.
      In head-and-tail cases `<o>` is `100 + body[0].length + 1 + body[1].length + 1`; when only
      the marker remains, `<o>` is `100`.
- [ ] ux-r0-5, end to end (singIST, `95858209718`): with `full` the normalized `00check.log`,
      `full.slice(section.offset)` starts with the section's first body line. The marker's
      `offset=(\d+)` value `o` satisfies `full.slice(o).startsWith(lines[2])`. A second call
      `{ universe: 'bioc', job: '95858209718', full: true, offset: o }` returns `data.text.text`
      starting with `lines[2]`.
- [ ] ux-r0-5: the GeneGA test's summary assertion becomes
      `Some output was cut to fit; each cut section's marker gives the offset to read it with full=true.`
- [ ] security-r0-1: a new `parseCheckLog` test, with vitest option `{ timeout: 1000 }`, parses
      `'* checking examples ... ERROR\nbody\n* ' + ' ... ['.repeat(40_000) + '\nStatus: 1 ERROR\n'`.
      It returns exactly one section (`checking examples`, text `body`) and status `Status: 1 ERROR`.
      Without the cap this takes about 4 s (extrapolated from the measurements above).
- [ ] security-r0-2: a new test serves a job with 45 files (with `pkgdata.txt` and no
      `00check.log`) inline and asks for the default file. The `not_found` message lists 40 names,
      then ` and 5 more. Pass one of them as file.` The existing
      `file %j is not_found, lists the files…` and DeepTarget tests still pass. DeepTarget's
      message ends with `Its files: 00BiocCheck.log, output.log. Pass one of them as file.`
- [ ] ux-r0-2: `pkgCheckOutput.description` contains `pass file='output.log' for BiocCheck's results`.
      The `file` input's description in `/api/openapi.json` (or the zod schema's description)
      contains `bioc-checks jobs have no 00check.log`.
- [ ] code-r0-2: the size-budget test asserts `expect(total).toBeLessThanOrEqual(2500)`, with the
      comment `the first budget (4500) did not fit, so the loop stepped down`.
- [ ] ux-r0-8, ux-r0-7: `PkgCheckOutputDataSchema` has descriptions on `text.total_chars`,
      `files_total` and `job_url` (a test reads `z.toJSONSchema(PkgCheckOutputDataSchema)` and
      checks those three `description`s are set).
- [ ] ux-r1-1: the three test names read
      `a job the registry has not captured is not_found, with the capture explanation`
      (check-output.test.ts), `pkg_check_output on a job the registry has not captured is isError not_found:`
      and `a job the registry has not captured is 404 not_found` (transports/pkg.test.ts).
      `grep -rn "never captured" test src` finds nothing.

**pkg_build_environment (#28 ux-r0-4)**

- [ ] For job `96299707840` with `dependencies: ['biomart', 'HTTR2', 'biomaRt']`, `data.deps`
      equals
      `[{ package: 'biomart', version: null, did_you_mean: ['biomaRt'] }, { package: 'HTTR2', version: null, did_you_mean: ['httr2'] }, { package: 'biomaRt', version: '2.69.0', did_you_mean: [] }]`.
      The summary contains `biomart not installed (did you mean biomaRt?)`.
- [ ] The existing 'unknown names get version null…' test is updated with a `did_you_mean` on
      every entry (empty for found names; for `notAPackage`, `constructor` and `toString`,
      whatever `closeMatches` gives against the fixture, asserted exactly). Its
      `notAPackage not installed` assertion still holds.
- [ ] `PkgBuildEnvironmentDataSchema`'s `job_url` description says it is the same page as
      `pkg_status`'s `jobs[].url`.

**pkg_release_info, pkg_downloads (#24)**

- [ ] code-r0-1: a test asserts `PkgReleaseInfoDataSchema.shape.agree.description` contains
      `packages/release and packages/devel symlinks`. ux-r0-3: the `manifest.build` field has a
      description (via `z.toJSONSchema`).
- [ ] code-r0-2: the 2025 test asserts
      `sources` `[{ url: statsPageUrl('bioc', 'edgeR'), as_of: AS_OF }, { url: statsTabUrl('bioc', 'edgeR', 2025), as_of: AS_OF }]`.
      The January test asserts the same with year 2026. The rnaseqGene test asserts
      `sources` `[{ url: statsPageUrl('workflows', 'rnaseqGene'), as_of: AS_OF }, { url: statsTabUrl('workflows', 'rnaseqGene', 2026), as_of: AS_OF }]`,
      `year_requested: null`, `note: null`, `total: { distinct_ips: 2690, downloads: 4730 }`,
      `years_available` equal to 2014 through 2026,
      `months[0]` `{ month: 'Jan', distinct_ips: 43, downloads: 74 }` and `months.at(-1)`
      `{ month: 'Oct', distinct_ips: 514, downloads: 789 }`.
- [ ] ux-r0-2: a new test serves the edgeR page with `href="edgeR_2010_stats.tab"` replaced by
      `href="#"` and requests `year: 2010`. It is `not_found` with exactly
      `edgeR (bioc) has no download stats for 2010; years with stats: 2009, 2011–2026.` and
      fetches only the page. The existing 2027 test still expects `2009–2026`.
- [ ] code-r0-3: Spec #8's Files list contains `isoDate()`, `readBiocFixture()` and `NOT_FOUND`
      (checked by reading the diff, not by a test).

**Whole PR**

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.
- [ ] Every fixture-scenario size test (`every fixture scenario fits the limit`, SEMPLR) still
      passes under `MAX_RESULT_BYTES`.
- [ ] The PR body has the outcome table from Goal and says `Closes #44`. It also says that #20,
      #24 and #28 can be closed, with code-r0-1 (#20) and main-1 (#28) moved to the upstream
      bundle.

## Test plan

- Unit: `test/core/pkg/package-name.test.ts` (length filter, prefix kept),
  `test/core/pkg/check-log.test.ts` (section offsets, marker offsets, long-line cap),
  `test/core/pkg/status.test.ts`, `check-output.test.ts`, `build-environment.test.ts`,
  `release-info.test.ts` and `downloads.test.ts`, as in Acceptance criteria.
- Transport: `test/transports/pkg.test.ts`. Only the two test names change. The existing
  MCP-equals-REST tests cover the new `offset`, `did_you_mean` and string `job` fields in both
  transports. The "a job id passed as a number is rejected" test stays.
- Every test uses `fixtureFetch` with existing fixtures or inline edits. Nothing touches the
  network, and `test/no-network.test.ts` keeps passing.
- Run `npm test`, `npm run typecheck`, `npm run build`.

## Risks

- **`job` changes type in the `pkg_status` output.** A client that reads `jobs[].job` as a number
  breaks. The REST API is documented as unstable until v1, and the two tools that consume the
  value take a string, so the change removes the mismatch #28 ux-r0-3 reports. The PR body calls
  it out as a breaking output change.
- **Envelope size.** `offset` adds about 16 bytes per section (12 at most), and the marker grows
  by about 20 bytes. The budget loop in `pkg_check_output` absorbs both. `did_you_mean` adds
  `"did_you_mean":[]` (about 18 bytes) per dependency, plus up to 3 names for each unknown one.
  50 realistic names stay well under 8 KB (today's three-dependency envelope is 940 bytes). 50
  near-100-character names could already exceed it, and still get `result_too_large`, as today.
- **`historySql` throws a `ZodError` on misuse.** That is deliberate (a programmer error, reported
  as `internal_error`). No caller passes an unvalidated name.
- **`/gate` URL and docs link.** Both are absolute and verified today. If bioc-registry renames
  the route or the docs heading, the reason text goes stale. No test fetches them.
- **The header-length cap** assumes step headers stay under 1,000 characters. The longest one in
  the fixtures is well under 300. A longer real header would no longer open a section, and its
  text would read as body of nothing. That is the same as a header the regex does not match
  today.
