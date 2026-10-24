# Spec #55: `pkg_legacy_status`, the legacy BBS report per package, side by side with the registry

Issue: [seandavi/bioc-mcp#55](https://github.com/seandavi/bioc-mcp/issues/55), part of #48 (tester
feedback). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Size discipline", "Every result carries provenance", and "Out of v0: SQL": DuckDB is too heavy
for a Worker, so history questions get a ready-to-run query that the server does not execute).
Conventions: [AGENTS.md](../../AGENTS.md). Builds on the `pkg` module ([spec #6](6-pkg-status.md),
[spec #52](52-revdeps.md) for `SharedLoads`).

Every upstream shape below was checked on 2026-10-24 against the live endpoints. Notes marked
**Verified** record what the implementer must account for. No new npm package is needed.

## Goal

The tester said that for any package only one half of the comparison is visible: "BBS says OK,
the registry says blocked on mac" should be one answer.

This spec adds one `pkg` capability:

- **`pkg_legacy_status(package, universe?)`** returns what the legacy Bioconductor Build System
  (BBS, `https://bioconductor.org/checkResults/`) reports for the package in its latest devel or
  release report:
  - each build machine's stage verdicts (INSTALL, BUILD, CHECK, BUILD BIN) with log links;
  - the version and commit BBS built;
  - BBS's propagation outcome.

  Beside that it gives the registry's propagated version and the platform families that passed
  its gate. A per-family comparison names where the two disagree. It also returns a DuckDB query
  over the BiocBuildDB archive for the package's BBS history. The server does not run that query.

### Why a separate tool and not a `legacy` block in `pkg_status`

The issue leaves this to the spec, with the 8 KB budget in mind.

- **Size.** `pkg_status` already carries 10 to 16 r-universe jobs, about 1.7 to 2.9 KB of `jobs`
  alone on the recorded fixtures (SEMPLR, ClustIRR, edgeR), plus the propagated artifacts,
  `newer_commit_failed`, `behind_reasons` and `history_sql`. A legacy block is about 1.5 to 3 KB:
  3 to 5 nodes × 4 stages, propagation rows and URLs. Together they would come close to 8,192
  bytes on the largest packages, and `assertEnvelopeSize` would then fail the whole call.
  **Verified (2026-10-24):** the live `pkg_status` result for `SEMPLR` is 5,526 bytes
  (`curl -s 'https://bioc-mcp.seandavi.workers.dev/api/v1/pkg/status?package=SEMPLR' | wc -c`),
  `ClustIRR` 4,941, `edgeR` 4,918. A prototype legacy block for `SEMPLR` (3 nodes, 2 propagation
  rows) was about 909 bytes of JSON, its six BBS sources about 749 bytes and its summary about
  270 bytes, so `pkg_status` would reach about 7.4 KB, about 740 bytes under the limit.
- **Failure isolation.** The legacy block needs four to seven extra bioconductor.org requests.
  Inside `pkg_status`, a bioconductor.org outage would either fail every `pkg_status` call or
  need a partial-result path that the codebase does not have.
- **Retirement.** BBS is being retired in favour of r-universe. A separate tool can be removed
  without changing `pkg_status`'s schema.

The separate tool still answers in one call. It reads the registry entry itself (the propagation
index that `pkg_status` already memoizes) and compares per platform family.

### Why the live BBS files and not BiocBuildDB's parquet at runtime

The issue comment names seandavi/BiocBuildDB as the source, and lists its options as Range reads
with row-group pruning, or a new small object published by BiocBuildDB. **Verified (2026-10-24,
DuckDB 1.5.6 `parquet_metadata`):**

- `build_summary.parquet` is 249,932,490 bytes in 128 row groups of 22k to 125k rows. **Every row
  group's `package` statistics span `ABSSeq` to `zlibbioc`.** The file is not clustered by
  package, so Range reads cannot prune by package. A per-package read touches every row group.
- `propagation_status.parquet` (2,396,560 bytes, 3,633,198 rows, 30 row groups) has the columns
  `package, process, propagate, report_md5` only. It has no date, BioC version or build. The only
  link to a report is `report_md5`, which the other published tables (`build_summary`, `info`)
  carry, and they are 249 MB and 10.5 MB. No reports table is published (S3 listing of
  `parquet/` shows three keys). So the latest devel propagation outcome cannot be picked from
  this file alone.

Reading the archive at runtime therefore needs a BiocBuildDB-side change (a per-package or
latest-snapshot object). That needs a human and is out of this issue's scope; see Risks. The
current state the tester asked about is published by BBS itself, in small text files next to
each report (see Upstream calls). BiocBuildDB still serves the history: `history_sql` is a DuckDB
query over `build_summary.parquet`. **Verified:** the query below runs in the DuckDB CLI in
about 1.7 s over HTTPS. DuckDB autoloads `httpfs` for `https://` paths. The table has rows from
2021-10-14 to 2026-10-23 for software, data-experiment, workflow and book packages.

## Non-goals

- **r-universe build state.** That is `pkg_status`. This tool reads only the propagation-index
  entry from the registry.
- **BBS history at runtime.** Only the latest report is read. History is the returned query. The
  BiocBuildDB gap (no runs from 2026-06-13 to 2026-10-22) is stated in the `history_sql`
  description.
- **Annotation packages and long tests.** BBS builds no annotation repository.
  `bioc-longtests-LATEST` has no `PROPAGATION_STATUS_DB.txt` and is not consulted.
- **Log contents.** The tool links each failing stage's log page and does not fetch it.
- **The BioC version number** (e.g. 3.24). The report is named `devel` or `release`.
  `pkg_release_info` gives the numbers.
- **Maintainer names or e-mail addresses.** `info.dcf` carries both. They are never read into
  the result, and the recorded fixtures drop those lines.
- **Changes to the triage prompt, `src/upstreams/http.ts`, `cache.ts`, `shared-load.ts`,
  `src/envelope.ts` or the transports.**
- **An MCP prompt or resource.**

## Design

### Files

```
src/upstreams/bbs.ts                    NEW  BBS_REPORTS, BbsReport, BBS_BUILDS, BbsBuild, BBS_BASE_PATH,
                                             bbsReportPath(), bbsPackagePath(), bbsStageUrl(),
                                             parseBuildStatusDb(), parsePropagationStatusDb(),
                                             parseBbsInfoDcf(), bbsCommitTime(), bbsNodeInfoPath(), parseBbsNodeInfo(),
                                             getBbsBuildStatus(), getBbsPropagationStatus(),
                                             getBbsPackageInfo(), getBbsNodeInfo(), and the interfaces below
src/upstreams/bioconductor.ts           bioconductorUpstream.description mentions the BBS check reports
src/core/pkg/legacy-status.ts           NEW  pkgLegacyStatus, PkgLegacyStatusDataSchema, BIOCBUILDDB_BUILD_SUMMARY_URL,
                                             legacyHistorySql(), osFamily(), nodeVerdict(), familyVerdict()
src/core/pkg/status.ts                  export ORIGIN_PASSED_GATE and originLabel (unchanged bodies);
                                             one sentence added to pkg_status's description
src/core/pkg/index.ts                   capabilities: pkgLegacyStatus right after pkgStatus; new description
README.md                               "What is live today": one row after pkg_status; one example question
test/support/bbs-routes.ts              NEW  BBS_BASE, bbsUrl(), bbsRoutes
test/upstreams/bbs.test.ts              NEW
test/core/pkg/legacy-status.test.ts     NEW
test/transports/pkg.test.ts             tools lists, REST/MCP equality, 404 body, about tool list; testApp routes += bbsRoutes
test/transports/text-content.test.ts    CALLS row; call() routes += bbsRoutes
test/fixtures/bioconductor/checkResults/**   NEW (recorded, trimmed; see Fixtures)
test/fixtures/registry/prop/bioc/index-2026-10-24.json  NEW (live devel index trimmed to Chromatograms, affxparser; see Fixtures)
```

Import zod as `import * as z from 'zod'`. Fetch only through `fetchUpstream`. The only
caller-supplied value in a URL is the package name, and it always goes through `pathSegment()`.
Node and stage names come from the upstream file and go through `pathSegment()` too.

### `src/upstreams/bbs.ts`

It uses the existing `bioconductorUpstream` (`https://bioconductor.org/`, TTL 3600 s, default
10 s timeout, default 2 MiB cap). It imports `bioconductorUpstream` from `./bioconductor`,
`PackageNameSchema` from `./package-name`, `SharedLoads` from `./shared-load`, and `Universe`
(type only) from `./registry`. It imports nothing from `../core/` except types (enforced by
`test/upstreams/imports.test.ts`).

```ts
/** BBS names its reports by branch: universe 'bioc' is the devel report, 'bioc-release' the release one. */
export const BBS_REPORTS = { bioc: 'devel', 'bioc-release': 'release' } as const satisfies Record<Universe, string>;
export type BbsReport = (typeof BBS_REPORTS)[Universe]; // 'devel' | 'release'

/** BBS builds with a propagation file, in search order; software first. */
export const BBS_BUILDS = ['bioc', 'data-experiment', 'workflows', 'books'] as const;
export type BbsBuild = (typeof BBS_BUILDS)[number];

export const BBS_BASE_PATH = 'checkResults/';

/** 'checkResults/{report}/{build}-LATEST/'; report and build are constants. */
export function bbsReportPath(report: BbsReport, build: BbsBuild): string;

/** bbsReportPath + pathSegment(name) + '/': the package's report page. */
export function bbsPackagePath(report: BbsReport, build: BbsBuild, name: string): string;

/** Absolute URL of a stage's log page: {package page}{pathSegment(`${node}-${stage}.html`)}. Built, never fetched. */
export function bbsStageUrl(report: BbsReport, build: BbsBuild, name: string, node: string, stage: string): string;

/** bbsReportPath + pathSegment(`${node}-NodeInfo.html`): the build machine's page, shared by every package. */
export function bbsNodeInfoPath(report: BbsReport, build: BbsBuild, node: string): string;

export interface BbsStageResult {
  node: string; // e.g. 'nebbiolo2'
  stage: string; // 'install' | 'buildsrc' | 'checksrc' | 'buildbin' as observed; not enforced
  status: string; // 'OK' | 'WARNINGS' | 'ERROR' | 'TIMEOUT' | 'skipped' | 'NA' as observed; not enforced
}

export interface BbsBuildStatus {
  response: UpstreamResponseMeta; // for sourceFor(); the body is dropped once parsed
  packages: ReadonlyMap<string, readonly BbsStageResult[]>; // package → its lines, in file order
}

export interface BbsPropagation {
  target: string; // 'source', 'mac.binary.big-sur-x86_64', … as observed
  status: string; // 'YES' | 'NO' | 'UNNEEDED' as observed; not enforced
  reason: string | null; // text after ', ', e.g. "same version is already published"
}

export interface BbsPropagationStatus {
  response: UpstreamResponseMeta;
  packages: ReadonlyMap<string, readonly BbsPropagation[]>; // package → its lines, in file order
}

export interface BbsPackageInfo {
  response: UpstreamResponseMeta;
  version: string;
  commit: { id: string; time: string | null; branch: string | null } | null;
}

export interface BbsNodeSpec {
  os: string; // e.g. 'Linux (Ubuntu 24.04.4 LTS)', 'macOS 12.7.6 Monterey'
  arch: string; // e.g. 'x86_64', 'aarch64'
}

export interface BbsNodeInfo {
  response: UpstreamResponseMeta;
  spec: BbsNodeSpec | null; // null when the page names another host or lacks OS or Arch
}

export function parseBuildStatusDb(body: string, url: string): Map<string, BbsStageResult[]>;
export function parsePropagationStatusDb(body: string, url: string): Map<string, BbsPropagation[]>;
export function parseBbsInfoDcf(body: string, name: string, url: string): Pick<BbsPackageInfo, 'version' | 'commit'>;
export function bbsCommitTime(value: string): string | null;
export function parseBbsNodeInfo(html: string, node: string): BbsNodeSpec | null;

export function getBbsBuildStatus(deps: Deps, report: BbsReport, build: BbsBuild): Promise<BbsBuildStatus>;
export function getBbsPropagationStatus(deps: Deps, report: BbsReport, build: BbsBuild): Promise<BbsPropagationStatus>;
export function getBbsPackageInfo(deps: Deps, report: BbsReport, build: BbsBuild, name: string): Promise<BbsPackageInfo | undefined>;
export function getBbsNodeInfo(deps: Deps, report: BbsReport, build: BbsBuild, node: string): Promise<BbsNodeInfo | undefined>;
```

Every `upstream_error` below is
`new CapabilityError('upstream_error', <message>, { upstream: bioconductorUpstream.id, url })`.

**`parseBuildStatusDb`.** The body is split on `/\r?\n/`. Blank lines (`/^\s*$/`) are skipped.
Every other line must match
`/^([A-Za-z][A-Za-z0-9.]*)#([A-Za-z0-9_.-]+)#([A-Za-z]+): (\S+)$/`, which captures package, node,
stage and status. Any other line is upstream_error,
`bioconductor.org returned a BBS build status file in an unexpected format (${url})`. So is a
repeated `package#node#stage`. Lines are appended to `packages.get(package)` in file order.
**Verified:**

- devel bioc has 24,681 lines, 2,472 packages, nodes `nebbiolo2`, `lconway` and `taishan`, and
  stages `install`, `buildsrc`, `checksrc` and `buildbin` (buildbin on `lconway` only).
- release bioc has 14,499 lines and nodes `nebbiolo1` and `kunpeng2`.
- Statuses seen are `OK`, `WARNINGS`, `ERROR`, `TIMEOUT`, `skipped` and `NA` (release `kunpeng2`
  checksrc, e.g. `xcms`).
- Every line of the devel and release bioc and data-experiment files matches the regex. There
  are no duplicate keys.

**`parsePropagationStatusDb`.** The same splitting. Each non-blank line must match
`/^([A-Za-z][A-Za-z0-9.]*)#([^#\s]+)#propagate: ([A-Za-z]+)(?:, (.+))?$/`, which captures package,
target, status and reason (`reason` is `null` when group 4 is absent). Any other line is
upstream_error, `… a BBS propagation status file in an unexpected format (${url})`. **Verified
(devel and release bioc):** statuses `UNNEEDED, same version is already published` (6,529),
`YES` (37) and `NO, package depends on '<pkg>' which is not available` (15). The targets are
`source` and `mac.binary.big-sur-x86_64`. A package that failed to build has no line (e.g.
`RMassBank`, `biomaRt` in devel).

**`parseBbsInfoDcf`.** This parses one stanza of `Field: value` lines (`/^([^\s:]+):(.*)$/s`, value
trimmed). Continuation lines (starting with a space or tab) belong to the previous field and are
ignored. A blank line followed by another field line, or any other line, is upstream_error,
`… a BBS info.dcf in an unexpected format (${url})`. The first occurrence of a field wins. Rules:

- `Package` must equal `name`, else upstream_error,
  `bioconductor.org returned info.dcf for "${Package}" at ${url}, expected "${name}"`.
- `Version` must match `/^\d+([.-]\d+)*$/`, else upstream_error (unexpected format).
- `commit` is `null` unless `git_last_commit` matches `/^[0-9a-f]{7,40}$/`. Otherwise it is
  `{ id, time: bbsCommitTime(git_last_commit_date ?? ''), branch: git_branch ?? null }`
  (`git_branch` is `null` when empty).
- `Maintainer` and `MaintainerEmail` are never read.

**`bbsCommitTime`.** The input looks like `'2026-04-28 08:35:24 -0400 (Tue, 28 Apr 2026)'`. It
matches `/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})\b/` and returns
`` `${date}T${time}${sign}${hh}:${mm}` ``, here `'2026-04-28T08:35:24-04:00'`. It returns `null`
when the input does not match or when `Date.parse` of the result is `NaN`.

**`parseBbsNodeInfo`.** This reads three fields from a build machine's `{node}-NodeInfo.html`
page. Each field is group 1 of the first match of one of three literal regexes:

- `/<TD><B>Hostname:(?:&nbsp;|\s)*<\/B><\/TD>\s*<TD>([\s\S]*?)<\/TD>/i`;
- the same with `OS:` in place of `Hostname:`;
- the same with `Arch:`.

Each value goes through `cellText`:

- remove tags (`/<[^>]*>/g`);
- replace `&nbsp;` with a space;
- decode `&amp;`, `&lt;`, `&gt;` and `&quot;`;
- collapse whitespace runs to one space, and trim.

The result is `{ os, arch }` when the Hostname text equals `node` and OS and Arch are non-empty.
Otherwise it is `null`. It never throws, because these specs only enrich the result. The markup
looks like `<TR><TD><B>OS:&nbsp;</B></TD><TD>Linux&nbsp;(Ubuntu&nbsp;24.04.4&nbsp;LTS)</TD></TR>`.
**Verified** on the devel and release bioc NodeInfo pages:

| Node | OS | Arch |
|---|---|---|
| `nebbiolo2` | `Linux (Ubuntu 24.04.4 LTS)` | `x86_64` |
| `lconway` | `macOS 12.7.6 Monterey` | `x86_64` |
| `taishan` | `Linux (openEuler 24.03 LTS)` | `aarch64` |
| `nebbiolo1` | `Linux (Ubuntu 24.04.4 LTS)` | `x86_64` |
| `kunpeng2` | `Linux (openEuler 24.03 LTS)` | `aarch64` |

The pages are 6.3 to 7.3 KB and hold no e-mail addresses. Each build has its own copy
(`devel/data-experiment-LATEST/nebbiolo2-NodeInfo.html` answers 200).

**Why NodeInfo pages and not the package page.** The package page also lists the machines, in a
`node_specs` table, but its size varies with the package: 9 KB for `a4`, 420 KB for `biomaRt`
and 517 KB for release `edgeR`. **Verified:** `BiocGenerics` is 2,602,968 bytes and
`S4Vectors` 4,151,198, both over the 2 MiB cap. They also carry other
people's names and e-mail addresses. A NodeInfo page is small, and every package of a build
shares it, so the Cache API serves it to all of them for an hour.

**`getBbsBuildStatus`.** Path: `bbsReportPath(report, build) + 'BUILD_STATUS_DB.txt'`. This is a
module-scope `SharedLoads<BbsBuildStatus>`, keyed by the absolute URL, with `what` set to
`'the BBS build status file'`. The devel bioc file is 771 KB, and the AGENTS.md rule puts parsed
bodies over a few hundred KB through `SharedLoads`. The loader:

1. Calls `fetchUpstream`. A `not_found` becomes upstream_error,
   `bioconductor.org has no BBS build status file at ${url}`. Other errors propagate.
2. Parses with `parseBuildStatusDb`. An empty map is upstream_error,
   `bioconductor.org returned a BBS build status file with no packages (${url})`. An empty file
   would make every package look absent.
3. Returns `{ response: <response without body>, packages }`.

**`getBbsPropagationStatus`.** Path: `bbsReportPath(report, build) + 'PROPAGATION_STATUS_DB.txt'`.
It works like `getBbsBuildStatus`, with its own `SharedLoads<BbsPropagationStatus>` and `what`
set to `'the BBS propagation status file'`. A 404 is upstream_error,
`bioconductor.org has no BBS propagation status file at ${url}`. An empty map is allowed.

**`getBbsPackageInfo`.** Path: `bbsPackagePath(report, build, name) + 'raw-results/info.dcf'`. This
is a plain `fetchUpstream` call (267 bytes), cached by the Cache API. A `not_found` returns
`undefined`. Other errors propagate. Otherwise it returns
`{ response: <without body>, ...parseBbsInfoDcf(body, name, response.url) }`.

**`getBbsNodeInfo`.** Path: `bbsNodeInfoPath(report, build, node)`. It is a plain `fetchUpstream`
call. A `not_found` returns `undefined`. Other errors propagate. Otherwise it returns
`{ response: <without body>, spec: parseBbsNodeInfo(body, node) }`.

**Verified:** stale files exist. `devel/data-experiment-LATEST/Fletcher2013a/` answers 200 with a
2026-09-10 snapshot, but the package is not in the current `BUILD_STATUS_DB.txt` or
`meat-index.dcf`. `release/bioc-LATEST/lconway-NodeInfo.html` answers 200, but release has no
`lconway` node. The capability fetches `info.dcf` only for a package listed in the build's
`BUILD_STATUS_DB.txt`, and NodeInfo pages only for nodes on that package's lines. So a stale
file is never reported.

### `src/core/pkg/legacy-status.ts`

```ts
export const BIOCBUILDDB_BUILD_SUMMARY_URL =
  'https://bioc-builddb-mirror.s3.amazonaws.com/parquet/build_summary.parquet';

export const PLATFORM_FAMILIES = ['linux', 'mac', 'win'] as const; // the registry's archs vocabulary
export type PlatformFamily = (typeof PLATFORM_FAMILIES)[number];

/** /^Linux/ → 'linux', /^(macOS|Mac OS X)/ → 'mac', /^Windows/ → 'win', anything else (or null) → null. */
export function osFamily(os: string | null): PlatformFamily | null;

/** 'failed' if any stage is ERROR or TIMEOUT; else 'ok' if every stage is OK or WARNINGS; else 'incomplete'. */
export function nodeVerdict(stages: readonly { status: string }[]): NodeVerdict;

/** null for no nodes; 'failed' if any node failed; else 'incomplete' if any is; else 'ok'. */
export function familyVerdict(verdicts: readonly NodeVerdict[]): NodeVerdict | null;

/** The history query; `name` must be a valid package name (PackageNameSchema.parse), so it holds no quote. */
export function legacyHistorySql(name: string): string;
```

`NodeVerdict` is `'ok' | 'failed' | 'incomplete'`. A node with zero stages is `'ok'` by the rule
above. It cannot occur, because a node exists only through a line.

`legacyHistorySql('edgeR')` is exactly:

```sql
SELECT startedat, node, stage, version, status
FROM 'https://bioc-builddb-mirror.s3.amazonaws.com/parquet/build_summary.parquet'
WHERE package = 'edgeR'
ORDER BY startedat DESC, node, stage
LIMIT 200
```

The lines are joined with `'\n'` and there is no trailing newline.

#### Schemas

```ts
const NodeVerdictSchema = z.enum(['ok', 'failed', 'incomplete']);
const FamilySchema = z.enum(PLATFORM_FAMILIES);

const BbsStageSchema = z.object({
  stage: z.string().describe(
    "'install' (R CMD INSTALL), 'buildsrc' (R CMD build), 'checksrc' (R CMD check) or 'buildbin' (binary build, Mac and Windows nodes)",
  ),
  status: z.string().describe(
    "BBS verdict as the report gives it: OK, WARNINGS, ERROR, TIMEOUT, skipped (an earlier stage failed) or NA (no result)",
  ),
  url: z.string().nullable().describe("The stage's log page on the BBS report; null when status is OK or skipped"),
});

const BbsNodeSchema = z.object({
  node: z.string().describe("BBS build machine, e.g. 'nebbiolo2'"),
  os: z.string().nullable().describe("Operating system as the report names it; null if the machine's NodeInfo page did not say"),
  arch: z.string().nullable(),
  family: FamilySchema.nullable().describe("Platform family, comparable with the registry's archs; null if the OS is unknown"),
  verdict: NodeVerdictSchema.describe(
    "'failed' if any stage is ERROR or TIMEOUT; 'ok' if every stage is OK or WARNINGS; otherwise 'incomplete'",
  ),
  stages: z.array(BbsStageSchema).describe('In report order'),
});

export const PkgLegacyStatusDataSchema = z.object({
  package: z.string(),
  universe: z.enum(UNIVERSES),
  legacy: z
    .object({
      report: z.enum(['devel', 'release']).describe("The BBS report read: 'devel' for universe bioc, 'release' for bioc-release"),
      build: z.enum(BBS_BUILDS).describe('The BBS build that lists the package (software, experiment data, workflows, books)'),
      version: z.string().nullable().describe("Version BBS built; null if the report's info.dcf is missing"),
      commit: z
        .object({
          id: z.string().describe('Short git SHA BBS built'),
          time: z.string().nullable().describe('Commit time, ISO 8601 with offset'),
          branch: z.string().nullable().describe("e.g. 'devel', 'RELEASE_3_23'"),
        })
        .nullable(),
      report_url: z.string().describe("The package's page on the BBS report"),
      as_of: z.string().describe("When this BBS report was published (BUILD_STATUS_DB.txt's Last-Modified), ISO 8601"),
      nodes: z.array(BbsNodeSchema).describe('One per build machine, in report order'),
      propagation: z
        .array(
          z.object({
            target: z.string().describe("'source' or a binary target such as 'mac.binary.big-sur-x86_64'"),
            status: z.string().describe('YES (propagated by this report), NO (blocked) or UNNEEDED (same version already published)'),
            reason: z.string().nullable(),
          }),
        )
        .describe('BBS propagation outcome per target; empty when BBS did not attempt it (the build failed)'),
    })
    .nullable()
    .describe("The latest BBS report for the package; null when none of the report's builds lists it"),
  registry: z
    .object({
      version: z.string(),
      origin: z.string().describe("'r-universe', 'bioc-build' or 'bioconductor' (seeded, never gated)"),
      passed_gate: z.boolean().nullable(),
      archs: z.array(z.string()).nullable().describe('Platform families that passed the gate; null on older entries'),
      propagated_at: z.string().describe("The index entry's ts, ISO 8601"),
    })
    .nullable()
    .describe('The propagation-index entry; null when the package is not in the index. For r-universe state use pkg_status'),
  comparison: z
    .array(
      z.object({
        family: FamilySchema,
        bbs_nodes: z.array(z.string()).describe('BBS machines of this family'),
        bbs_verdict: NodeVerdictSchema.nullable().describe(
          "Worst verdict of those machines (failed over incomplete over ok); null when BBS has no machine of this family",
        ),
        registry_passed: z
          .boolean()
          .nullable()
          .describe("Whether the registry's archs include this family; null when there is no entry, archs is unknown, or the entry was never gated (seeded)"),
      }),
    )
    .describe('Per platform family, in the order linux, mac, win; families neither side mentions are left out'),
  same_version: z
    .boolean()
    .nullable()
    .describe('true if BBS built the propagated version; null if either version is missing or unparseable'),
  history_sql: z.object({
    query: z.string().describe(
      "DuckDB SQL over BiocBuildDB's archive of BBS results (devel and release, all builds, since 2021-10; " +
        'no runs from 2026-06-13 to 2026-10-22): this package\'s stage history. version tells devel from release',
    ),
    parquet_url: z.string().describe('The public parquet file the query reads over HTTPS; run it in DuckDB. This server does not run it'),
  }),
});
```

#### Capability

```ts
export const pkgLegacyStatus = defineCapability({
  module: 'pkg',
  name: 'pkg_legacy_status',
  title: 'Legacy BBS report beside the registry',
  description:
    'What the legacy Bioconductor Build System (BBS, bioconductor.org/checkResults, being retired in favour of ' +
    "r-universe) reports for a package in its latest report: each build machine's INSTALL, BUILD, CHECK and " +
    'BUILD BIN verdicts with log links, the version and commit it built, and its propagation outcome, beside the ' +
    "registry's propagated version and the platform families that passed its gate, with the families where " +
    'BBS and the registry disagree. Returns a DuckDB query over the BiocBuildDB archive for BBS history (not ' +
    "executed). universe 'bioc' is devel (default), 'bioc-release' is release. Package names are " +
    'case-sensitive. For r-universe build and check state use pkg_status; for why an r-universe job failed ' +
    'use pkg_check_output.',
  input: z.object({
    package: PackageNameSchema,
    universe: z
      .enum(UNIVERSES)
      .default('bioc')
      .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
  }),
  data: PkgLegacyStatusDataSchema,
  handler, // below
});
```

The input is the same shape as `pkg_status`'s, so `validateRegistry` accepts it.

#### Handler

1. `report = BBS_REPORTS[universe]`.
2. In parallel:
   - `index = getPropagationIndex(deps, universe)`;
   - `found = findBbsBuild(deps, report, name)`, a private function. It calls
     `getBbsBuildStatus(deps, report, build)` for each `build` of `BBS_BUILDS`, **sequentially**
     and in order. It stops at the first build whose `packages.has(name)` and returns
     `{ build, status, searched }`. If no build lists the name, it returns `{ searched }`.
     `searched` is every `BbsBuildStatus` read, in order. Sequential means a software package
     costs one file, and a data-experiment file outage does not fail software lookups.
3. `entry = registryEntry(index, name)`.
4. If neither `found.build` nor `entry` exists: throw
   `CapabilityError('not_found', …)` with this message:
   ```
   No ${report} BBS report (bioc, data-experiment, workflows, books) and no ${universe} propagation entry lists "${name}". Package names are case-sensitive.
   ```
   - When `closeMatches(name, candidates)` is non-empty, ` Did you mean: ${matches.join(', ')}?`
     follows. `candidates` is a `Set` of every package name in `searched` plus
     `Object.keys(index.packages)`.
   - Then ` To check release, call again with universe 'bioc-release'.` follows for `bioc`, or
     ` To check devel, call again with universe 'bioc'.` for `bioc-release`.
5. If `found.build` exists, let `lines = status.packages.get(name)` and `nodeNames` be the distinct
   `node` values of `lines`, in order of first appearance. Read in parallel:
   - `getBbsPropagationStatus(deps, report, build)`;
   - `getBbsPackageInfo(deps, report, build, name)`;
   - `getBbsNodeInfo(deps, report, build, node)` for each node of `nodeNames`.

   Then build `legacy`:
   - `report`, `build`.
   - `version: info?.version ?? null` and `commit: info?.commit ?? null`.
   - `report_url: new URL(bbsPackagePath(report, build, name), BIOCONDUCTOR_BASE_URL).href`.
   - `as_of: sourceFor(status.response).as_of`.
   - `nodes`: group `lines` by `node`, in `nodeNames` order. For each node,
     `spec = nodeInfo?.spec` (that node's `getBbsNodeInfo` result), and the node is:
     `{ node, os: spec?.os ?? null, arch: spec?.arch ?? null, family: osFamily(spec?.os ?? null), verdict: nodeVerdict(stages), stages }`.
     Each stage is `{ stage, status, url }`, where `url` is
     `status === 'OK' || status === 'skipped' ? null : bbsStageUrl(report, build, name, node, stage)`.
   - `propagation: propagationStatus.packages.get(name) ?? []`, each as `{ target, status, reason }`.
6. `registry`, when `entry` exists:
   `{ version: entry.version, origin: entry.origin ?? 'r-universe', passed_gate: ORIGIN_PASSED_GATE[origin] ?? null, archs: entry.archs ?? null, propagated_at: entry.ts }`.
   Otherwise `null`.
7. `comparison`: for each family `f` of `PLATFORM_FAMILIES`:
   - `nodes = legacy?.nodes.filter(n => n.family === f) ?? []`;
   - `registry_passed = registry && registry.archs && registry.passed_gate !== false ? registry.archs.includes(f) : null`
     (a seeded entry never ran the gate, so its `archs` say nothing about passing);
   - the row `{ family: f, bbs_nodes: nodes.map(n => n.node), bbs_verdict: familyVerdict(nodes.map(n => n.verdict)), registry_passed }`
     is kept unless `nodes.length === 0` and `registry_passed !== true`.

   So a family appears when BBS has a machine for it or the registry passed it.
8. `same_version`: when `legacy?.version` and `registry` both exist,
   `compareRVersions(legacy.version, registry.version)`. `0` → `true`, `-1`/`1` → `false`,
   `null` → `null`. Otherwise `null`.
9. `history_sql: { query: legacyHistorySql(name), parquet_url: BIOCBUILDDB_BUILD_SUMMARY_URL }`.
10. `sources`, in this order:
    - when found: `status.response`, `propagationStatus.response`, `info.response` (when `info`),
      each defined node info's `response` in `nodeNames` order, and the registry `index.response`;
    - when not found in BBS: each `searched[i].response` in order, then `index.response`.

    Each goes through `sourceFor(response)`.

#### Summary

The summary is these sentences joined by a single space, in this order. Each is included only
when its condition holds.

| # | Condition | Text |
|---|---|---|
| 1 | `legacy` | `` `${name} ${legacy.version ?? '(version unknown)'} in the legacy build system's ${report} ${build} report (${legacy.as_of.slice(0, 10)}): ${nodes}.` `` |
| 1′ | no `legacy` | `` `${name} is in none of the legacy build system's ${report} reports (bioc, data-experiment, workflows, books).` `` |
| 2 | `legacy`, propagation non-empty | `` `BBS propagation: ${rows}.` `` |
| 2′ | `legacy`, propagation empty | `BBS recorded no propagation for it.` |
| 3 | `registry` | `` `The registry propagated ${registry.version} (${originLabel(registry.origin)}${archs}).` `` |
| 3′ | no `registry` | `` `${name} is not in the ${universe} propagation index.` `` |
| 4 | any disagreement | `` `BBS and the registry disagree on ${items}.` `` |
| 5 | `same_version === false` | `` `BBS built ${legacy.version}; the registry propagated ${registry.version}.` `` |

- `nodes`: each node is `` `${node}${family ? ` (${family})` : ''} ${verdict}${listed}` ``, joined
  with `'; '`. `listed` is `` ` (${stages.map(s => `${s.stage} ${s.status}`).join(', ')})` `` over
  the stages that explain the verdict. For `ok`, those are the stages with `WARNINGS`. For
  `failed`, those with `ERROR` or `TIMEOUT`. For `incomplete`, those that are not `OK` or
  `WARNINGS`. When no stage qualifies, `listed` is `''`.
- `rows`: each row is `` `${target} ${status}${reason ? ` (${reason})` : ''}` ``, joined with `'; '`.
- `archs`: `` `; families ${registry.archs.join(', ')}` `` when `registry.archs` is non-empty,
  else `''`.
- `items`: the comparison rows where `bbs_verdict === 'ok' && registry_passed === false`, or
  `bbs_verdict === 'failed' && registry_passed === true`. Each is
  `` `${family} (BBS ${bbs_verdict}, registry ${registry_passed ? 'passed' : 'not passed'})` ``,
  joined with `', '`.

`originLabel` is the existing function from `status.ts`, now exported. For example,
`'passed the gate via r-universe'` and `'seeded from Bioconductor, never gated'`.

### `src/core/pkg/status.ts`

- `export` `ORIGIN_PASSED_GATE` and `originLabel`. Their bodies do not change.
- In `pkg_status`'s description, insert this sentence before `'For download counts use pkg_downloads; …'`:
  `'For the legacy Bioconductor Build System (BBS) report on the same package, beside the registry, use pkg_legacy_status. '`

### `src/core/pkg/index.ts`

- `capabilities`: `pkgStatus, pkgLegacyStatus, pkgCheckOutput, …`. The rest keep their order.
- `upstreams`: unchanged. `bioconductorUpstream` is already listed.
- `description`: replace `'Package build and propagation state (Bioconductor registry, r-universe), '` with
  `'Package build and propagation state (Bioconductor registry, r-universe, and the legacy BBS report), '`.

### `src/upstreams/bioconductor.ts`

`bioconductorUpstream.description` becomes:

```ts
'bioconductor.org: config.yaml (release and devel versions), the published manifest index, ' +
'the source PACKAGES index of each repository (software, annotation and experiment data, workflows, books), ' +
'package download stats (/packages/stats), and the legacy build system (BBS) check reports (/checkResults).'
```

### README

- Add this row to "What is live today", after `pkg_status`:

  ```
  | `pkg` | `pkg_legacy_status` | What does the legacy build system (BBS) report for this package, and where does it disagree with the registry? |
  ```

- In "First questions to ask", add this line after the `pkg_status` / `pkg_check_output` example
  ("Why is *package* failing check on devel? …"):

  ```
  - "BBS says trackViewer is fine; does the registry agree on every platform?" (`pkg_legacy_status`)
  ```

### Transports

No changes. The scaffold derives everything:

- **MCP:** `pkg_legacy_status` on `/mcp` and `/mcp/pkg`, right after `pkg_status`.
- **REST:** `GET /api/v1/pkg/legacy_status?package=…&universe=…`.
- **About:** the upstream list is unchanged. `bioconductor` keeps `used_by: ['pkg']`, with the new
  description. The pkg module's tools include `pkg_legacy_status` second.

### Upstream calls

`B = https://bioconductor.org/checkResults`

| Call | Example URL | Size (2026-10-24) | Cache | `as_of` |
|---|---|---|---|---|
| Propagation index (existing) | `https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` | 8.0 MB | 300 s, parsed once per TTL | fetch time |
| BBS build status | `B/devel/bioc-LATEST/BUILD_STATUS_DB.txt` | 771 KB devel, 464 KB release; 49 KB data-experiment; ≈2 KB workflows, books | 3600 s, parsed once per TTL | `Last-Modified` |
| BBS propagation status | `B/devel/bioc-LATEST/PROPAGATION_STATUS_DB.txt` | 344 KB devel, 162 KB release | 3600 s, parsed once per TTL | `Last-Modified` |
| Package info | `B/devel/bioc-LATEST/trackViewer/raw-results/info.dcf` | ≈270 B | 3600 s | `Last-Modified` |
| Node info (one per machine) | `B/devel/bioc-LATEST/nebbiolo2-NodeInfo.html` | 6.3–7.3 KB | 3600 s, shared by every package | `Last-Modified` |

`release` replaces `devel` for `bioc-release`. `data-experiment-LATEST`, `workflows-LATEST` and
`books-LATEST` replace `bioc-LATEST` for those builds.

**Verified:**

- All files are public with `last-modified` set (devel and release bioc both
  `Fri, 23 Oct 2026 16:51:07 GMT`, which is when the report was published). Cloudflare serves
  them, gzip-encoded on request. All are far under the 2 MiB cap.
- Data-experiment, workflows and books reports run on their own schedules (Last-Modified
  2026-10-22, 2026-10-13 and 2026-10-16 for devel). That is why `as_of` comes from the build
  actually read.

On a cold cache, a devel software package costs six bioconductor.org requests: one build status,
one propagation status, info.dcf, and three NodeInfo pages. It costs none for the other builds.
With a warm cache, only info.dcf is per package. A name absent from BBS costs four build-status
files.

### Fixtures

Layout: each fixture file mirrors its URL under `test/fixtures/bioconductor/checkResults/`.
`test/fixtures/bioconductor/checkResults/last-modified.json` maps each recorded URL to the
`last-modified` header seen when it was recorded.

Recorded files:

| Report / build | `BUILD_STATUS_DB.txt` and `PROPAGATION_STATUS_DB.txt` | `{package}/raw-results/info.dcf` | `{node}-NodeInfo.html` |
|---|---|---|---|
| devel / bioc | trimmed to `trackViewer`, `biomaRt`, `GEOfastq`, `Chromatograms`, `cosmosR`, `RMassBank`, `SEMPLR`, `affxparser`, `BiocSet` | all nine | every node in the trimmed file (`nebbiolo2`, `lconway`, `taishan`) |
| devel / data-experiment | trimmed to `adductData` | `adductData` | `nebbiolo2` |
| devel / workflows | whole | none | none |
| devel / books | whole | none | none |
| release / bioc | trimmed to `edgeR`, `xcms` | both | `nebbiolo1`, `kunpeng2` |

Trimming keeps the lines whose package (the text before the first `#`) is in the set, verbatim and
in order. `info.dcf` fixtures drop every line starting with `Maintainer` (the name and e-mail
fields). NodeInfo pages are kept verbatim; they carry no e-mail addresses (**verified**).

Record from the repo root with Node ≥ 22 (global `fetch`):

```bash
node --input-type=module - <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const B = 'https://bioconductor.org/checkResults';
const F = 'test/fixtures/bioconductor/checkResults';
const PLAN = [
  ['devel', 'bioc', ['trackViewer', 'biomaRt', 'GEOfastq', 'Chromatograms', 'cosmosR', 'RMassBank', 'SEMPLR', 'affxparser', 'BiocSet']],
  ['devel', 'data-experiment', ['adductData']],
  ['devel', 'workflows', null],
  ['devel', 'books', null],
  ['release', 'bioc', ['edgeR', 'xcms']],
];
const lastModified = {};
async function get(url) {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  lastModified[url] = response.headers.get('last-modified');
  return response.text();
}
function write(rel, text) {
  const path = join(F, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
for (const [report, build, keep] of PLAN) {
  const dir = `${report}/${build}-LATEST/`;
  const nodes = new Set();
  for (const file of ['BUILD_STATUS_DB.txt', 'PROPAGATION_STATUS_DB.txt']) {
    const body = await get(`${B}/${dir}${file}`);
    const lines = body.split('\n').filter((line) => line !== '' && (keep === null || keep.includes(line.split('#')[0])));
    if (file === 'BUILD_STATUS_DB.txt' && keep !== null) for (const line of lines) nodes.add(line.split('#')[1]);
    write(dir + file, lines.join('\n') + '\n');
  }
  for (const name of keep ?? []) {
    const info = await get(`${B}/${dir}${name}/raw-results/info.dcf`);
    write(`${dir}${name}/raw-results/info.dcf`, info.split('\n').filter((line) => !line.startsWith('Maintainer')).join('\n'));
  }
  for (const node of nodes) write(`${dir}${node}-NodeInfo.html`, await get(`${B}/${dir}${node}-NodeInfo.html`));
}
writeFileSync(join(F, 'last-modified.json'), JSON.stringify(lastModified, null, 2) + '\n');
JS
```

`test/support/bbs-routes.ts` exports:

- `BBS_BASE = 'https://bioconductor.org/checkResults/'`;
- `bbsUrl(report: BbsReport, build: BbsBuild, rest: string): string` →
  `` `${BBS_BASE}${report}/${build}-LATEST/${rest}` ``;
- `bbsRoutes: Record<string, FixtureRoute>`, built by reading `last-modified.json`. For each
  URL it maps to `{ file: 'bioconductor/checkResults/<path>', headers: { 'last-modified': <value> } }`,
  where `<path>` is the URL after `BBS_BASE`.

Routes for files the plan does not record (for example the `info.dcf` of a package not in the
plan) are absent. Tests that need a 404 add `NOT_FOUND` routes from `bioconductor-routes.ts`
inline.

The existing `registry/prop/bioc/index.json` fixture (recorded 2026-10-22) predates the mac
disagreement the tester described: its `Chromatograms` entry is 1.3.3 with archs
`['linux','win','mac']`, and it has no `affxparser`. Two scenarios therefore read a second,
newer index fixture, recorded with the BBS files and left out of every other test:

```bash
curl -sf https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json |
  jq '{Chromatograms, affxparser}' > test/fixtures/registry/prop/bioc/index-2026-10-24.json
```

`test/support/bbs-routes.ts` also exports
`liveIndexRoutes: Record<string, FixtureRoute> = { [BIOC_INDEX_URL]: { file: 'registry/prop/bioc/index-2026-10-24.json' } }`,
which those two tests merge after `bbsRoutes` (as `depsRoutes` replaces the index for the
revdeps tests). **Verified (live, 2026-10-24):** `Chromatograms` is 1.3.5, origin `r-universe`,
archs `['linux','win']`; `affxparser` is 1.85.1, origin `r-universe`, archs `['linux','win','mac']`.

Scenarios. The state was observed live on 2026-10-24. The registry columns come from the existing
`registry/prop/{bioc,bioc-release}/index.json` fixtures (recorded 2026-10-22). Tests assert
against the recorded files. If a BBS package no longer fits its scenario when recorded,
substitute one that does and say so in the PR.

| Scenario | Input | Expected on the fixtures |
|---|---|---|
| All ok, agrees | `{ package: 'trackViewer' }` | build `bioc`; version `1.49.3`; commit `{ id: '602809b', time: '2026-09-29T15:32:11-04:00', branch: 'devel' }`; nodes `nebbiolo2` (linux, x86_64), `lconway` (mac), `taishan` (linux, aarch64), all `ok`, every stage `url: null`; `lconway` has 4 stages ending `buildbin`; propagation `source` and `mac.binary.big-sur-x86_64`, both `UNNEEDED` with reason `same version is already published`; registry `1.49.3`, origin `r-universe`, archs `['linux','win','mac']`; comparison `[linux ok true, mac ok true, win null true]` (win `bbs_nodes: []`); same_version true; no sentence 4 or 5 |
| BBS fails, registry passed linux | `{ package: 'GEOfastq' }` | `taishan` `failed` (checksrc `ERROR`, with a url ending `/GEOfastq/taishan-checksrc.html`); `nebbiolo2`, `lconway` `ok`; registry archs `['linux','mac']`, origin `r-universe` (absent in the entry); comparison `linux failed true`, `mac ok true`; the summary contains `BBS and the registry disagree on linux (BBS failed, registry passed).` |
| Failed everywhere, seeded | `{ package: 'biomaRt' }` | `nebbiolo2` and `taishan` `failed (buildsrc ERROR)`; `lconway` `failed (checksrc TIMEOUT)`; propagation `[]`; registry origin `bioconductor`, `passed_gate: false`, archs `[]`; comparison `linux failed null`, `mac failed null`; same_version false (2.69.5 vs 2.69.0); sentence 2′ and sentence 5 |
| Seeded, BBS ok | `{ package: 'trackViewer' }` with an inline index seeding it (`origin: 'bioconductor'`, `archs: []`, a mac binary) | all three nodes `ok`; registry `passed_gate: false`; comparison `linux ok null`, `mac ok null`; the summary does not contain `disagree` |
| Propagated now, newer than registry | `{ package: 'Chromatograms' }` | version `1.3.5`; propagation both `YES`, reason null; registry `1.3.3`; same_version false |
| Blocked by a dependency | `{ package: 'cosmosR' }` | propagation `source NO (package depends on 'decoupleR' which is not available)`, `mac.binary.big-sur-x86_64 UNNEEDED (…)`; registry null; sentence 3′ |
| Unknown archs | `{ package: 'RMassBank' }` | all nodes `failed` (install and buildsrc `ERROR`; checksrc `skipped` with url null); propagation `[]`; registry origin `r-universe`, archs null, `passed_gate: true`; comparison `linux failed null`, `mac failed null`; no sentence 4; same_version false (3.23.1 vs 3.23.0) |
| Experiment data | `{ package: 'adductData' }` | build `data-experiment`; one node `nebbiolo2` `ok`; `report_url` `https://bioconductor.org/checkResults/devel/data-experiment-LATEST/adductData/`; registry null; comparison `[linux ok null]`; `fetch.calls` include the bioc and data-experiment build status files only (no workflows or books) |
| Not in BBS, in registry | `{ package: 'Fletcher2013a' }` | legacy null; sentence 1′; registry `1.49.0`, origin `bioc-build`, archs `['linux']`; comparison `[linux, bbs_nodes [], bbs_verdict null, registry_passed true]`; same_version null; sources = the four devel build status URLs then the index |
| Release | `{ package: 'edgeR', universe: 'bioc-release' }` | report `release`; nodes `nebbiolo1`, `kunpeng2` (both linux) `ok`; commit branch `RELEASE_3_23`; registry `4.10.7`; comparison `linux ok true`, `mac null true`, `win null true`; same_version true; only `release/` BBS URLs requested |
| NA status | `{ package: 'xcms', universe: 'bioc-release' }` | `kunpeng2` `incomplete (checksrc NA)` with a url; comparison `linux incomplete null`; registry null |
| Disagree on mac: BBS ok, registry did not pass mac | `{ package: 'Chromatograms' }` with `liveIndexRoutes` | all three nodes `ok` with no listed stages; propagation both `YES`; registry `1.3.5`, origin `r-universe`, archs `['linux','win']`; comparison `[linux ok true, mac ok false, win null true]`; same_version true; the summary is exactly `Chromatograms 1.3.5 in the legacy build system's devel bioc report (2026-10-23): nebbiolo2 (linux) ok; lconway (mac) ok; taishan (linux) ok. BBS propagation: source YES; mac.binary.big-sur-x86_64 YES. The registry propagated 1.3.5 (passed the gate via r-universe; families linux, win). BBS and the registry disagree on mac (BBS ok, registry not passed).` |
| Disagree on linux, warnings elsewhere | `{ package: 'affxparser' }` with `liveIndexRoutes` | `nebbiolo2` and `lconway` `ok (checksrc WARNINGS)`; `taishan` `failed (checksrc ERROR)`; propagation both `UNNEEDED`; registry `1.85.1`, archs `['linux','win','mac']`; comparison `[linux failed true, mac ok true, win null true]`; same_version true; the summary contains `taishan (linux) failed (checksrc ERROR)` and `BBS and the registry disagree on linux (BBS failed, registry passed).` |
| Timeout on mac, archs unknown | `{ package: 'SEMPLR' }` | `lconway` `failed (checksrc TIMEOUT)`, `lconway` `buildbin` `OK`; `nebbiolo2`, `taishan` `ok`; propagation `source UNNEEDED` only; registry `1.1.2`, origin `r-universe` (absent in the entry), archs null; comparison `[linux ok null, mac failed null]`; no sentence 4 or 5; the largest recorded result, and the PR reports its `envelopeBytes` |
| In BBS only, failing everywhere | `{ package: 'BiocSet' }` | all three nodes `failed (buildsrc ERROR)`; `lconway` `buildbin` `skipped` with url null; propagation `[]` (sentence 2′); registry null (sentence 3′); comparison `[linux failed null, mac failed null]`; same_version null |
| Unknown name, close to a BBS and index name | `{ package: 'Chromatogram' }` | `not_found`; the message contains `Did you mean: Chromatograms?` |
| Unknown name | `{ package: 'trackViewr' }` | `not_found`; the message contains `Did you mean: trackViewer?` and ends with the release hint; `fetch.calls` include all four devel build status files and the index, and no info.dcf or NodeInfo page |

## Acceptance criteria

- [ ] `pkg_legacy_status` is registered in module `pkg`, right after `pkg_status`.
      `validateRegistry(modules)` passes on the production list.
- [ ] `/mcp/pkg` lists exactly `['pkg_status', 'pkg_legacy_status', 'pkg_check_output',
      'pkg_build_environment', 'pkg_release_info', 'pkg_downloads', 'pkg_repo_diff',
      'pkg_revdeps', 'pkg_missing_deps']`. `/mcp` contains `pkg_legacy_status`. The about pkg
      tool list is the same nine in the same order.
- [ ] `GET /api/v1/pkg/legacy_status?package=trackViewer` returns 200, and its body deep-equals
      the MCP `structuredContent` for the same input. The OpenAPI document has
      `/api/v1/pkg/legacy_status` with `operationId: 'pkg_legacy_status'`.
- [ ] Each scenario row has one fixture test through `invokeCapability` that asserts every value
      the row names, the `sources` (URLs in the specified order, `as_of` from the recorded
      `last-modified`, and fetch time for the index), and the exact `fetch.calls` set.
- [ ] The trackViewer, GEOfastq, biomaRt and Fletcher2013a summaries are checked exactly, as
      strings built from the recorded fixture values.
- [ ] The tester's case is one answer: `Chromatograms` with `liveIndexRoutes` returns the
      comparison and the exact summary in its scenario row, ending
      `BBS and the registry disagree on mac (BBS ok, registry not passed).`
- [ ] The added scenarios `affxparser` (with `liveIndexRoutes`), `SEMPLR`, `BiocSet` and
      `Chromatogram` (not_found) each assert the values and summary substrings in their rows.
- [ ] Unknown name (`trackViewr`): REST 404 `not_found`. MCP `isError` with text starting
      `not_found:`.
- [ ] Invalid input gives REST 400 `invalid_input` with `fetch.calls` empty, for `package=a'b`,
      `package=x` and `universe=cran`.
- [ ] Every envelope in the scenario tests is under 8,192 bytes (`envelopeBytes`). A synthetic
      worst case is also under 8,192 bytes, and the PR reports its size. The worst case is
      inline routes with a 40-character package name on 5 nodes (`n1`…`n5`), each with stages
      `install`, `buildsrc`, `checksrc` and `buildbin` all `ERROR`, three propagation rows with
      80-character reasons, a NodeInfo page for each node (OS `Windows Server 2022 Datacenter`), an
      `info.dcf`, and an index entry with archs `['linux','win','mac']`.
- [ ] Memo: two `pkg_legacy_status` calls within 3600 s request the devel bioc
      `BUILD_STATUS_DB.txt` and `PROPAGATION_STATUS_DB.txt` once each. After 3600 s, the next
      call requests each again. `trackViewer` then `GEOfastq` on one cache request each devel
      NodeInfo page once.
- [ ] Each of these fails the call with `upstream_error` and no partial result: the devel bioc
      build status file returns 500, returns 404 (message `has no BBS build status file`),
      contains the line `garbage`, or contains only blank lines; the propagation status file
      returns 404; `info.dcf` names another package. A build-status fetch rejecting with
      `new DOMException('timed out', 'TimeoutError')` gives `upstream_timeout`. Use a wrapping
      fetch, as `test/core/ops/token.test.ts` does.
- [ ] `info.dcf` 404 gives `version: null`, `commit: null` and sentence 1 with
      `(version unknown)`. A NodeInfo 404 for `lconway` gives that node `os`, `arch` and `family`
      null, no `lconway-NodeInfo.html` entry in `sources`, and no `mac` comparison row unless the
      registry passed mac. Both cases otherwise succeed.
- [ ] `pkg_status`'s description contains `pkg_legacy_status`. `pkg_legacy_status`'s description
      contains `pkg_status` and `pkg_check_output`.
- [ ] README lists the tool.
- [ ] `npm test` and `npm run typecheck` pass. `npm run build` passes, and the PR reports the
      bundle size before and after.

## Test plan

All tests run in Node with `fixtureFetch` and `createMemoryCache`. There is no network.

- **`test/upstreams/bbs.test.ts`**
  - `bbsReportPath('devel', 'bioc')` is `'checkResults/devel/bioc-LATEST/'`.
  - `bbsPackagePath` encodes the name (`'a.b'` stays `a.b`). `bbsPackagePath(…, '..')` throws
    `invalid_input` (through `pathSegment`).
  - `bbsStageUrl('devel', 'bioc', 'GEOfastq', 'taishan', 'checksrc')` is
    `https://bioconductor.org/checkResults/devel/bioc-LATEST/GEOfastq/taishan-checksrc.html`.
  - `parseBuildStatusDb`:
    - the devel bioc fixture gives nine packages, and trackViewer has 10 lines in file order;
    - `\r\n` line endings parse;
    - a blank line is skipped;
    - a line with a space in the status (`a4#n#install: NOT OK`) is upstream_error;
    - a repeated key is upstream_error;
    - a package name with dots (`org.Hs.eg.db#n#install: OK`) parses.
  - `parsePropagationStatusDb`:
    - `YES` gives reason null;
    - `NO, package depends on 'x' which is not available` splits at the first `', '`;
    - a malformed line is upstream_error;
    - an empty body gives an empty map.
  - `parseBbsInfoDcf`:
    - the trackViewer fixture parses;
    - an inline body with `Maintainer:` and `MaintainerEmail: someone at example.org` parses, and
      neither appears in the result;
    - a Package mismatch is upstream_error with the "expected" message;
    - a bad Version is upstream_error;
    - a missing or non-hex `git_last_commit` gives commit null;
    - a second stanza is upstream_error.
  - `bbsCommitTime`:
    - `'2026-04-28 08:35:24 -0400 (Tue, 28 Apr 2026)'` → `'2026-04-28T08:35:24-04:00'`;
    - `+0530` works;
    - `''` and `'yesterday'` → null.
  - `bbsNodeInfoPath('devel', 'bioc', 'nebbiolo2')` is `'checkResults/devel/bioc-LATEST/nebbiolo2-NodeInfo.html'`.
  - `parseBbsNodeInfo`:
    - each recorded NodeInfo page gives the OS and Arch in the verified table above;
    - the `nebbiolo2` page with node `lconway` gives null (hostname mismatch);
    - HTML without an `OS:` row gives null;
    - `&amp;` in the OS cell is decoded.
  - `getBbsBuildStatus`:
    - memo hit (`fromCache: true`, one fetch);
    - two concurrent cold calls make one fetch;
    - 404 → upstream_error;
    - empty → upstream_error;
    - a 500 is not memoized.
  - `getBbsPackageInfo` and `getBbsNodeInfo` return `undefined` on 404 and propagate a 500.
- **`test/core/pkg/legacy-status.test.ts`**
  - `osFamily`: `'Linux (Ubuntu 24.04.4 LTS)'` → linux, `'macOS 12.7.6 Monterey'` → mac,
    `'Mac OS X 10.13'` → mac, `'Windows Server 2022 Datacenter'` → win, `'FreeBSD'` → null,
    null → null.
  - `nodeVerdict`:
    - `[OK, WARNINGS]` → ok;
    - `[OK, ERROR, skipped]` → failed;
    - `[OK, TIMEOUT]` → failed;
    - `[OK, NA]` → incomplete;
    - `[OK, skipped]` → incomplete.
  - `familyVerdict`:
    - `[]` → null;
    - `[ok, incomplete]` → incomplete;
    - `[incomplete, failed]` → failed.
  - `legacyHistorySql`: the exact query for `edgeR`; `"a'b"` throws.
  - Every scenario row, the exact summaries, the size worst case, the memo, the failures, and
    the 404 enrichment cases from the acceptance criteria.
  - A usage event is recorded with `upstream_status` 200 and no input values, as in
    `status.test.ts`.
- **`test/transports/pkg.test.ts`** (extend):
  - `testApp()` routes add `...bbsRoutes`;
  - the tools lists and about tool list;
  - REST/MCP equality for `trackViewer`;
  - the 400 table and the 404 body;
  - the MCP `not_found:` text;
  - the OpenAPI path.
- **`test/transports/text-content.test.ts`**: add the `CALLS` row
  `['pkg_legacy_status', { package: 'trackViewer' }]`, and add `...bbsRoutes` to `call()`'s
  routes.
- **`test/core/pkg/status.test.ts`**: the description test also expects `pkg_legacy_status`.

## Risks

- **BBS retirement.** When BBS stops publishing, the files return 404 or go stale.
  - A 404 on `BUILD_STATUS_DB.txt` becomes `upstream_error` naming the URL, so the tool fails
    loudly rather than reporting "not in BBS".
  - A stale report still answers, with `as_of` showing its age.
  - The tool and `src/upstreams/bbs.ts` can then be removed without touching `pkg_status`.
- **The issue named BiocBuildDB as the source.** This spec reads the live BBS files for the
  current state and gives BiocBuildDB only as a history query, for the reasons verified above.
  If a BiocBuildDB-side per-package or latest-snapshot object is published later (needs a
  human; a follow-up issue in seandavi/BiocBuildDB), `history_sql` could become a fetched
  history block. That is a new spec.
- **HTML scraping for node specs.** `parseBbsNodeInfo` depends on the NodeInfo pages'
  `<TD><B>OS:&nbsp;</B></TD><TD>…</TD>` markup. If the markup changes, `os`, `arch` and
  `family` become null and `comparison` loses its BBS side (rows only where the registry
  passed). The tool does not fail. The stage verdicts come from the text files and are
  unaffected. The parser test on the recorded pages pins the current markup.
- **Strict text parsing.** One malformed line in a BBS file fails every call for that build
  until the file changes. This matches the PACKAGES parser's policy: a silently skipped line
  could hide a package. Every line seen on 2026-10-24 matches.
- **Release day.** On a release day, BBS's `devel`/`release` reports and the registry's universes
  can flip at different moments. For a few hours `same_version` and `comparison` may compare
  different BioC versions. `commit.branch` (`devel` vs `RELEASE_3_xx`) makes it visible.
- **`ok` is not "passed the gate".** BBS's `ok` (no ERROR or TIMEOUT) and the registry's gate
  apply different rules. `comparison` puts them side by side and does not say one implies the
  other. The descriptions say what each side means.
- **Cold-cache latency.** A devel software package needs six bioconductor.org requests (two
  through `SharedLoads`) plus the registry index, in two rounds: the build status first, then
  the propagation status, info.dcf and the NodeInfo pages in parallel. These are
  Cloudflare-cached static files, so this should be well under the 10 s timeout. NodeInfo pages
  and the two status files are shared by every package, so a warm isolate pays only info.dcf.
  **Verified (Node 26.8.1, Apple M-series laptop, throwaway script):** a cold parse of the devel
  bioc build status file (771 KB, 24,681 lines) took 5.7 ms, and of its propagation file 1.1 ms.
  **Not verified** from the deployed Worker. The PR's post-deploy check should call `pkg_legacy_status` once per universe.
- **Fixture drift.** BBS and registry fixtures were recorded on different days (2026-10-24 and
  2026-10-22). That is intended: the tests pin parsing and comparison, not live agreement.
  Re-recording follows the script and the scenario criteria.
