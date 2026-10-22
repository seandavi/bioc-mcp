# Spec #7: `pkg_check_output` and `pkg_build_environment`

Issue: [seandavi/bioc-mcp#7](https://github.com/seandavi/bioc-mcp/issues/7).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md). Builds on [spec #6](6-pkg-status.md) (`pkg` module,
`registryUpstream`, `UNIVERSES`, `PackageNameSchema`) and the scaffold ([#2](2-scaffold.md),
[#15](15-scaffold-followups.md)).

Every upstream shape below was checked on 2026-10-22 against the live endpoints
`https://bioc-registry.seandavi.workers.dev/checks/{universe}/{job}` and `/builds/{universe}/{job}`,
the registry's `/openapi.json` and [`docs/api.md`](https://github.com/seandavi/bioc-registry/blob/main/docs/api.md).
I probed 220 `/checks` jobs (154 random bioc jobs across configs and verdicts, plus targeted
ones) and 154 `/builds` jobs. Notes marked **Verified** record behaviour the implementer must
account for. No new npm package is needed.

## Goal

Two `pkg` capabilities over the registry's captured job artifacts. Both take a GitHub Actions job id
from `pkg_status` (`data.upstream.jobs[].job`):

- **`pkg_check_output`** answers "why did this check fail?". By default it returns only the ERROR,
  WARNING and NOTE sections of R CMD check's `00check.log`, the check's `Status:` line, and
  the list of the job's other captured files. Any file's full text is available on explicit
  request (`full=true`), one page per call.
- **`pkg_build_environment`** answers "what did this job run with?": the image (pinned by
  digest for containers), the package repositories, the number of installed dependencies and,
  on request, the exact versions of named dependencies.

A job the registry never captured gives `not_found`, and the message says that such jobs stay
404 permanently.

## Non-goals

- The `triage-failing-package` prompt (#10), `pkg_release_info` and `pkg_downloads` (#8).
- The registry's `/logs/{universe}/{job}` (the runner's raw GitHub Actions log, up to 9 MB).
- Section parsing for any file other than `00check.log`. BiocCheck's `output.log` and
  `00BiocCheck.log`, `00install.out`, `*.Rout(.fail)` and `build.log` get the tail view
  (see [Views](#views)). The tail of `output.log` already holds BiocCheck's results line.
- Fixing the registry's stalled capture (see [Risks](#risks)), and any change to
  `src/upstreams/http.ts`, `src/upstreams/cache.ts`, `src/envelope.ts` or the transports.
- A longer cache TTL for the immutable `/checks` and `/builds` responses (see [Risks](#risks)).

## Decisions beyond the issue text

The issue does not settle these. Each is decided here, and the reviewer can strike any of them:

1. **`universe` is required** on both tools. The issue's signature gives `file` a default and
   `universe` none, while the proposal writes `pkg_status(package, universe="bioc")`. A job id
   belongs to exactly one universe (**Verified:** bioc-release job `91650205691` is 404 under
   `bioc`), so a silent default would turn a wrong guess into a misleading "not captured".
2. **`job` is a string of digits**, `^[1-9][0-9]{0,19}$`, as in the issue ("validated as
   digits") and the registry's own OpenAPI (`type: string, pattern: ^\d+$`). `pkg_status`
   emits `job` as a number, so an MCP client that passes the number unquoted gets
   `invalid_input` and has to retry. The field description gives a quoted example.
3. **A `file` the job lacks is `not_found`** (REST 404), and the message lists the job's files.
   This covers the default `00check.log` on `bioc-checks` and `source` jobs, which have none.
4. **Tail view.** With `full=false`, files other than `00check.log` return their last page
   instead of nothing. Install logs, `.Rout.fail` transcripts and BiocCheck's `output.log` end
   with the failure.
5. **`job_info` from `pkgdata.txt`.** A job id is opaque, so the result names the package,
   version, target and r-universe's verdict, read from the job's own `pkgdata.txt`.
6. **`pkg_build_environment` takes `dependencies`**, an optional list of package names whose
   installed version to report. Returning every dep would not fit: **Verified:** up to 380 deps,
   7.4 KB of JSON in the raw manifest. The registry docs call `deps` the record that makes a
   failure reproducible, so dropping it would leave the tool with only image and repos.

## Design

### Files

```
src/upstreams/registry.ts            getCheckFiles(), getBuildManifest(), BuildManifestSchema,
                                     BuildManifest; registryUpstream.description updated
src/core/pkg/job.ts                  NEW  JobIdSchema, jobUrl()
src/core/pkg/check-log.ts            NEW  pure text helpers: normalizeText, jsonTextBytes,
                                     parseCheckLog, fitSectionText, selectSections, textPage,
                                     tailPage, parseJobInfo, and their types/constants
src/core/pkg/check-output.ts         NEW  pkgCheckOutput capability, PkgCheckOutputDataSchema
src/core/pkg/build-environment.ts    NEW  pkgBuildEnvironment capability, PkgBuildEnvironmentDataSchema
src/core/pkg/status.ts               description: cross-reference the two new tools
src/core/pkg/index.ts                capabilities: [pkgStatus, pkgCheckOutput, pkgBuildEnvironment]
test/support/pkg-routes.ts           add check/build fixture routes and URL helpers
test/core/pkg/job.test.ts            NEW
test/core/pkg/check-log.test.ts      NEW
test/core/pkg/check-output.test.ts   NEW
test/core/pkg/build-environment.test.ts NEW
test/upstreams/registry.test.ts      add getCheckFiles / getBuildManifest cases
test/transports/pkg.test.ts          tool lists, REST↔MCP equality, errors for the new tools
test/fixtures/registry/checks/{bioc,bioc-release}/<job>.json   NEW (see Fixtures)
test/fixtures/registry/builds/{bioc,bioc-release}/<job>.json   NEW
```

Import zod as `import * as z from 'zod'`. Build every path with `pathSegment()` for `universe` and
`job`, and fetch only through `fetchUpstreamJson`. `file` and `dependencies` are never put into
a URL. They are only looked up as keys in the parsed response, with `Object.hasOwn`.

### `src/upstreams/registry.ts` (additions)

`registryUpstream` stays one object (id `registry`, TTL 300 s, timeout 15 s), now used by all
three pkg tools. Only its `description` changes:

```ts
description:
  'bioc-registry: the propagation index (which package versions passed the gate or were seeded), ' +
  'build observations, and captured per-job R CMD check output and build manifests, for the bioc ' +
  '(devel) and bioc-release universes.',
```

#### Check files

```ts
export interface CheckFiles {
  response: UpstreamResponse; // for sourceFor()
  files: Record<string, string>; // basename → file text, exactly as JSON.parse returned it
}

/** GET checks/{universe}/{job}. 404 → not_found explaining capture. */
export async function getCheckFiles(deps: Deps, universe: Universe, job: string): Promise<CheckFiles>;
```

Behaviour:

1. `path = \`checks/${pathSegment(universe)}/${pathSegment(job)}\``, then `fetchUpstreamJson(deps, registryUpstream, path)`.
2. A `CapabilityError` with code `not_found` is rethrown as `not_found` with the same `details`
   and this message (`jobUrl` from `src/core/pkg/job.ts`):

   ```
   The registry has no captured check output for ${universe} job ${job}. It captures each job's
   check artifact once, walking forward from when capture was switched on, and r-universe deletes
   artifacts after about 100 days, so a job that capture missed stays unavailable. Check that the
   universe is the one the job id came from in pkg_status. The job's GitHub Actions page is ${jobUrl(universe, job)}.
   ```

   (One line in code; wrapped here.) Other errors propagate unchanged.
3. Shape check without zod (so a `__proto__` key stays an own data property): `json` must be a
   plain object (`typeof json === 'object' && json !== null && !Array.isArray(json)`) whose own
   values (`Object.values`) are all strings. Otherwise throw
   `CapabilityError('upstream_error', \`${registryUpstream.name} returned check output for job ${job} that is not an object of file texts\`, { upstream: 'registry', url: response.url })`.
4. Return `{ response, files: json as Record<string, string> }`.

**Verified:**
- Content-type is `application/json`. A 200 is served `cache-control: public, max-age=31536000, immutable`
  with **no `Last-Modified`**, so `as_of` is the fetch time.
- The 404 body is JSON:
  `{"error":"not captured","detail":"capture walks forward from when it was switched on; artifacts expire upstream at ~100 days","job":"https://github.com/r-universe/bioc/runs/<job>"}`,
  served `no-store`. `fetchUpstream` never reads it.
- Keys are basenames. In 154 random captured bioc jobs: `00check.log`, `00install.out` and
  `pkgdata.txt` on all 154, `{pkg}-Ex.Rout` on 152, `testthat.Rout` 74, `testthat.Rout.fail` 21,
  and per-package test transcripts (`runTests.Rout`, `limma-Tests.Rout`,
  `test_gaBinaryT1.Rout`, …). At most 11 keys. `bioc-checks` jobs have only
  `00BiocCheck.log` and `output.log`. `source` jobs have only `pkgdata.txt`. `wasm-release` jobs
  have `build.log` and `pkgdata.txt`.
- Sizes: `00check.log` is 2.7–38 KB (median 3.7 KB). `{pkg}-Ex.Rout` reaches 1.6 MB and
  `00BiocCheck.log` 2.5 MB, so one response can be several MB.
- 59 of 154 logs (Windows) use CRLF line endings. Some files contain ANSI colour escapes.
  The longest single line seen is 34,896 characters (a `-Ex.Rout`).
- Jobs whose r-universe verdict is `FAIL`/`FAILURE` were 404 in every case probed (no artifact).

#### Build manifest

```ts
export const BuildManifestSchema = z.object({
  image: z.string().nullish(),
  repos: z.array(z.string()).nullish(),
  deps: z.record(z.string(), z.string()).nullish(), // package → resolved version
});
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

/** GET builds/{universe}/{job}. 404 → not_found explaining capture. */
export async function getBuildManifest(
  deps: Deps,
  universe: Universe,
  job: string,
): Promise<{ response: UpstreamResponse; manifest: BuildManifest }>;
```

Behaviour:

1. `path = \`builds/${pathSegment(universe)}/${pathSegment(job)}\``, then `fetchUpstreamJson`.
2. Rethrow `not_found` with the same `details` and this message:

   ```
   The registry has no build manifest for ${universe} job ${job}. Manifests are parsed from the job
   log, which the registry captures once, walking forward from when capture was switched on; a job
   that capture missed never gets one. Check that the universe is the one the job id came from in
   pkg_status. The job's GitHub Actions page is ${jobUrl(universe, job)}.
   ```
3. `BuildManifestSchema.safeParse(json)` fails →
   `CapabilityError('upstream_error', \`${registryUpstream.name} returned a build manifest for job ${job} with an unexpected shape\`, { upstream: 'registry', url: response.url })`.
   Look up `deps` entries with `Object.hasOwn` on `manifest.deps`. Do not walk the prototype.

**Verified:** all 148 manifests had exactly `image`, `repos`, `deps`. `image` takes three forms:

- `ghcr.io/r-universe-org/base-image@sha256:<64 hex>`, or `ghcr.io/r-universe-org/build-source@sha256:…`
  for `source` jobs;
- `macos-15-arm64@20260727.0256.1` or `macos-15@…`;
- `windows-2025-vs2026@…` or `windows-11-arm64@…`.

`repos` has 0–4 entries and can include p3m's moving `https://p3m.dev/all/__linux__/resolute/latest`
or `https://p3m.dev/cran/latest`. `deps` has 0–380 entries. Every value is a dotted or dashed
version. The 404 body is JSON
(`{"error":"not captured","detail":"derived from the job log, so it exists only where /logs does","log":"/logs/bioc/<job>"}`),
and no `Last-Modified` is sent on 200.

### `src/core/pkg/job.ts`

```ts
/** GitHub Actions job id: digits, no leading zero. */
export const JobIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, 'Job ids are digits, e.g. "96299707840"')
  .describe('GitHub Actions job id from pkg_status (upstream.jobs[].job), as a string of digits, e.g. "96299707840"');

/** The job's GitHub page. GitHub resolves /runs/{job} without the run id. Built, never fetched. */
export function jobUrl(universe: Universe, job: string): string {
  return `https://github.com/r-universe/${universe}/runs/${job}`;
}
```

**Verified:** `https://github.com/r-universe/bioc/runs/117752915543` answers 200. The registry's own
404 body uses the same form.

### `src/core/pkg/check-log.ts`

Pure functions with no I/O. Every size below is a **JSON text size**:

```ts
/** UTF-8 bytes `s` occupies inside a JSON string: encode(JSON.stringify(s)).length - 2. */
export function jsonTextBytes(s: string): number;
```

(Escapes count, so `\n` is 2 bytes, a control character 6, and `‘` 3.)

#### Normalisation

```ts
/** CRLF/CR → LF, then strip ANSI CSI sequences. All offsets and lengths refer to this text. */
export function normalizeText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
```

#### R CMD check parser

```ts
export const SECTION_VERDICTS = ['ERROR', 'WARNING', 'NOTE'] as const;
export type SectionVerdict = (typeof SECTION_VERDICTS)[number];

export interface CheckSection {
  check: string; // e.g. 'checking examples', 'checking whether package ‘h5mread’ can be installed'
  verdict: SectionVerdict;
  text: string; // body lines joined with '\n', trailing empty lines removed
}

export interface ParsedCheckLog {
  status: string | null; // 'Status: 1 ERROR, 2 NOTEs'; null if absent
  errors: number | null; // null iff status is null
  warnings: number | null;
  notes: number | null;
  sections: CheckSection[]; // log order
}

export function parseCheckLog(text: string): ParsedCheckLog; // text already normalized
```

Algorithm:

1. `lines = text.split('\n')`.
2. `HEADER = /^\* (.+?) \.\.\.(?: \[[^\]]*\])? (OK|NOTE|WARNING|ERROR|SKIPPED|INFO|NONE)$/`.
3. Walk the lines. A line that starts with `'* '` or matches `/^Status: /` closes the current
   section. If such a line matches `HEADER` with a verdict in `SECTION_VERDICTS`, it opens a new
   section with `check = m[1]` and `verdict = m[2]`. Any other line is appended to the open
   section's body, if one is open.
4. Section `text = body.join('\n').replace(/\n+$/, '')`.
5. `status` is the **last** line matching `/^Status: /`, trimmed. If present,
   `errors = Number(/(\d+) ERRORs?\b/.exec(status)?.[1] ?? 0)`, and likewise `WARNINGs?` and
   `NOTEs?`. `Status: OK` gives three zeros. If absent, all four are null.

**Verified** on 154 logs (plus 6 targeted): every step's verdict is on its own `* ` line, never on
a later line. The only `* ` lines without a verdict are the preamble (`* using …`, `* this is
package …`, `* R was compiled by`, `* checking extension type ... Package`) and `* DONE`. Each
log has exactly one `Status:` line. The timing bracket appears as `... [12s/16s] ERROR`.

#### Fitting sections into the budget

```ts
export const SECTION_MAX_BYTES = 2000; // per-section cap
export const MAX_SECTIONS = 12;
export const SECTION_BUDGETS = [4500, 2500, 1000, 0] as const; // tried in order, see Handler

export interface FittedSection extends CheckSection { truncated: boolean }

/** Cut `text` to at most `maxBytes` (jsonTextBytes). */
export function fitSectionText(text: string, maxBytes: number): { text: string; truncated: boolean };

/** Choose up to MAX_SECTIONS by severity, fit their text into `budget`, return them in log order. */
export function selectSections(
  sections: CheckSection[],
  budget: number,
): { sections: FittedSection[]; omitted: number };
```

`fitSectionText(text, max)`:

1. `jsonTextBytes(text) <= max` → `{ text, truncated: false }`.
2. `lines = text.split('\n')`, `head = lines.slice(0, 2)`, `rest = lines.slice(2)`.
   `marker(n) = \`[… ${n} lines omitted; read them with full=true …]\``.
3. Find the largest `k` (0 ≤ k < rest.length) such that
   `jsonTextBytes([...head, marker(rest.length - k), ...rest.slice(rest.length - k)].join('\n')) <= max`.
   If such a `k` exists, return that text with `truncated: true`. The head names the failing
   example or test, and the tail holds the error and backtrace.
4. Otherwise, return `marker(lines.length)` if it fits `max`, else `''`, with `truncated: true`.

`selectSections(sections, budget)`:

1. Rank `ERROR = 0`, `WARNING = 1`, `NOTE = 2`. Order the indices by `(rank, index)`. The first
   `MAX_SECTIONS` are **chosen**, and `omitted = sections.length - chosen.length`.
2. `remaining = budget`. For each chosen section in that order:
   `allowance = Math.min(SECTION_MAX_BYTES, remaining)`, then `fitted = fitSectionText(text, allowance)`
   and `remaining -= jsonTextBytes(fitted.text)`.
3. Return the chosen sections in log order with `{ check, verdict, text, truncated }`.

#### Text pages

```ts
export const PAGE_BUDGETS = [5500, 3500, 1500] as const; // tried in order, see Handler

export interface TextPage {
  offset: number; // start, in UTF-16 code units of the normalized text
  next_offset: number | null; // where the next page starts; null at end of file
  total_chars: number; // normalized text length
  text: string;
}

/** Page starting at `offset`. Caller validates offset (see Handler). */
export function textPage(text: string, offset: number, budget: number): TextPage;

/** Last page of `text` (next_offset is always null). */
export function tailPage(text: string, budget: number): TextPage;
```

`textPage(text, offset, budget)`:

1. `end` = the largest `e` in `[offset, min(text.length, offset + budget)]` with
   `jsonTextBytes(text.slice(offset, e)) <= budget` (binary search; size grows with `e`).
2. If `end < text.length` and `text.charCodeAt(end - 1)` is a high surrogate (0xD800–0xDBFF),
   `end -= 1`.
3. If `end < text.length`, let `nl = text.lastIndexOf('\n', end - 1)`. If
   `nl + 1 > offset + Math.floor((end - offset) / 2)`, set `end = nl + 1`, so the page ends after a
   newline unless that would discard more than half of it.
4. If `end === offset` and `offset < text.length` (cannot happen with the budgets above, since one
   code unit costs at most 6 JSON bytes), set `end = offset + 2` when `offset` holds a high
   surrogate followed by a low one, else `end = offset + 1`.
5. Return `{ offset, next_offset: end < text.length ? end : null, total_chars: text.length, text: text.slice(offset, end) }`.

`tailPage(text, budget)`:

1. `start` = the smallest `s` in `[max(0, text.length - budget), text.length]` with
   `jsonTextBytes(text.slice(s)) <= budget`.
2. If `start < text.length` and `text.charCodeAt(start)` is a low surrogate (0xDC00–0xDFFF), `start += 1`.
3. If `start > 0`, let `nl = text.indexOf('\n', start)`. If `nl !== -1` and
   `nl + 1 - start <= Math.floor((text.length - start) / 2)`, set `start = nl + 1`, so the page
   starts at a line.
4. Return `{ offset: start, next_offset: null, total_chars: text.length, text: text.slice(start) }`.

#### `pkgdata.txt`

```ts
export interface JobInfo {
  package: string | null;
  version: string | null;
  target: string | null; // 'linux' | 'macos' | 'windows' | 'source' | 'wasm' as observed
  job_status: string | null; // r-universe: 'success' | 'failure'
  check_status: string | null; // r-universe's verdict for this job: OK/NOTE/WARNING/ERROR
}

export function parseJobInfo(raw: string): JobInfo;
```

Each line of `normalizeText(raw)` matching `/^([A-Z_]+)=(.*)$/` sets `key → value`, and one pair
of surrounding single quotes is stripped from the value. Empty values become null. `target =
TARGET`, `job_status = JOB_STATUS`, `check_status = CHECKSTATUS`. `package` and `version` come
from `FILE` matching
`/^([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])_([0-9]+(?:[.-][0-9]+)*)(?:_R_[^/]*)?\.(?:tar\.gz|tgz|zip)$/`.
If `FILE` is missing or does not match, both are null.

**Verified:** all 190 observed `pkgdata.txt` have `JOB_STATUS, DISTRO, FILE, TARGET, CHECKSTATUS,
STOREDATE`, and every `FILE` matches the regex. Examples: `yarn_1.39.0_R_x86_64-pc-linux-gnu.tar.gz`,
`pwalign_1.9.1.zip`, `S4Vectors_0.51.6.tgz`, `PCAtools_2.25.0.tar.gz`. `CHECKSTATUS` is `''`
on `source` and `wasm` jobs.

### `src/core/pkg/check-output.ts`

#### Input

```ts
const UniverseOfJobSchema = z
  .enum(UNIVERSES)
  .describe("Universe the job id came from: 'bioc' (devel) or 'bioc-release'");

input: z.object({
  universe: UniverseOfJobSchema,
  job: JobIdSchema,
  file: z
    .string()
    .min(1)
    .max(255)
    .default('00check.log')
    .describe("Captured file to read, by basename (default '00check.log'); the result lists the job's files"),
  full: z
    .boolean()
    .default(false)
    .describe("true: return the file's text one page (~5 KB) at a time instead of the failing sections or tail"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("With full=true: character offset to start at; pass the previous page's text.next_offset"),
}),
```

`UniverseOfJobSchema` is exported from `job.ts` and shared with `pkg_build_environment`.
**Verified:** `validateRegistry` accepts this schema and the `pkg_build_environment` one, and
`queryToInput` turns `?universe=bioc&job=96299707840&full=true&offset=10&dependencies=biomaRt&dependencies=httr2`
into the typed input. `job: 96299707840` (a number) and `'0123'` are rejected. I checked this with
a throwaway script against the current tree.

#### Data (output) schema

```ts
const JobInfoSchema = z.object({
  package: z.string().nullable(),
  version: z.string().nullable(),
  target: z.string().nullable().describe("'linux', 'macos', 'windows', 'source' or 'wasm'"),
  job_status: z.string().nullable().describe("r-universe's job result, 'success' or 'failure'"),
  check_status: z.string().nullable().describe("r-universe's check verdict for this job"),
});

const CheckSectionSchema = z.object({
  check: z.string().describe("The R CMD check step, e.g. 'checking examples'"),
  verdict: z.enum(SECTION_VERDICTS),
  text: z.string().describe('What R CMD check printed under this step'),
  truncated: z.boolean().describe('true if lines were cut to fit the size limit; full=true reads them'),
});

const TextPageSchema = z.object({
  offset: z.number().int().describe('Character offset of this page in the file (CRLF → LF, ANSI colour codes removed)'),
  next_offset: z.number().int().nullable().describe('Pass as offset with full=true for the next page; null at end of file'),
  total_chars: z.number().int(),
  text: z.string(),
});

export const PkgCheckOutputDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  job: z.string(),
  job_url: z.string().describe('GitHub Actions job page'),
  job_info: JobInfoSchema.nullable().describe("From the job's pkgdata.txt; null on bioc-checks jobs, which have none"),
  file: z.string(),
  view: z
    .enum(['sections', 'tail', 'page'])
    .describe("'sections': 00check.log's ERROR/WARNING/NOTE steps; 'tail': the end of another file; 'page': full=true"),
  check: z
    .object({
      status: z.string().nullable().describe("R CMD check's summary line, e.g. 'Status: 1 ERROR, 2 NOTEs'; null if the check did not finish"),
      errors: z.number().int().nullable(),
      warnings: z.number().int().nullable(),
      notes: z.number().int().nullable(),
      sections: z.array(CheckSectionSchema).describe('ERROR, WARNING and NOTE steps, in log order'),
      sections_omitted: z.number().int().describe(`Steps left out beyond the ${MAX_SECTIONS} most severe`),
    })
    .nullable()
    .describe("Set when view is 'sections'"),
  text: TextPageSchema.nullable().describe("Set when view is 'tail' or 'page'"),
  files: z.array(z.string()).describe("The job's captured files, sorted, at most 40"),
  files_total: z.number().int(),
});
```

#### Handler

```ts
async handler({ universe, job, file, full, offset }, deps) {
  if (!full && offset > 0) throw new CapabilityError('invalid_input', 'offset is used only with full=true');
  const { response, files } = await getCheckFiles(deps, universe, job);
  const names = Object.keys(files).sort(); // code-unit order
  if (!Object.hasOwn(files, file)) {
    throw new CapabilityError('not_found', `${universe} job ${job} has no file "${file}". Its files: ${names.join(', ')}.`);
  }
  const text = normalizeText(files[file]);
  if (full && offset > 0 && offset >= text.length) {
    throw new CapabilityError('invalid_input', `offset ${offset} is past the end of ${file} (${text.length} characters)`);
  }
  const job_info = Object.hasOwn(files, 'pkgdata.txt') ? parseJobInfo(files['pkgdata.txt']) : null;
  // build(budget) → Envelope; try each budget in turn
}
```

- `view = full ? 'page' : file === '00check.log' ? 'sections' : 'tail'`.
- **sections:** `parsed = parseCheckLog(text)` is computed once. For each `budget` in
  `SECTION_BUDGETS`, `selectSections(parsed.sections, budget)` gives `check = { status, errors,
  warnings, notes, sections, sections_omitted }` and `text: null`.
- **tail:** for each `budget` in `PAGE_BUDGETS`, `text = tailPage(text, budget)` and `check: null`.
- **page:** for each `budget` in `PAGE_BUDGETS`, `text = textPage(text, offset, budget)` and `check: null`.
- `files = names.slice(0, 40)`, `files_total = names.length`.
- **Budget loop:** build the envelope with each budget in order and return the first whose
  `envelopeBytes(envelope) <= MAX_RESULT_BYTES`. If none fits, return the last one, and
  `assertEnvelopeSize` in `invokeCapability` turns it into `result_too_large`. The first budget
  fits in every recorded fixture; the loop is a guard against unusually long names or headers.
- `sources: [sourceFor(response)]`.

#### Summary (the MCP text content)

`subject` is `` `${package}${version ? ' ' + version : ''} ${universe} job ${job}${target ? ` (${target})` : ''}` ``
when `job_info?.package` is set, else `` `${universe} job ${job}` ``. Join the applicable
sentences with `' '`:

1. View:
   - sections: `` `${subject}, 00check.log: ${status ?? 'no Status line, so the check did not finish'}.` ``.
     Then, if there are sections, `` `Sections: ${first five as `${check} (${verdict})` joined '; '}${n > 5 ? ` and ${n - 5} more` : ''}.` ``
     If any section is truncated or `sections_omitted > 0`, add
     `'Some output was cut to fit; read the whole log with full=true.'`
   - tail: if `offset === 0`, `` `${subject}, ${file}: all ${total_chars} characters.` ``.
     Otherwise `` `${subject}, ${file}: the last ${total_chars - offset} of ${total_chars} characters; read from the start with full=true.` ``
   - page: `` `${subject}, ${file}: characters ${offset}–${offset + text.length} of ${total_chars}.` ``
     followed by `` ` Next page: offset=${next_offset}.` `` or `' End of file.'`.
2. `` `Files: ${files.join(', ')}${files_total > files.length ? ` and ${files_total - files.length} more` : ''}.` ``

#### Capability

```ts
export const pkgCheckOutput = defineCapability({
  module: 'pkg',
  name: 'pkg_check_output',
  title: 'R CMD check output for one build job',
  description:
    "Why an r-universe check failed: the ERROR, WARNING and NOTE sections of R CMD check's 00check.log " +
    "for one GitHub Actions job, the check's Status line, and the job's other captured files " +
    '(00install.out, <pkg>-Ex.Rout, testthat.Rout.fail, 00BiocCheck.log, output.log, …). Get the job id ' +
    'and universe from pkg_status (upstream.jobs[].job). Other files return their last ~5 KB; full=true ' +
    'returns any file one page at a time (offset). Only jobs the registry captured are available; ' +
    'others are not_found permanently. For the image and dependency versions the job ran with, use ' +
    'pkg_build_environment.',
  input,
  data: PkgCheckOutputDataSchema,
  handler,
});
```

### `src/core/pkg/build-environment.ts`

#### Input

```ts
input: z.object({
  universe: UniverseOfJobSchema,
  job: JobIdSchema,
  dependencies: z
    .array(PackageNameSchema)
    .max(50)
    .default([])
    .describe('Dependency package names whose installed version to report (up to 50), e.g. ["biomaRt", "httr2"]'),
}),
```

REST carries the array as repeated parameters: `?dependencies=biomaRt&dependencies=httr2`.

#### Data (output) schema

```ts
export const PkgBuildEnvironmentDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  job: z.string(),
  job_url: z.string().describe('GitHub Actions job page'),
  image: z
    .string()
    .nullable()
    .describe('Container image pinned by digest (Linux configs), or the GitHub-hosted runner image and version (macOS, Windows)'),
  digest: z
    .string()
    .nullable()
    .describe("The image's sha256 digest; null for runner images, which have none"),
  repos: z.array(z.string()).describe('Repositories dependencies were resolved from, in the order the build used'),
  moving_repos: z
    .array(z.string())
    .describe("Repos that are moving snapshots (p3m '.../latest'), which pin nothing by themselves"),
  deps_count: z.number().int().describe('How many dependencies the build installed'),
  deps: z
    .array(z.object({ package: z.string(), version: z.string().nullable() }))
    .describe('The requested dependencies in request order (duplicates removed); version null if the build did not install it'),
});
```

#### Shaping rules

- `image = manifest.image ?? null`. `digest = /@(sha256:[0-9a-f]{64})$/.exec(image ?? '')?.[1] ?? null`.
- `repos = manifest.repos ?? []`. `moving_repos = repos.filter((r) => /\/latest\/?$/.test(r))`.
- `depsMap = manifest.deps ?? {}`. `deps_count = Object.keys(depsMap).length`.
- `deps`: unique names from `dependencies`, first occurrence order. Each gives
  `{ package, version: Object.hasOwn(depsMap, package) ? depsMap[package] : null }`.
- `sources: [sourceFor(response)]`.

#### Summary

Join with `' '`:

1. Image:
   - `digest` set: `` `${universe} job ${job} ran in container ${image}.` ``
   - image set, no digest: `` `${universe} job ${job} ran on runner image ${image} (no container digest).` ``
   - no image: `` `${universe} job ${job}: the build manifest records no image.` ``
2. `` `It installed ${deps_count} dependencies from ${repos.length} repositories.` ``
3. If `moving_repos` is non-empty: `` `${moving_repos.join(', ')} ${moving_repos.length === 1 ? 'is a moving snapshot' : 'are moving snapshots'}; the dependency versions are the record of what it served.` ``
4. If `deps` is non-empty: `` `Versions: ${first ten as `${package} ${version ?? 'not installed'}` joined ', '}${n > 10 ? ` and ${n - 10} more` : ''}.` ``
   If `deps` is empty and `deps_count > 0`: `'Pass dependencies to see installed versions.'`

#### Capability

```ts
export const pkgBuildEnvironment = defineCapability({
  module: 'pkg',
  name: 'pkg_build_environment',
  title: 'Build environment of one build job',
  description:
    'What one r-universe build job ran with: the container image pinned by digest (or the GitHub-hosted ' +
    'runner image for macOS and Windows), the repositories it resolved dependencies from, how many it ' +
    'installed, and the exact installed versions of the dependencies you name. Use it when a check broke ' +
    'without the package changing. Get the job id and universe from pkg_status (upstream.jobs[].job). Only ' +
    "jobs whose log the registry captured are available. For the check's output, use pkg_check_output.",
  input,
  data: PkgBuildEnvironmentDataSchema,
  handler,
});
```

### `src/core/pkg/status.ts` and `index.ts`

- In `pkg_status`'s description, replace `'Does not read check logs, download counts or release schedules.'`
  with `'For why a job failed, pass its job id to pkg_check_output; for what it ran with, to ' + 'pkg_build_environment. Does not read download counts or release schedules.'`.
  Update any test that pins the old text.
- `pkgModule.capabilities = [pkgStatus, pkgCheckOutput, pkgBuildEnvironment]`. `upstreams` is
  unchanged: the registry is already listed.

### Transports

No code changes. The scaffold derives them:

- **MCP:** tools `pkg_check_output` and `pkg_build_environment` on `/mcp` and `/mcp/pkg`.
- **REST:** `GET /api/v1/pkg/check_output?universe=bioc&job=96299707840[&file=…&full=true&offset=N]`
  and `GET /api/v1/pkg/build_environment?universe=bioc&job=96299707840[&dependencies=biomaRt&dependencies=httr2]`.
  Each body is the same envelope MCP returns as `structuredContent`.

### Upstream calls

| Call | Example URL | Cache | `as_of` |
|---|---|---|---|
| Check output | `https://bioc-registry.seandavi.workers.dev/checks/bioc/96299707840` | 300 s (`registry`) | fetch time (no `Last-Modified`) |
| Build manifest | `https://bioc-registry.seandavi.workers.dev/builds/bioc-release/91650205691` | 300 s | fetch time |

Links built but never fetched: `https://github.com/r-universe/{universe}/runs/{job}`.

### Fixtures

The registry serves these files as immutable. They are committed as `jq -c` output, which
compacts the formatting and leaves every key and value unchanged. One file is trimmed, as noted.

```bash
B=https://bioc-registry.seandavi.workers.dev
F=test/fixtures/registry
mkdir -p $F/checks/bioc $F/checks/bioc-release $F/builds/bioc $F/builds/bioc-release
for j in 96299707840 91456856197 91651624908 91484882071 91902836490; do
  curl -sf $B/checks/bioc/$j | jq -c . > $F/checks/bioc/$j.json
done
# singIST-Ex.Rout alone is 759 KB; drop it, the 00check.log is what the test needs
curl -sf $B/checks/bioc/95858209718 | jq -c 'del(."singIST-Ex.Rout")' > $F/checks/bioc/95858209718.json
curl -sf $B/checks/bioc-release/91650205691 | jq -c . > $F/checks/bioc-release/91650205691.json
for j in 96299707840 95292180484; do curl -sf $B/builds/bioc/$j | jq -c . > $F/builds/bioc/$j.json; done
curl -sf $B/builds/bioc-release/91650205691 | jq -c . > $F/builds/bioc-release/91650205691.json
```

Each 404 is an inline route that returns the registry's own body. The adapter never reads it.

```ts
{ status: 404, headers: { 'content-type': 'application/json' },
  body: '{"error":"not captured","detail":"capture walks forward from when it was switched on; artifacts expire upstream at ~100 days","job":"https://github.com/r-universe/bioc/runs/112702240220"}' }
```

Scenarios as observed on 2026-10-22:

| Scenario | Universe / job | Observed |
|---|---|---|
| Failing check excerpt | bioc `96299707840` | yarn 1.39.0, linux-devel-x86_64 (target `linux`, job_status `failure`, check_status `ERROR`). `Status: 1 ERROR`. One section: `checking examples` ERROR, 36 lines, 1,558 bytes, ending `Execution halted` after `HTTP 405 Method Not Allowed` from biomaRt. Files: `00check.log, 00install.out, pkgdata.txt, testthat.Rout, yarn-Ex.Rout` |
| Passing check, CRLF | bioc `91456856197` | ADAPT 1.7.0, windows-devel-arm64. `Status: OK`, no sections. CRLF throughout |
| Severity budget | bioc `91651624908` | GeneGA 1.63.1, macos-oldrel-arm64. `Status: 1 ERROR, 2 WARNINGs, 5 NOTEs`. 8 sections; `checking R code for possible problems` NOTE is 2,817 bytes, so it is truncated at 2,000. The ERROR section is not cut (723 bytes) |
| Huge ERROR section | bioc `95858209718` (trimmed) | singIST 1.1.1. `Status: 1 ERROR`. `checking examples` is 996 lines and 36,378 bytes. It is truncated to the 2 head lines, the marker, and a tail ending `Execution halted` |
| Tail and paging | bioc `91484882071`, file `testthat.Rout.fail` | stJoincount 1.15.0. The file is 6,146 characters (6,909 JSON bytes): the tail view starts at `offset > 0`, and `full=true` reads it in two pages |
| No `00check.log` | bioc `91902836490` | DeepTarget, bioc-checks. Files `00BiocCheck.log, output.log`, no `pkgdata.txt`. The default file gives `not_found` listing both. `file=output.log` gives the whole file as tail (4,371 characters, offset 0), including `✖ 1 ERRORS  \| ⚠ 0 WARNINGS  \| ℹ 6 NOTES` |
| Release universe | bioc-release `91650205691` | scTreeViz, linux-release-x86_64. `Status: 1 WARNING, 1 NOTE` |
| Not captured | bioc `112702240220` (inline 404) | Chromatograms' current failing `source` job |
| Wrong universe | bioc `91650205691` (inline 404) | The release job asked under `bioc` |
| Build, container | bioc `96299707840` | `ghcr.io/r-universe-org/base-image@sha256:5cb77d52…6847`; repos `bioc.r-universe.dev`, `cran.r-universe.dev`; 174 deps; `biomaRt 2.69.0`, `httr2 1.3.0` |
| Build, runner, largest | bioc `95292180484` | scGraphVerse, macos-oldrel-arm64. `macos-15-arm64@20260727.0256.1`, 4 repos, 380 deps |
| Build, moving repo | bioc-release `91650205691` | container digest; repos include `https://p3m.dev/all/__linux__/resolute/latest`; 274 deps; `shiny 1.14.0` |
| Build not captured | bioc `112702240220` (inline 404) | |

`test/support/pkg-routes.ts` adds `checksUrl(universe, job)` and `buildsUrl(universe, job)` and
puts all the routes above into `pkgRoutes`. The existing `pkg_status` tests keep working
because `fixtureFetch` only matches exact URLs.

## Acceptance criteria

- [ ] `pkg_check_output` and `pkg_build_environment` are registered in module `pkg`, and
      `validateRegistry(modules)` passes on the production list.
- [ ] `/mcp/pkg` lists exactly `['pkg_status', 'pkg_check_output', 'pkg_build_environment']`
      (in that order). `GET /api/v1/about` lists the three tools for `pkg`.
- [ ] REST `GET /api/v1/pkg/check_output?universe=bioc&job=96299707840` returns 200, and its body
      deep-equals the MCP `structuredContent` for the same input. The same holds for
      `/api/v1/pkg/build_environment?universe=bioc&job=96299707840&dependencies=biomaRt&dependencies=httr2`.
- [ ] **`job` validated as digits:** `abc`, `0123`, `1e5`, `-1`, `12 3`, `../1`, `1/2`, `''` and a
      21-digit id each give REST 400 `invalid_input`, with `fetch.calls` empty. A missing
      `universe` and `universe=cran` give 400. MCP rejects `job: 96299707840` given as a number.
- [ ] **`file` validated against the returned keys:** `file=../00check.log`, `file=constructor`,
      `file=__proto__` and `file=00check.log/x` give `not_found` (REST 404) and list the job's
      files. The only upstream URL requested is the `/checks` URL for that job, so `file`
      never reaches a URL.
- [ ] **Failing check excerpt** (yarn): `view === 'sections'`, `check.status === 'Status: 1 ERROR'`,
      `errors === 1`, one section `{ check: 'checking examples', verdict: 'ERROR', truncated: false }`
      whose text ends with `Execution halted`. `job_info` is
      `{ package: 'yarn', version: '1.39.0', target: 'linux', job_status: 'failure', check_status: 'ERROR' }`,
      `files` has 5 names, and the summary contains `Status: 1 ERROR` and `checking examples (ERROR)`.
- [ ] **Passing check** (ADAPT, CRLF): `check.status === 'Status: OK'`, the counts are all 0,
      `sections` is `[]`, and no `\r` appears anywhere in the envelope.
- [ ] **Truncation:** in GeneGA, the 5 NOTE, 2 WARNING and 1 ERROR sections stay in log order,
      only the 2,817-byte NOTE is `truncated`, and the summary says output was cut. In singIST,
      the ERROR text starts with its first 2 lines, contains `lines omitted; read them with full=true`,
      ends with `Execution halted`, and is ≤ 2,000 JSON bytes.
- [ ] **404 job:** `112702240220` gives REST 404 `not_found` whose message contains
      `has no captured check output`, `stays unavailable` and
      `https://github.com/r-universe/bioc/runs/112702240220`. MCP returns `isError` with text
      starting `not_found:`. `pkg_build_environment` on the same job gives `not_found` mentioning
      `build manifest`.
- [ ] Tail and paging (stJoincount `testthat.Rout.fail`): the tail page has `offset > 0`,
      `next_offset === null` and ends with the file's last character. `full=true` pages chain
      (`page2.offset === page1.next_offset`) and their concatenation equals the normalized file.
      `full=false&offset=5` gives 400, and `full=true&offset=<total_chars>` gives 400.
- [ ] Build environment: the yarn job gives `digest` starting `sha256:5cb77d52`, `deps_count: 174`
      and `deps: [{ package: 'biomaRt', version: '2.69.0' }, { package: 'httr2', version: '1.3.0' }]`.
      scGraphVerse gives `digest: null`, `image: 'macos-15-arm64@20260727.0256.1'` and
      `deps_count: 380`, and its envelope does not contain the dep list. The bioc-release job
      gives a `moving_repos` entry and the summary says so. An unknown dependency name gives
      `version: null`, and duplicates are removed.
- [ ] Every success returns one source, the registry URL, with `as_of` = fetch time (the test clock).
- [ ] Every fixture scenario's envelope is under 8,192 bytes (`envelopeBytes`). The PR reports
      the largest. A synthetic test pins the budget loop: a log with 15 long sections and 40
      long file names still fits under 8,192, at a smaller budget.
- [ ] Upstream shape errors: `/checks` returning an array, or an object with a non-string
      value, gives `upstream_error`. `/builds` with `deps: []` gives `upstream_error`. A 500
      gives `upstream_error`.
- [ ] The `pkg_status` description names both new tools.
- [ ] `npm test` and `npm run typecheck` pass, and `npm run build` succeeds.

## Test plan

All tests run in Node with `fixtureFetch` and `createMemoryCache`. No network.

- `test/core/pkg/job.test.ts`: the `JobIdSchema` accept/reject table from the acceptance list,
  and `jobUrl`.
- `test/core/pkg/check-log.test.ts`:
  - `jsonTextBytes`: `'a'` → 1, `'\n'` → 2, `'‘'` → 3, `'\u0001'` → 6.
  - `normalizeText`: CRLF, lone CR, and an ANSI sequence (`'\x1b[1m✖\x1b[22m'` → `'✖'`).
  - `parseCheckLog`: the yarn, GeneGA and ADAPT fixtures' `00check.log`, with exact sections
    and counts. A synthetic log without a `Status:` line gives all-null counts. A synthetic
    `* checking extension type ... Package` line closes an open section. `[12s/16s]` timings
    are parsed. `Status: 2 ERRORs, 1 WARNING, 3 NOTEs` → 2/1/3.
  - `fitSectionText`: fits unchanged; head + marker + tail (exact output pinned for a
    10-line body at a small max); marker only; `''` when even the marker does not fit.
  - `selectSections`: severity allocation on GeneGA at budget 4500; a 15-section synthetic gives
    12 sections and `omitted: 3`, with ERRORs kept before NOTEs; budget 0 leaves every text
    `'[… n lines omitted …]'` or `''`, all `truncated`.
  - `textPage`/`tailPage`: line-boundary preference; no split surrogate pair (`'😀'` at the
    boundary); a line longer than the budget is split mid-line; the end-of-file `next_offset` is
    null; a page of control characters respects the byte budget.
  - `parseJobInfo`: the linux-binary, zip, tgz and source forms; `CHECKSTATUS=''` → null; a
    `FILE` that does not match gives null package and version.
- `test/core/pkg/check-output.test.ts`: one test per check scenario row through
  `invokeCapability(pkgCheckOutput, input, deps)`, plus the file-validation and offset errors.
- `test/core/pkg/build-environment.test.ts`: the build rows, `dependencies` deduplication and
  ordering, unknown names, and the summary for each image form and for moving repos.
- `test/upstreams/registry.test.ts`: `getCheckFiles` and `getBuildManifest` for 200, 404
  (message and `details.status === 404`), 500, wrong shapes, and a cache hit (second call: no
  fetch).
- `test/transports/pkg.test.ts`: tools/list on `/mcp/pkg`, REST↔MCP equality for both tools,
  the REST 400 and 404 bodies, the MCP `not_found:` text, the repeated `dependencies` query
  parameter, and `/api/v1/about` listing three pkg tools.

## Risks

- **Registry capture is stalled, so live calls 404 for current jobs.** On 2026-10-22,
  `data/state/bioc/checkcursor` was `96895555778` and `bioc-release/checkcursor` was
  `96802466029`, while current r-universe job ids are about `1.12e11`–`1.18e11`. Every current
  job I tried (Chromatograms, trackViewer, ClustIRR; 8 job-id quantiles of the last 60
  observations) returned 404 on `/checks`, `/builds` and `/logs`, even though `logcursor` reads
  `119810708576`. Jobs up to about `9.69e10` are captured. The yarn fixture's log, at `9.63e10`, is dated
  2026-08-20. The tools
  are built correctly against what the registry serves, but until the registry's capture
  (`captureChecks`/`captureLogs`, or its `GITHUB_TOKEN`) is fixed, they answer `not_found` for
  every job that `pkg_status` returns today. This needs an issue on seandavi/bioc-registry. I
  did not file one (outside this spec's scope). Fixtures use older captured jobs. The 404
  message says "stays unavailable" rather than promising a later capture.
- **`job` as a string vs `pkg_status`'s numeric job.** An MCP client that copies the number
  unquoted is rejected once. The description and error message show the quoted form.
- **Text-only MCP clients.** The scaffold sends `summary` as the text content and the excerpt
  only in `structuredContent`. A client that ignores `structuredContent` sees section names
  and the status line, but not the section text. This applies to every tool and belongs to the
  transport, not to this issue.
- **Large responses.** One `/checks` response can be several MB (a 1.6 MB `-Ex.Rout`, a 2.5 MB
  `00BiocCheck.log`). It is parsed once per call, and the Cache API holds the body for 300 s.
  CPU for `JSON.parse` of 2.5 MB plus `normalizeText` of the selected file is unmeasured in the
  Worker. The PR reports a Node timing for the 822 KB singIST response.
- **TTL.** `/checks` and `/builds` are immutable, so a long TTL would be safe. Raising it means
  a second upstream id with the same base URL, or a per-call TTL, which is out of scope.
- **Heuristic tail.** For files without a parser, the last ~5 KB is a guess at where the
  failure is. `full=true` always reaches the rest.
- **Upstream strings in output.** Log text is returned as data and never interpreted. ANSI
  sequences are stripped. The only URL this server builds is `jobUrl` from the validated
  universe enum and digit-only job.
