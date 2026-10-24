# Spec #55: `pkg_legacy_status`, the legacy BBS report next to the registry

Issue: [seandavi/bioc-mcp#55](https://github.com/seandavi/bioc-mcp/issues/55) (part of #48, tester
feedback). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md). Builds on [spec #6](6-pkg-status.md) (`pkg_status`,
the propagation index reader) and [spec #74](74-packages-reader.md) (`SharedLoads`).

Every upstream shape below was checked on 2026-10-24 against the live endpoints with curl, the
BiocBuildDB parquet with the DuckDB CLI, and a throwaway Node 26.8.1 script (not committed) that
ran the parsers below over all 16 live BBS status files. **Verified** marks what was observed. No
new npm package is needed.

## Goal

The tester's complaint: for any package only one half of the comparison is visible; "BBS says
OK, the registry says blocked on mac" should be one answer. Add one capability that answers, in
one call, for one package and one universe:

- **BBS side.** Today's report of the legacy Bioconductor Build System (BBS) for the matching
  branch: which report lists the package (software, data-experiment, workflows, books), its
  version and commit, per-node INSTALL / BUILD / CHECK / BUILD BIN verdicts with each node's OS,
  arch and platform family, the BBS propagation outcome per target, and the package's report URL.
- **Registry side.** The registry's propagation-index entry: version, origin, platform families
  that passed the gate, when it was written.
- **Side by side.** One row per platform family (linux, mac, win) with BBS's worst verdict and
  whether the registry propagated that family, and a summary sentence naming the families where
  they disagree.

### Why a separate tool, not a `legacy` block in `pkg_status`

The issue leaves this to the spec, "considering the 8 KB budget". Measured on 2026-10-24:

- The live `pkg_status` result for `SEMPLR` (the largest scenario) is 5,526 bytes
  (`curl -s 'https://bioc-mcp.seandavi.workers.dev/api/v1/pkg/status?package=SEMPLR' | wc -c`);
  `ClustIRR` 4,941, `edgeR` 4,918.
- The BBS block for `SEMPLR` (3 nodes, 2 propagation targets) is about 909 bytes of JSON, its
  sources (status file, propagation file, info.dcf, 3 node pages) about 749 bytes, and its
  summary sentences about 270 bytes: roughly 1.9 KB, so about 7.4 KB in total, about 740 bytes
  below `MAX_RESULT_BYTES`. A package with a long `newer_commit_failed` message, more reasons, or a
  fourth or fifth BBS node would fail with `result_too_large`, which is an error, not truncation.
- It would also add six to eight fetches and a new upstream failure mode to every `pkg_status`
  call, including the triage prompt's first step.

So the BBS side goes in `pkg_legacy_status`, which carries the registry fields the comparison
needs (read from the same memoized index as `pkg_status`, so no extra index fetch in a warm
isolate) and stays near 3 KB. `pkg_status`'s description points to it.

## Non-goals

- **History.** The issue comment names seandavi/BiocBuildDB as the source of history. It is not
  usable from the Worker today. **Verified (2026-10-24):** `build_summary.parquet` is 249,932,490
  bytes in 128 row groups, and every row group's `package` statistics span `ABSSeq`…`zlibbioc`, so
  the file is not clustered by package and Range reads cannot prune it. Its columns are
  `package, node, stage, version, status, startedat, endedat, command, report_md5`; the bucket
  publishes only `build_summary`, `info` and `propagation_status`, so no published table maps
  `report_md5` to a BioC version or branch. `propagation_status.parquet` (2,396,560 bytes) has only
  `package, process, propagate, report_md5`. History needs a BiocBuildDB-side change (a published
  reports table and a per-package or package-sorted object); the PR proposes a follow-up issue for
  it (needs:human) and does not file it without approval.
- Changing `pkg_status`'s output, its fetches or the `triage-failing-package` prompt. Only
  `pkg_status`'s description gains a pointer.
- BBS log text (the per-node `*-checksrc.html` pages). `pkg_check_output` covers r-universe jobs.
- The `data-annotation` BBS report: the registry carries no annotation packages
  (`BIOC_REPOS` in src/upstreams/bioconductor.ts).
- The BBS snapshot date and maintainer. The snapshot date is only on the per-package HTML page,
  which is too large to read (see [Upstream calls](#upstream-calls)); maintainers carry email
  addresses and are not needed for the comparison.
- Changes to `src/upstreams/http.ts`, `cache.ts`, `shared-load.ts`, `src/envelope.ts` or the
  transports.

## Design

### Files

```
src/upstreams/bbs.ts                       NEW  BBS report reader (status, propagation, info.dcf, node pages)
src/upstreams/bioconductor.ts              bioconductorUpstream.description mentions the BBS reports
src/core/pkg/legacy-status.ts              NEW  pkgLegacyStatus, PkgLegacyStatusDataSchema, worstVerdict()
src/core/pkg/index.ts                      capabilities += pkgLegacyStatus (last); module description
src/core/pkg/status.ts                     description gains the pkg_legacy_status pointer
README.md                                  "What is live today" gains a pkg_legacy_status row
test/upstreams/bbs.test.ts                 NEW
test/core/pkg/legacy-status.test.ts        NEW
test/support/legacy-routes.ts              NEW  legacyRoutes, bbsUrl()
test/transports/pkg.test.ts                tool lists, REST vs MCP, REST 400
test/transports/text-content.test.ts       CALLS row, legacy routes for that tool
test/fixtures/bioconductor/checkResults/…  NEW  trimmed BBS status files, info.dcf, node pages (see Fixtures)
test/fixtures/registry/prop/bioc/index-legacy.json  NEW  trimmed devel index for these scenarios
```

Import zod as `import * as z from 'zod'`. Build every path with `pathSegment()` for each value that
did not come from a constant (`name`, and node names read from the status file). Fetch only
through `fetchUpstream`. src/upstreams/bbs.ts imports core only as types
(test/upstreams/imports.test.ts).

### `src/upstreams/bbs.ts`

BBS reports are served by bioconductor.org, so this adapter uses the existing
`bioconductorUpstream` (base `https://bioconductor.org/`, TTL 3600 s, default 10 s timeout and
2 MiB cap). No new `Upstream` is declared. Update its description to:

```ts
description:
  'bioconductor.org: config.yaml (release and devel versions), the published manifest index, ' +
  'the source PACKAGES index of each repository (software, annotation and experiment data, workflows, books), ' +
  'package download stats (/packages/stats), and the legacy build system (BBS) reports (/checkResults).',
```

#### Constants and types

```ts
import type { Deps } from '../core/deps';
import { CapabilityError } from '../errors';
import { bioconductorUpstream, BIOC_REPOS, type BiocRepo } from './bioconductor';
import { fetchUpstream, pathSegment, type UpstreamResponseMeta } from './http';
import type { Universe } from './registry';
import { SharedLoads } from './shared-load';

/** The BBS branch directory each universe is compared with. */
export const BBS_BRANCHES = { bioc: 'devel', 'bioc-release': 'release' } as const satisfies Record<Universe, string>;
export type BbsBranch = (typeof BBS_BRANCHES)[Universe];

/** BBS reports searched for a package, in this order; the same list as the registry's repositories. */
export const BBS_REPORTS: readonly BiocRepo[] = BIOC_REPOS; // ['bioc', 'data-experiment', 'workflows', 'books']

export const BBS_STAGES = ['install', 'buildsrc', 'checksrc', 'buildbin'] as const;
export type BbsStage = (typeof BBS_STAGES)[number];

export const BBS_VERDICTS = ['OK', 'WARNINGS', 'ERROR', 'TIMEOUT', 'skipped', 'NA'] as const;
export type BbsVerdict = (typeof BBS_VERDICTS)[number];

/** Platform families in the registry's archs vocabulary. */
export const PLATFORM_FAMILIES = ['linux', 'mac', 'win'] as const;
export type PlatformFamily = (typeof PLATFORM_FAMILIES)[number];

export interface BbsStageResult {
  node: string; // e.g. 'nebbiolo2'
  stage: BbsStage;
  verdict: BbsVerdict;
}

export interface BbsBuildStatus {
  repo: BiocRepo;
  response: UpstreamResponseMeta; // the body is dropped once parsed
  packages: ReadonlyMap<string, readonly BbsStageResult[]>; // file order
}

export interface BbsPropagation {
  target: string; // e.g. 'source', 'mac.binary.big-sur-x86_64'
  outcome: string; // 'YES', 'NO' or 'UNNEEDED' as observed; any upper-case word is kept
  detail: string | null; // text after the first ', ', e.g. 'same version is already published'
}

export interface BbsPropagationStatus {
  response: UpstreamResponseMeta;
  packages: ReadonlyMap<string, readonly BbsPropagation[]>;
}

export interface BbsPackageInfo {
  response: UpstreamResponseMeta;
  version: string | null;
  gitBranch: string | null; // 'devel', 'RELEASE_3_23'
  commit: { id: string; time: string | null } | null; // time ISO 8601
}

export interface BbsNodeInfo {
  response: UpstreamResponseMeta;
  os: string | null; // 'macOS 12.7.6 Monterey'
  arch: string | null; // 'x86_64', 'aarch64'
  family: PlatformFamily | null;
}
```

Paths (relative to `https://bioconductor.org/`; `branch` and `repo` come from the constants above):

| Function | Path |
|---|---|
| `getBbsBuildStatus` | `checkResults/${branch}/${repo}-LATEST/BUILD_STATUS_DB.txt` |
| `getBbsPropagationStatus` | `checkResults/${branch}/${repo}-LATEST/PROPAGATION_STATUS_DB.txt` |
| `getBbsPackageInfo` | `checkResults/${branch}/${repo}-LATEST/${pathSegment(name)}/raw-results/info.dcf` |
| `getBbsNodeInfo` | `checkResults/${branch}/${repo}-LATEST/${pathSegment(`${node}-NodeInfo.html`)}` |

```ts
/** The package's page in a BBS report; returned as a link, never fetched (it can be several MB). */
export function bbsReportUrl(branch: BbsBranch, repo: BiocRepo, name: string): string;
// → `https://bioconductor.org/checkResults/${branch}/${repo}-LATEST/${pathSegment(name)}/`
```

#### Build status file

```ts
/** package#node#stage: verdict lines → package → results, in file order; upstream_error (with url) on any other line. */
export function parseBbsBuildStatus(body: string, url: string): Map<string, BbsStageResult[]>;

/** GET …/BUILD_STATUS_DB.txt through a SharedLoads memo; undefined when bioconductor.org answers 404. */
export async function getBbsBuildStatus(deps: Deps, branch: BbsBranch, repo: BiocRepo): Promise<BbsBuildStatus | undefined>;
```

- Split on `/\r?\n/`, skip `''` lines. Every other line must match
  `/^([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])#([A-Za-z0-9._-]+)#(install|buildsrc|checksrc|buildbin): (OK|WARNINGS|ERROR|TIMEOUT|skipped|NA)$/`,
  else throw `CapabilityError('upstream_error', \`bioconductor.org returned a BBS build status file in an unexpected format (${url})\`, { upstream: 'bioconductor', url })`.
  Repeated `package#node#stage` lines are kept as they come (none observed).
- Memo: a module-level `new SharedLoads<BbsBuildStatus>()`, keyed by the full URL, `what` =
  `'the BBS build status'`. The load is `fetchUpstream(deps, bioconductorUpstream, path)` then
  the parse; it resolves to `{ repo, response: <response without body>, packages }`.
- A `not_found` from `fetchUpstream` returns `undefined` (a report BBS no longer publishes); the
  memo is not used for it (call `fetchUpstream` inside the load, catch `not_found` outside the
  `SharedLoads.get` call, so a 404 is never memoized; errors are not cached by `SharedLoads`).
  Every other error propagates.

**Verified (2026-10-24):** devel `bioc` is 771,118 bytes, 24,681 lines, 2,472 packages; release
`bioc` 464,316 bytes, 2,417 packages; `data-experiment` about 49 KB, `workflows` and `books` about
2 KB each, on both branches. Every line of all eight files matches the regex. Verdicts seen: `OK`,
`WARNINGS`, `ERROR`, `TIMEOUT`, `skipped` (a later stage after a failure), and `NA` (release
only, `checksrc` on `kunpeng2`). No package is in two reports of one branch. Devel nodes:
`nebbiolo2`, `lconway`, `taishan` (`buildbin` only on `lconway`); release nodes: `nebbiolo1`,
`kunpeng2` (no mac node). The file has a `Last-Modified` (Fri, 23 Oct 2026 16:51:07 GMT for devel
`bioc`). A cold parse of devel `bioc` took 5.7 ms in Node 26.8.1 on an Apple M-series laptop.

#### Propagation status file

```ts
/** package#target#propagate: OUTCOME[, detail] → package → outcomes; upstream_error (with url) on any other line. */
export function parseBbsPropagationStatus(body: string, url: string): Map<string, BbsPropagation[]>;

/** GET …/PROPAGATION_STATUS_DB.txt through a SharedLoads memo; undefined on 404. */
export async function getBbsPropagationStatus(deps: Deps, branch: BbsBranch, repo: BiocRepo): Promise<BbsPropagationStatus | undefined>;
```

- Line regex: `/^([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])#([A-Za-z0-9._-]+)#propagate: ([A-Z]+)(?:, (.+))?$/`
  → `{ target: m[2], outcome: m[3], detail: m[4] ?? null }`. Error message: `bioconductor.org
  returned a BBS propagation status file in an unexpected format (${url})`.
- Memo and 404 handling as for the build status file; `what` = `'the BBS propagation status'`.

**Verified:** devel `bioc` is 344,155 bytes, 4,308 lines, 2,329 packages; targets `source`
(2,319) and `mac.binary.big-sur-x86_64` (1,989); release `bioc` has only `source`. Values seen:
`UNNEEDED, same version is already published` (6,529), `YES` (37), and `NO, package depends on
'<pkg>' which is not available` (15). Packages whose build failed have no line (`biomaRt`,
`BiocSet`, `ClustIRR`, `RMassBank`). All lines of all eight files match.

#### `info.dcf`

```ts
/** One-stanza DCF → version, git branch, commit; upstream_error when Package is not `name`. */
export function parseBbsPackageInfo(body: string, name: string, url: string): Omit<BbsPackageInfo, 'response'>;

/** GET …/{name}/raw-results/info.dcf (no memo; ~270 bytes); undefined on 404. */
export async function getBbsPackageInfo(deps: Deps, branch: BbsBranch, repo: BiocRepo, name: string): Promise<BbsPackageInfo | undefined>;
```

- Fields: each line matching `/^([^\s:]+):\s?(.*)$/` sets a field (value trimmed); a line that
  starts with a space or tab continues the previous field; blank lines are skipped; any other line
  is `upstream_error` (`bioconductor.org returned a BBS info.dcf in an unexpected format (${url})`).
- `Package !== name` → the same `upstream_error`.
- `version = fields.Version ?? null`, `gitBranch = fields.git_branch ?? null`.
- `commit`: `null` unless `git_last_commit` matches `/^[0-9a-f]{7,40}$/`. Then
  `time = bbsTimeToIso(fields.git_last_commit_date)`, where `bbsTimeToIso` matches
  `/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})/` and returns
  `new Date(\`${d}T${t}${sign}${hh}:${mm}\`).toISOString()`, or `null` when it does not match or the
  date is invalid.

**Verified:** `https://bioconductor.org/checkResults/devel/bioc-LATEST/a4/raw-results/info.dcf`
is 267 bytes:

```
Package: a4
Version: 1.61.0
Maintainer: Laure Cougnaud
MaintainerEmail: laure.cougnaud at openanalytics.eu
git_url: https://git.bioconductor.org/packages/a4
git_branch: devel
git_last_commit: bb7aa77
git_last_commit_date: 2026-04-28 08:35:24 -0400 (Tue, 28 Apr 2026)
```

`2026-04-28 08:35:24 -0400` → `2026-04-28T12:35:24.000Z`. Release `edgeR` has
`git_branch: RELEASE_3_23`. A package directory can outlive its report entry: `Fletcher2013a` is
in no devel status file but `data-experiment-LATEST/Fletcher2013a/raw-results/info.dcf` still
answers 200 (snapshot 2026-09-10), so info.dcf is read only for a package the status file lists.

#### Node pages

```ts
/** OS, Arch and Platform rows of a {node}-NodeInfo.html page; missing rows are null. */
export function parseBbsNodeInfo(html: string): Omit<BbsNodeInfo, 'response'>;

/** GET …/{node}-NodeInfo.html (no memo; ~6.5 KB, cached 1 h, shared by every package); undefined on 404. */
export async function getBbsNodeInfo(deps: Deps, branch: BbsBranch, repo: BiocRepo, node: string): Promise<BbsNodeInfo | undefined>;
```

- `row(label)` = `new RegExp(\`<TD><B>${label}:&nbsp;</B></TD><TD>([^<]*)</TD>\`).exec(html)?.[1]`
  for the constant labels `OS`, `Arch`, `Platform`; decode `&nbsp;` to a space and `&amp;`,
  `&lt;`, `&gt;`, `&quot;` to their characters, collapse runs of whitespace, trim; `''` → null.
- `family` from Platform first: `/-linux/` → `linux`, `/-darwin/` → `mac`, `/mingw|windows/i` →
  `win`. Else from OS: `/^linux/i` → `linux`, `/^(macos|mac os)/i` → `mac`, `/^windows/i` → `win`.
  Else `null`.

**Verified:** the rows are exactly
`<TR><TD><B>OS:&nbsp;</B></TD><TD>macOS&nbsp;12.7.6&nbsp;Monterey</TD></TR>`,
`<TR><TD><B>Arch:&nbsp;</B></TD><TD>x86_64</TD></TR>`,
`<TR><TD><B>Platform:&nbsp;</B></TD><TD>x86_64-apple-darwin21.6.0</TD></TR>` (`lconway`);
`nebbiolo2` is `Linux (Ubuntu 24.04.4 LTS)` / `x86_64`, `taishan` `Linux (openEuler 24.03 LTS)` /
`aarch64`, release `nebbiolo1` and `kunpeng2` likewise Linux. Each report directory has its own
node pages (`data-experiment-LATEST/nebbiolo2-NodeInfo.html` is 200). An unknown node page is a
404. The pages are ASCII HTML with `Last-Modified`.

#### Finding the package

```ts
export interface BbsLookup {
  read: readonly BbsBuildStatus[]; // the reports that answered, in BBS_REPORTS order
  found: { status: BbsBuildStatus; results: readonly BbsStageResult[] } | undefined;
}

/** All four build status files of `branch` in parallel; the first report (BBS_REPORTS order) listing `name`. */
export async function findBbsPackage(deps: Deps, branch: BbsBranch, name: string): Promise<BbsLookup>;
```

If every report answered 404 (`read` would be empty), throw
`CapabilityError('upstream_error', \`bioconductor.org publishes no BBS ${branch} build reports; the legacy build system may have been retired.\`, { upstream: 'bioconductor', url: <the bioc report's URL> })`.

### `src/core/pkg/legacy-status.ts`

#### Input

Same shape as `pkg_status`:

```ts
input: z.object({
  package: PackageNameSchema,
  universe: z
    .enum(UNIVERSES)
    .default('bioc')
    .describe("'bioc' compares Bioconductor devel with BBS devel (default); 'bioc-release' compares release"),
}),
```

#### Data (output) schema

```ts
const VerdictSchema = z
  .enum(BBS_VERDICTS)
  .nullable()
  .describe('BBS verdict: OK, WARNINGS, ERROR, TIMEOUT, skipped (an earlier stage failed) or NA; null when the node does not run this stage');

const LegacyNodeSchema = z.object({
  node: z.string().describe("BBS build machine, e.g. 'nebbiolo2'"),
  os: z.string().nullable().describe("OS from the node's NodeInfo page, e.g. 'macOS 12.7.6 Monterey'; null if the page is missing"),
  arch: z.string().nullable().describe("e.g. 'x86_64', 'aarch64'"),
  family: z.enum(PLATFORM_FAMILIES).nullable().describe("Platform family in the registry's archs vocabulary; null if unknown"),
  install: VerdictSchema,
  buildsrc: VerdictSchema.describe('R CMD build (BUILD in the report)'),
  checksrc: VerdictSchema.describe('R CMD check (CHECK in the report)'),
  buildbin: VerdictSchema.describe('Binary build (BUILD BIN in the report); only mac and Windows nodes run it'),
});

export const PkgLegacyStatusDataSchema = z.object({
  package: z.string(),
  universe: z.enum(UNIVERSES),
  legacy: z
    .object({
      branch: z.enum(['devel', 'release']),
      report: z.enum(BIOC_REPOS).describe("The BBS report that lists the package: 'bioc' (software), 'data-experiment', 'workflows' or 'books'"),
      report_url: z.string().describe("The package's page in the BBS report (HTML; several MB for packages with many reverse dependencies)"),
      version: z.string().nullable().describe('Version BBS built; null if its info.dcf is missing'),
      git_branch: z.string().nullable().describe("Branch BBS built, e.g. 'devel' or 'RELEASE_3_23'"),
      commit: z
        .object({
          id: z.string().describe('Short git SHA BBS built'),
          time: z.string().nullable().describe('Commit time, ISO 8601'),
        })
        .nullable(),
      nodes: z.array(LegacyNodeSchema).describe('One entry per BBS node that built the package, in report order'),
      propagation: z
        .array(
          z.object({
            target: z.string().describe("Package type, e.g. 'source' or 'mac.binary.big-sur-x86_64'"),
            outcome: z.string().describe("BBS's propagation decision: YES, NO or UNNEEDED"),
            detail: z.string().nullable().describe("BBS's reason, e.g. 'same version is already published'"),
          }),
        )
        .nullable()
        .describe('BBS propagation outcomes; [] when BBS lists none (it lists none for failed builds); null when the report publishes no propagation file'),
    })
    .nullable()
    .describe("Today's BBS report for this branch; null when no BBS report lists the package"),
  registry: z
    .object({
      version: z.string(),
      origin: z.string().describe("'r-universe', 'bioc-build' or 'bioconductor' (seeded, never gated)"),
      archs: z.array(z.string()).nullable().describe('Platform families that passed the gate; null on older entries'),
      propagated_at: z.string().describe("When this index entry was written (the entry's ts), ISO 8601"),
    })
    .nullable()
    .describe('The propagation-index entry; null when the package is not in the index'),
  platforms: z
    .array(
      z.object({
        family: z.enum(PLATFORM_FAMILIES),
        bbs: z
          .enum(['OK', 'WARNINGS', 'ERROR', 'TIMEOUT'])
          .nullable()
          .describe("Worst BBS verdict over this family's nodes and stages (ERROR > TIMEOUT > WARNINGS > OK; skipped and NA ignored); null when BBS has no such node"),
        bbs_nodes: z.array(z.string()).describe('BBS nodes of this family'),
        registry_propagated: z
          .boolean()
          .nullable()
          .describe("Whether the registry entry's archs include this family; null when there is no entry or its archs are not recorded"),
      }),
    )
    .describe('One row per platform family a BBS node or the registry archs cover, in linux, mac, win order'),
});
```

#### Shaping rules

- `branch = BBS_BRANCHES[universe]`.
- **legacy** (when `lookup.found`): `report = found.status.repo`,
  `report_url = bbsReportUrl(branch, report, name)`, version / git_branch / commit from
  `getBbsPackageInfo` (all `null` when it returns `undefined`). `nodes`: one per distinct
  `result.node` in order of first appearance; each stage field is that node's verdict for the
  stage, or `null`; `os`, `arch`, `family` from `getBbsNodeInfo` (all `null` on `undefined`).
  `propagation`: `getBbsPropagationStatus(...)?.packages.get(name) ?? []`, or `null` when the
  function returns `undefined`.
- **registry** (from `registryEntry(index, name)`): `{ version, origin: entry.origin ?? 'r-universe', archs: entry.archs ?? null, propagated_at: entry.ts }`.
- **`worstVerdict(verdicts: readonly (BbsVerdict | null)[]): 'OK' | 'WARNINGS' | 'ERROR' | 'TIMEOUT' | null`**
  (exported): the highest of ERROR (4), TIMEOUT (3), WARNINGS (2), OK (1); `skipped`, `NA` and
  `null` are ignored; `null` when nothing ranks.
- **platforms**: for each `family` in `PLATFORM_FAMILIES`: `bbs_nodes` = names of `legacy.nodes`
  with that family; `registry_propagated` = `registry === null || registry.archs === null ? null : registry.archs.includes(family)`.
  Emit the row when `bbs_nodes.length > 0 || registry_propagated === true`. `bbs` =
  `worstVerdict` over every stage verdict of those nodes (`null` when `bbs_nodes` is empty).
- **disagreement**: a row with `bbs !== null && registry_propagated !== null` is *comparable*. It
  disagrees when (`bbs` is OK or WARNINGS and `registry_propagated === false`) or (`bbs` is ERROR
  or TIMEOUT and `registry_propagated === true`).

#### Handler

```ts
async handler({ package: name, universe }, deps) {
  const branch = BBS_BRANCHES[universe];
  const [index, lookup] = await Promise.all([getPropagationIndex(deps, universe), findBbsPackage(deps, branch, name)]);
  const entry = registryEntry(index, name);
  if (!entry && !lookup.found) {
    const candidates = new Set([...Object.keys(index.packages), ...lookup.read.flatMap((s) => [...s.packages.keys()])]);
    const matches = closeMatches(name, candidates);
    throw new CapabilityError(
      'not_found',
      `No ${universe} propagation entry and no BBS ${branch} report lists "${name}". Package names are case-sensitive.` +
        (matches.length > 0 ? ` Did you mean: ${matches.join(', ')}?` : '') +
        (universe === 'bioc' ? " To check release, call again with universe 'bioc-release'." : " To check devel, call again with universe 'bioc'."),
    );
  }
  // When found: getBbsPropagationStatus, getBbsPackageInfo and one getBbsNodeInfo per node, all in parallel.
  // Shape legacy, registry, platforms; build the summary.
}
```

Every upstream error propagates (no partial result), as in `pkg_status`.

**sources**, in this order: `sourceFor(index.response)`; then, when found, the build status file
of the matched report, the propagation file (when read), info.dcf (when read), and each node page
read, in node order; when not found, every build status file in `lookup.read` (they back the "in
no report" sentence). `as_of` is `Last-Modified` when present (all BBS files carry it), else the
fetch time.

#### Summary (the MCP text content)

Join the applicable sentences with `' '`. `famOf(node)` is `` ` (${family})` `` or `''` when
`family` is null.

1. BBS:
   - found: `` `Legacy BBS ${branch} (${report} report) built ${name} ${version ?? '(version unknown)'}: ${verdicts}.` ``
     where `problems` = for each node in order, for each stage in `BBS_STAGES` order, with verdict
     ERROR or TIMEOUT: `` `${stage} ${verdict} on ${node}${famOf(node)}` ``. `verdicts` is the
     first four `problems` joined by `', '` plus `` ` and ${n - 4} more` `` when `n > 4`; else, when
     any stage is WARNINGS, `` `no ERROR or TIMEOUT; WARNINGS on ${nodes with a WARNINGS stage, joined by ', '}` ``;
     else `` `OK on ${node}` `` for one node, `` `OK on all ${n} nodes` `` otherwise.
   - not found: `` `${name} is in no legacy BBS ${branch} report (${lookup.read.map((s) => s.repo).join(', ')}).` ``
2. BBS propagation (found only): `propagation === null` →
   `` `BBS publishes no propagation status for the ${report} report.` ``; `[]` →
   `` `BBS lists no propagation outcome for ${name}.` ``; else
   `` `BBS propagation: ${rows.map((r) => `${r.target} ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}.` ``
3. Registry: entry → `` `The ${universe} registry has ${version} (origin ${origin}), platform families ${archs === null ? 'not recorded' : archs.length === 0 ? 'none' : archs.join(', ')}.` ``;
   absent → `` `${name} is not in the ${universe} propagation index.` ``
4. Comparison: disagreeing rows non-empty →
   `` `BBS and the registry disagree on ${rows.map((r) => `${r.family} (BBS ${r.bbs} on ${worstNodes(r).join(', ')}, registry ${r.registry_propagated ? 'propagated' : 'not propagated'})`).join('; ')}.` ``
   where `worstNodes(r)` are the row's nodes whose own `worstVerdict` equals `r.bbs`. Otherwise, when
   at least one row is comparable: `'BBS and the registry agree on every platform family both cover.'`
   Otherwise no sentence.

Example (Chromatograms, devel, 2026-10-24): "Legacy BBS devel (bioc report) built Chromatograms
1.3.5: OK on all 3 nodes. BBS propagation: source YES; mac.binary.big-sur-x86_64 YES. The bioc
registry has 1.3.5 (origin r-universe), platform families linux, win. BBS and the registry
disagree on mac (BBS OK on lconway, registry not propagated)."

#### Capability

```ts
export const pkgLegacyStatus = defineCapability({
  module: 'pkg',
  name: 'pkg_legacy_status',
  title: 'Legacy BBS build report next to the registry',
  description:
    "Side by side for one package: today's report of the legacy Bioconductor Build System (BBS) for the matching " +
    'branch (per-node INSTALL, BUILD, CHECK and BUILD BIN verdicts, each node\'s OS and platform family, BBS ' +
    'propagation outcomes, the version and commit built, the report URL) and the registry\'s propagation entry ' +
    '(version, origin, platform families that passed the gate), with the platform families where they disagree. ' +
    "universe 'bioc' compares devel (default), 'bioc-release' release. Covers BBS's software, data-experiment, " +
    'workflows and books reports; today only, no history. BBS is being retired in favour of r-universe builds. ' +
    'Package names are case-sensitive. For r-universe build and check state, and why the registry is behind, use ' +
    'pkg_status; for why an r-universe job failed use pkg_check_output.',
  input,
  data: PkgLegacyStatusDataSchema,
  handler,
});
```

`pkg_status`'s description gains, after its `pkg_repo_diff` sentence:
`'For the legacy BBS build report next to the registry use pkg_legacy_status. '`.

### `src/core/pkg/index.ts`

`capabilities` appends `pkgLegacyStatus` after `pkgMissingDeps`. `upstreams` is unchanged
(`bioconductorUpstream` is already listed). The module description becomes:

```ts
'Package build and propagation state (Bioconductor registry, r-universe), check output and build ' +
'environments of r-universe jobs, reverse dependencies and unresolvable dependencies in the propagation ' +
"index (with CRAN), release versions and download stats (bioconductor.org), how the registry's index " +
"compares with bioconductor.org's repositories, and the legacy BBS build report next to the registry.",
```

### Transports

No changes; the registry derives them.

- **MCP:** tool `pkg_legacy_status` on `/mcp`, `/mcp/pkg` and any toolset with `pkg`.
- **REST:** `GET /api/v1/pkg/legacy_status?package=Chromatograms&universe=bioc`; `universe` is
  optional. The body is the same envelope as MCP `structuredContent`.

README.md "What is live today" gains, after the `pkg_missing_deps` row:
`` | `pkg` | `pkg_legacy_status` | What does the legacy BBS report say about this package, and where does it disagree with the registry? | ``

### Upstream calls

| Call | Example URL | Size (2026-10-24) | Cache | `as_of` |
|---|---|---|---|---|
| Propagation index | `https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` | ~8 MB | 300 s + existing memo | fetch time |
| BBS build status (×4 per call) | `https://bioconductor.org/checkResults/devel/bioc-LATEST/BUILD_STATUS_DB.txt` (also `data-experiment-LATEST`, `workflows-LATEST`, `books-LATEST`; `release/…`) | 771 KB devel bioc | 3600 s + memo | Last-Modified |
| BBS propagation status | `https://bioconductor.org/checkResults/devel/bioc-LATEST/PROPAGATION_STATUS_DB.txt` | 344 KB devel bioc | 3600 s + memo | Last-Modified |
| BBS package info | `https://bioconductor.org/checkResults/devel/bioc-LATEST/Chromatograms/raw-results/info.dcf` | ~270 B | 3600 s | Last-Modified |
| BBS node page (×nodes) | `https://bioconductor.org/checkResults/devel/bioc-LATEST/lconway-NodeInfo.html` | ~6.5 KB | 3600 s | Last-Modified |

Returned, never fetched: `report_url`, e.g. `https://bioconductor.org/checkResults/devel/bioc-LATEST/Chromatograms/`.
**Verified:** that page embeds the results of every reverse dependency: 9 KB for `a4`, 517 KB for
release `edgeR`, 2.6 MB for `BiocGenerics`, 4.2 MB for `S4Vectors`, above the 2 MiB cap. That is
why the version comes from info.dcf and the OS from node pages, not from the package page.

### Fixtures

Trimmed BBS files keep whole, unchanged lines of the listed packages only; info.dcf and node pages
are verbatim; `index-legacy.json` is the live index trimmed to the listed keys, entries unchanged
(the existing `index.json` fixture is not touched; its Chromatograms entry predates the
disagreement). Record with:

```bash
BB=https://bioconductor.org/checkResults
F=test/fixtures/bioconductor/checkResults
trim() { # branch repo 'Pkg1|Pkg2'
  d=$F/$1/$2-LATEST; mkdir -p $d
  curl -sf $BB/$1/$2-LATEST/BUILD_STATUS_DB.txt | grep -E "^($3)#" > $d/BUILD_STATUS_DB.txt
  curl -sf $BB/$1/$2-LATEST/PROPAGATION_STATUS_DB.txt | { grep -E "^($3)#" || true; } > $d/PROPAGATION_STATUS_DB.txt
}
trim devel bioc 'Chromatograms|trackViewer|SEMPLR|affxparser|biomaRt|BiocSet'
trim devel data-experiment 'adductData'
trim devel workflows 'rnaseqGene'
trim devel books 'OMA'
trim release bioc 'edgeR'
trim release data-experiment 'ALL'
trim release workflows 'rnaseqGene'
trim release books 'OMA'
info() { mkdir -p $F/$1/$2-LATEST/$3/raw-results; curl -sf $BB/$1/$2-LATEST/$3/raw-results/info.dcf > $F/$1/$2-LATEST/$3/raw-results/info.dcf; }
for p in Chromatograms trackViewer SEMPLR affxparser biomaRt BiocSet; do info devel bioc $p; done
info devel data-experiment adductData
info release bioc edgeR
node() { curl -sf $BB/$1/$2-LATEST/$3-NodeInfo.html > $F/$1/$2-LATEST/$3-NodeInfo.html; }
for n in nebbiolo2 lconway taishan; do node devel bioc $n; done
node devel data-experiment nebbiolo2
for n in nebbiolo1 kunpeng2; do node release bioc $n; done
curl -sf https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json |
  jq '{Chromatograms, trackViewer, SEMPLR, affxparser, biomaRt, Fletcher2013a, adductData}' \
  > test/fixtures/registry/prop/bioc/index-legacy.json
```

`test/support/legacy-routes.ts` exports `bbsUrl(branch, repo, file)` (the full URL under
`https://bioconductor.org/checkResults/`) and `legacyRoutes: Record<string, FixtureRoute>`: every
file above at its URL with a `last-modified` header (`'Fri, 23 Oct 2026 16:51:07 GMT'` on the
devel `bioc` build status file, so a test can pin `as_of`), `BIOC_INDEX_URL` →
`registry/prop/bioc/index-legacy.json`, and `RELEASE_INDEX_URL` →
`registry/prop/bioc-release/index.json` (the existing fixture, `edgeR` 4.10.7 with archs linux,
win, mac). Like `depsRoutes`, it is never merged into the `pkg_status` tests' routes.

Scenarios and the state observed on 2026-10-24. Tests assert against the recorded files. If a
package no longer fits its scenario when recorded, substitute one that does (criterion column)
and say so in the PR.

| Scenario | Package (universe) | Criterion | Observed 2026-10-24 |
|---|---|---|---|
| Disagree: BBS OK, registry lacks mac | `Chromatograms` (bioc) | BBS clean on the mac node; registry archs without `mac` | all 10 stages OK; propagation source YES, mac binary YES; registry 1.3.5, archs linux, win → mac disagrees |
| Agree, all OK | `trackViewer` (bioc) | BBS all OK; archs linux, win, mac | 3 nodes OK; propagation UNNEEDED ×2; "agree" sentence |
| Disagree: BBS fails, registry propagated | `affxparser` (bioc) | an ERROR on a linux node; archs include linux | `checksrc ERROR on taishan`, WARNINGS elsewhere; archs linux, win, mac → linux disagrees |
| Timeout, archs not recorded | `SEMPLR` (bioc) | a TIMEOUT; entry without `archs` | `checksrc TIMEOUT on lconway (mac)`; registry_propagated null; no comparison sentence; largest result |
| Seeded, BBS failing, no propagation line | `biomaRt` (bioc) | origin `bioconductor`, archs `[]`; BBS ERROR; no propagation line | `buildsrc ERROR` on nebbiolo2 and taishan, `checksrc TIMEOUT` on lconway; propagation `[]`; "agree" |
| BBS only | `BiocSet` (bioc) | in a BBS report, not in the index | `buildsrc ERROR` on all 3 nodes; registry null |
| Data-experiment report | `adductData` (bioc) | only in `data-experiment` | 1 node (`nebbiolo2`) OK; report `data-experiment`; archs linux |
| Registry only | `Fletcher2013a` (bioc) | in the index, in no BBS devel report | legacy null; 5 sources (index + 4 status files) |
| Release | `edgeR` (bioc-release) | in release BBS and the release index | nebbiolo1, kunpeng2 OK; `git_branch` RELEASE_3_23; rows linux, mac, win (mac and win with bbs null) |
| Unknown package | `Chromatogram` (bioc) | in neither | `not_found`, "Did you mean: Chromatograms?" |

## Acceptance criteria

- [ ] `pkg_legacy_status` is registered in module `pkg` after `pkg_missing_deps`;
      `validateRegistry(modules)` passes.
- [ ] `/mcp/pkg` lists the eight existing pkg tools then `pkg_legacy_status`; `/api/v1/about`
      lists it under module `pkg`; `bioconductor` stays `used_by: ['pkg']`.
- [ ] `GET /api/v1/pkg/legacy_status?package=Chromatograms` returns 200 and deep-equals the MCP
      `structuredContent` for the same input.
- [ ] Chromatograms: `platforms` is `[{ family: 'linux', bbs: 'OK', bbs_nodes: ['nebbiolo2', 'taishan'], registry_propagated: true }, { family: 'mac', bbs: 'OK', bbs_nodes: ['lconway'], registry_propagated: false }, { family: 'win', bbs: null, bbs_nodes: [], registry_propagated: true }]`,
      and the summary contains `disagree on mac (BBS OK on lconway, registry not propagated)`.
- [ ] Chromatograms `legacy.nodes[1]` is `{ node: 'lconway', os: 'macOS 12.7.6 Monterey', arch: 'x86_64', family: 'mac', install: 'OK', buildsrc: 'OK', checksrc: 'OK', buildbin: 'OK' }`,
      `nodes[0].buildbin` is `null`, `report_url` is
      `https://bioconductor.org/checkResults/devel/bioc-LATEST/Chromatograms/`, and `commit.time` is
      ISO 8601 UTC.
- [ ] One fixture test per scenario row asserts `legacy`, `registry`, `platforms`, `sources` (URLs
      and order) and the key summary substrings in the table.
- [ ] Fletcher2013a: `legacy === null`, sources are the index then the four devel build status
      files in `BBS_REPORTS` order, and the summary says it is in no legacy BBS devel report
      (bioc, data-experiment, workflows, books).
- [ ] `Chromatogram`: REST 404 `not_found` whose message contains `Did you mean: Chromatograms?`
      and the release hint; MCP `isError` with text starting `not_found:`.
- [ ] An invalid name (`a'b`, `x`, `edgeR.`) gives REST 400 `invalid_input` with `fetch.calls`
      empty; `universe=cran` gives 400.
- [ ] `universe=bioc-release` requests only `release/…` BBS URLs and the bioc-release index.
- [ ] Every result for the scenario packages, and a synthetic five-node result (SEMPLR with two
      extra nodes added by an inline route), is under 8,192 bytes (`envelopeBytes`). The PR
      reports the SEMPLR figure.
- [ ] Memo: two calls within 3600 s request each build status file once; a third call after
      advancing the clock 3601 s requests them again. A 404 status file is not memoized.
- [ ] Errors: a 500 on any build status file, the propagation file, info.dcf or a node page gives
      `upstream_error` (no partial result); a malformed status or propagation line gives
      `upstream_error` naming the URL; info.dcf whose `Package` differs gives `upstream_error`; a
      registry 500 gives `upstream_error`.
- [ ] 404 handling: a 404 info.dcf gives `version`, `git_branch`, `commit` null; a 404 node page
      gives that node's `os`, `arch`, `family` null (and no source for it); a 404 propagation file
      gives `propagation: null`; 404s on all four status files give `upstream_error` saying BBS
      may have been retired; a 404 on `books` alone drops it from the not-found sentence.
- [ ] `pkg_status`'s description contains `pkg_legacy_status`; its output, fetches and tests are
      otherwise unchanged.
- [ ] The text-content test covers `pkg_legacy_status` (`content[1]` parses to `{ data, sources }`
      equal to `structuredContent`).
- [ ] `npm test` and `npm run typecheck` pass; `npm run build` succeeds.

## Test plan

All tests run in Node with `fixtureFetch` and `createMemoryCache`; no network.

- `test/upstreams/bbs.test.ts`:
  - `parseBbsBuildStatus`: the devel `bioc` fixture gives six packages; Chromatograms has 10
    results starting `{ node: 'nebbiolo2', stage: 'install', verdict: 'OK' }`; CRLF line endings
    parse the same; a line `x#n#deploy: OK`, `a4#n#install: FINE` and `garbage` each throw
    `upstream_error` whose message contains the URL; an empty body gives an empty map.
  - `parseBbsPropagationStatus`: `YES` → detail null; `NO, package depends on 'decoupleR' which is
    not available` → outcome `NO` and that detail; `UNNEEDED, same version is already published`;
    a malformed line throws.
  - `parseBbsPackageInfo`: the a4 text above gives version `1.61.0`, git branch `devel`, commit
    `{ id: 'bb7aa77', time: '2026-04-28T12:35:24.000Z' }`; a continuation line extends the previous
    field; a `Package` mismatch throws; a non-hex `git_last_commit` gives `commit: null`; an
    unparseable date gives `time: null`.
  - `parseBbsNodeInfo`: the `lconway`, `nebbiolo2` and `kunpeng2` fixtures; an inline page with
    Platform `x86_64-w64-mingw32` and OS `Windows Server 2022` gives `win`; a page without the
    rows gives all nulls.
  - `findBbsPackage`: `adductData` is found in `data-experiment`; a name in no report gives
    `found: undefined` with four `read`; all four 404 → `upstream_error`; the memo (counting
    `fetch.calls`), concurrent callers sharing one load, and 404 not memoized.
  - `bbsReportUrl` and `getBbsNodeInfo` reject a node or name that `pathSegment` rejects
    (`'..'`) with `invalid_input` before any fetch.
- `test/core/pkg/legacy-status.test.ts`: `worstVerdict` table (`[]` → null, `['skipped', 'NA', null]`
  → null, `['OK', 'WARNINGS']` → WARNINGS, `['TIMEOUT', 'ERROR']` → ERROR); one test per scenario
  through `invokeCapability(pkgLegacyStatus, input, deps, { transport: 'rest', usage })` with
  `fixtureFetch(legacyRoutes)`; the summary cap (an inline devel `bioc` status file giving
  BiocSet two nodes with `install` ERROR, `buildsrc` ERROR and `checksrc` TIMEOUT each lists four
  and `and 2 more`); the size checks; the error and
  404 cases above (each overriding one route); usage records one event with no input values.
- `test/transports/pkg.test.ts`: the two exact tool lists gain `pkg_legacy_status`; REST vs MCP
  equality for Chromatograms with `makeTestApp({ routes: legacyRoutes, extraModules: [pkgModule] })`;
  REST 400 and 404 bodies; the release fetch list.
- `test/transports/text-content.test.ts`: `CALLS` gains `['pkg_legacy_status', { package: 'Chromatograms' }]`;
  `call` merges `legacyRoutes` last for that tool (as it merges `depsRoutes` for
  `DEPS_TOOLS`).

## Risks

- **BBS retirement.** The reports will disappear. 404s are handled (missing reports drop out;
  all four missing is a clear `upstream_error`), so the tool degrades to an explicit message
  rather than wrong data. When BBS is gone the tool should be removed; the description says BBS is
  being retired.
- **HTML scraping of node pages.** OS and arch come from three labelled table rows. A layout
  change makes them `null`, never wrong: `family` then falls back to nothing and the platform
  rows lose that node. The verdicts come from the plain-text status file.
- **Family-level comparison hides nodes.** `linux` merges x86_64 (`nebbiolo2`) and aarch64
  (`taishan`); affxparser is ERROR on taishan only. The summary names the worst nodes and `nodes`
  has every verdict; the registry's archs are family-level too, so a finer comparison has nothing
  to compare against.
- **Release has no mac node** (2026-10-24), so release comparisons cover linux only and mac and
  win rows show `bbs: null`.
- **Cold cost.** A cold call reads up to about 830 KB of BBS text (devel) plus the 8 MB index.
  The BBS parse is about 6 ms in Node; both are memoized per isolate, the BBS files for an hour.
  The Worker figure is unmeasured until deploy; the PR says so.
- **Fixture drift.** BBS state changes daily; the scenario table gives criteria for
  substitutes. Trimmed status files make "in no report" true by construction for test names, so
  the Fletcher2013a row is checked against the live files when recorded.
- **Upstream strings in output.** OS strings, propagation details and versions are passed through
  as data. The only URLs built from upstream data are node page paths, through `pathSegment()`.
