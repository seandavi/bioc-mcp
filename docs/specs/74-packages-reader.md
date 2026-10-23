# Spec #74: One PACKAGES reader for repo diff and the dependency lists

Issue: [seandavi/bioc-mcp#74](https://github.com/seandavi/bioc-mcp/issues/74). It also applies
security-r0-1 from [#70](https://github.com/seandavi/bioc-mcp/issues/70) (review follow-ups on
#50). Builds on [Spec #50](50-repo-diff.md) (`parsePackagesFile`, `getPackagesFile`) and
[Spec #52](52-revdeps.md) (`getPackageList`, `SharedLoads`). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

The following was checked on 2026-10-22. **Verified** marks what was run, not just reasoned about:

- **Verified** (live `curl`, 2026-10-22, then a Node 26 replica of the Spec #50 strict parser):
  | File | Bytes | Stanzas | Distinct names | Strict-parse failures |
  |---|---|---|---|---|
  | `cloud.r-project.org/src/contrib/PACKAGES` | 7,396,971 | 25,528 | 25,498 | duplicates only |
  | `bioconductor.org/packages/devel/data/annotation/…/PACKAGES` | 218,067 | 926 | 926 | none |
  | `bioconductor.org/packages/devel/data/experiment/…/PACKAGES` | 97,357 | 434 | 434 | none |
  | `bioconductor.org/packages/release/data/annotation/…/PACKAGES` | 218,055 | 928 | 928 | none |
  | `bioconductor.org/packages/3.23/bioc/…/PACKAGES` | 944,985 | not parsed | | |

  Every CRAN name, every CRAN version and every stanza shape passes the Spec #50 rules (one
  `Package`, one `Version`, `PackageNameSchema`, `/^\d+([.-]\d+)*$/`). The only failure is the
  "same package in two stanzas" rule: 15 recommended packages (`boot`, `class`, `cluster`,
  `codetools`, `foreign`, `KernSmooth`, `lattice`, `MASS`, `Matrix`, `mgcv`, `nlme`, `nnet`,
  `rpart`, `spatial`, `survival`) appear three times. Each has exactly one stanza without a `Path`
  field and two with `Path: 4.7.0/Recommended` and `Path: 4.6.2/Recommended`; all three carry the
  same `Version`. No name appears only in `Path` stanzas. The recorded CRAN fixture
  (`test/fixtures/cran/src/contrib/PACKAGES`, 200 stanzas, 186 names) has the same shape for 7 of
  them. None of the files contains a `\r`, U+2028 or U+2029.
- **Verified** (Node 26): `/^([^\s:]+):[ \t]*(.*)$/` (today's `PACKAGES_FIELD`) on
  `'Package:' + ' '.repeat(n) + '\r' + 'xxxxxxxxxx y'` takes 44 ms at n = 10,000, 126 ms at
  20,000 and 535 ms at 40,000 (quadratic). `/^([^\s:]+):(.*)$/s` on the same strings takes under
  0.05 ms, and `match[2].trim()` is `'xxxxxxxxxx y'`.
- **Verified** (Node 26, live CRAN body): splitting on `/\r?\n/` and running
  `/^([^\s:]+):(.*)$/s` on every field line takes 26–37 ms; today's names-only `matchAll` takes
  about 6 ms. Not measured in workerd.

## Goal

1. **One reader.** `src/upstreams/packages-file.ts` owns the only PACKAGES parser and the only
   PACKAGES loader. The loader goes through `SharedLoads` (in-flight sharing with a deadline,
   memo per cache and URL until fetchedAt + TTL) and resolves to Package → Version. CRAN, the two
   bioconductor.org data repositories (`pkg_missing_deps`) and the four bioconductor.org
   repositories of each version (`pkg_repo_diff`) all use it. `bioconductor.ts` keeps only
   path-building wrappers; `parsePackagesFileNames` and the bioconductor-specific parser go.
2. **Strict parse for every caller.** The Spec #50 rules apply to CRAN and the data repositories
   too, with one change that CRAN needs: a name may repeat across stanzas when the repeats carry a
   `Path` field.
3. **#70 security-r0-1.** The field regex no longer backtracks, so a line with a long run of spaces
   before a lone `\r` costs linear time.

No tool's input, output schema, MCP name, REST route, summary or sources change.

## Non-goals

- **#70 code-r0-1** (a test comment in `test/core/pkg/repo-diff.test.ts`). It is unrelated to the
  reader; #70 stays open for it. The PR says `Refs #70`, not `Closes #70`.
- **Keeping more fields than `Package` and `Version`.** Dependencies still come from the
  propagation index.
- **Changing `SharedLoads`, `fetchUpstream`, any `Upstream` constant** (TTL, timeout, `maxBytes`,
  description) or the `diffRepos` memo in `repo-diff.ts`.
- **Re-recording fixtures.** The existing PACKAGES fixtures already cover every case; new cases are
  inline strings in tests.
- **Editing earlier specs** (`50-repo-diff.md`, `52-revdeps.md`). They record what those issues
  built; this spec records the change.

## Design

### Files

```
src/upstreams/packages-file.ts        PackageList, parsePackagesFileNames(), getPackageList() replaced by
                                           PackagesFile, parsePackagesFile(), getPackagesFile()
src/upstreams/bioconductor.ts         - PACKAGES_FIELD, PACKAGES_VERSION, parsePackagesFile(), getPackagesFile();
                                           + getBiocPackagesFile(); getBiocDataPackageList() renamed getBiocDataPackagesFile()
src/upstreams/cran.ts                 getCranPackageList() renamed getCranPackagesFile()
src/core/pkg/repo-diff.ts             loadRepoDiff reads PackagesFile values from getBiocPackagesFile
src/core/pkg/missing-deps.ts          the renamed getters; `.names` → `.versions`
test/upstreams/packages-file.test.ts  parsePackagesFile tests (moved from bioconductor.test.ts, plus Path,
                                           duplicates, backtracking); getPackagesFile tests (renamed, allowEmpty)
test/upstreams/bioconductor.test.ts   - parsePackagesFile tests; getPackagesFile → getBiocPackagesFile;
                                           getBiocDataPackageList → getBiocDataPackagesFile
test/core/pkg/repo-diff.test.ts       + concurrent loadRepoDiff calls fetch each PACKAGES once
```

Nothing else changes. `src/core/pkg/index.ts`, the registry, the transports, the README and the
fixtures are untouched. No package is added; the code uses only what these files already import
(`PackageNameSchema`, `CapabilityError`, `fetchUpstream`, `SharedLoads`).

### `src/upstreams/packages-file.ts`

Replace the whole file's exports with these. The module comment on `getPackagesFile` replaces the
one on `getPackageList`.

```ts
import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { fetchUpstream, type Upstream, type UpstreamResponseMeta } from './http';
import { PackageNameSchema } from './package-name';
import { SharedLoads } from './shared-load';

export interface PackagesFile {
  response: UpstreamResponseMeta; // for sourceFor(); the body is dropped once parsed
  versions: ReadonlyMap<string, string>; // Package → Version, in order of first appearance
}

/**
 * Package → Version from a PACKAGES (DCF) body, in order of first appearance; throws
 * upstream_error (with `url`) on any deviation. A name may repeat only in stanzas that carry
 * `Path` (CRAN lists each recommended package again under `Path: <R version>/Recommended`).
 */
export function parsePackagesFile(body: string, upstream: Upstream, url: string): Map<string, string>;

/**
 * GET `path` on `upstream` through fetchUpstream, parsed with parsePackagesFile and memoized per
 * cache and URL until the response's fetchedAt + upstream.ttlSeconds. Concurrent callers on a cold
 * or expired entry share one load (SharedLoads). A file with no packages is upstream_error unless
 * `allowEmpty`.
 */
export async function getPackagesFile(
  deps: Deps,
  upstream: Upstream,
  path: string,
  options: { allowEmpty?: boolean } = {},
): Promise<PackagesFile>;
```

#### `parsePackagesFile(body, upstream, url)`

Every violation throws

```ts
new CapabilityError(
  'upstream_error',
  `${upstream.name} returned a PACKAGES file in an unexpected format (${url})`,
  { upstream: upstream.id, url },
)
```

so the bioconductor.org message and details are what Spec #50 produced, and CRAN's read
`CRAN returned a PACKAGES file in an unexpected format (https://cloud.r-project.org/src/contrib/PACKAGES)`.

Module constants:

```ts
// dotAll and no `m` flag: `(.*)` runs to the end of the line and `$` is the end of input, so
// nothing backtracks (the old /^([^\s:]+):[ \t]*(.*)$/ was quadratic on spaces before a lone \r).
const PACKAGES_FIELD = /^([^\s:]+):(.*)$/s;
const PACKAGES_VERSION = /^\d+([.-]\d+)*$/;
```

Rules (Spec #50's, with rule 3's regex and rule 4's duplicate check changed):

1. `lines = body.split(/\r?\n/)`. A line matching `/^\s*$/` ends the current stanza. Consecutive
   blank lines are allowed; an empty or all-blank body gives an empty Map.
2. A line starting with a space or tab continues the previous field: allowed only inside a stanza,
   otherwise a violation. Its content is ignored.
3. Any other line must match `PACKAGES_FIELD`, otherwise a violation. It opens the stanza if none
   is open. The value is `match[2]!.trim()`. Field `Package` appends the value to the stanza's
   names, `Version` to its versions, and `Path` marks the stanza as a `Path` stanza (its value is
   not checked). Other fields are ignored. A stray `\r`, U+2028 or U+2029 inside a `Package` or
   `Version` value is kept by the regex and then fails rule 4 (not a valid name or version);
   at either end it is removed by `trim()`.
4. At the end of each stanza (blank line or end of body): exactly one `Package` and exactly one
   `Version` were seen, the name passes `PackageNameSchema` and the version matches
   `PACKAGES_VERSION`, otherwise a violation. `Path` stanzas are checked the same way. Then, with
   `fromPath: Set<string>` holding the names whose current entry came from a `Path` stanza:
   - the name is new: `versions.set(name, version)`; if this is a `Path` stanza,
     `fromPath.add(name)`;
   - the name is known and this is a `Path` stanza: nothing changes;
   - the name is known, this stanza has no `Path`, and `fromPath.has(name)`:
     `versions.set(name, version)` (the Map keeps the name's first position) and
     `fromPath.delete(name)`;
   - the name is known, this stanza has no `Path`, and the entry came from a stanza without
     `Path`: a violation (two stanzas without `Path` for one name).

   So the version is the one from the stanza without `Path`, or, for a name that appears only in
   `Path` stanzas, from the first of them. Reset the stanza's names, versions and `Path` flag.
5. Return the Map. Use a `Map`, never an object literal (Spec #50).

Write it as Spec #50's function did: a `malformed()` factory, an `endStanza()` closure and one loop
over the lines. The `/^\s*$/` and `PACKAGES_FIELD` tests are both anchored at position 0 and run in
time linear in the line.

#### `getPackagesFile(deps, upstream, path, options)`

1. `const packagesFiles = new SharedLoads<PackagesFile>()` at module scope.
   `url = new URL(path, upstream.baseUrl).href`.
   `file = await packagesFiles.get(deps, upstream, url, 'the PACKAGES file', () => loadPackagesFile(deps, upstream, path, url))`.
2. `loadPackagesFile` is today's `loadPackageList` with two changes: it calls
   `parsePackagesFile(response.body, upstream, url)` instead of `parsePackagesFileNames`, and it
   has no empty check. It still maps a `not_found` `CapabilityError` to
   `CapabilityError('upstream_error', \`${upstream.name} has no PACKAGES file at ${url}\`, { upstream: upstream.id, url })`,
   lets every other error propagate, and resolves to `{ response: <the response without body>, versions }`.
3. After the shared load, if `file.versions.size === 0 && !options.allowEmpty`, throw
   `CapabilityError('upstream_error', \`${upstream.name} returned a PACKAGES file with no packages (${url})\`, { upstream: upstream.id, url })`.
   Otherwise return `file`.

The empty check runs per call, outside the shared load, so two callers of one URL with different
`allowEmpty` each get their own answer from one memo entry. An empty file is therefore memoized
for the TTL, but `fetchUpstream` already caches the same 200 body for that TTL, so a retry inside
the TTL failed before this change too.

### `src/upstreams/bioconductor.ts`

- Remove `PACKAGES_FIELD`, `PACKAGES_VERSION`, `parsePackagesFile` and `getPackagesFile`, and the
  `PackageNameSchema` import (nothing else in the file uses it; check with `tsc`).
- Import `{ getPackagesFile, type PackagesFile } from './packages-file'` instead of
  `getPackageList, type PackageList`.
- `BIOC_REPOS`, `BiocRepo`, `BIOC_REPO_PATHS`, `BIOC_VERSION`, `packagesPath`, `BIOC_DATA_REPOS`,
  `BiocDataRepo` and `biocDataRepoPath` stay as they are.
- Rename `getBiocDataPackageList` to `getBiocDataPackagesFile`:

  ```ts
  /** Package → Version for a data repository's PACKAGES file; an empty file is upstream_error. */
  export function getBiocDataPackagesFile(deps: Deps, universe: Universe, repo: BiocDataRepo): Promise<PackagesFile> {
    return getPackagesFile(deps, bioconductorUpstream, biocDataRepoPath(universe, repo));
  }
  ```

- Add, under "Source PACKAGES indexes", in place of the old `getPackagesFile`:

  ```ts
  /**
   * Package → Version for packages/{version}/{repo path}/src/contrib/PACKAGES. An empty file is
   * allowed (a new version's books or workflows repository can be empty).
   */
  export async function getBiocPackagesFile(deps: Deps, biocVersion: string, repo: BiocRepo): Promise<PackagesFile> {
    return getPackagesFile(deps, bioconductorUpstream, packagesPath(biocVersion, repo), { allowEmpty: true });
  }
  ```

  It must be `async`: `packagesPath` throws synchronously on a bad version, and callers (and the
  tests) expect a rejected promise with no fetch.

`allowEmpty: true` keeps today's repo-diff behaviour: Spec #50's parser accepted an empty body,
and the `pkg_repo_diff size limit` test serves three empty PACKAGES files.

The 404 message changes from Spec #50's
`bioconductor.org has no books PACKAGES for Bioconductor 3.25 (<url>)` to the shared
`bioconductor.org has no PACKAGES file at <url>`. The URL names both the version and the
repository path, so nothing is lost; the code (`upstream_error`) and details
(`{ upstream: 'bioconductor', url }`) are unchanged.

### `src/upstreams/cran.ts`

Import `{ getPackagesFile, type PackagesFile }`. Rename the getter:

```ts
/** GET src/contrib/PACKAGES on CRAN; an empty file is upstream_error. */
export function getCranPackagesFile(deps: Deps): Promise<PackagesFile> {
  return getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
}
```

`cranUpstream` is unchanged; its description ("read for package names only") is still true of
what the tools use.

### `src/core/pkg/missing-deps.ts`

- Imports: `getBiocDataPackagesFile` from `bioconductor`, `getCranPackagesFile` from `cran`.
- The `Promise.all` calls the renamed getters with the same arguments.
- `cran.names.has(name)`, `annotation.names.has(name)`, `experiment.names.has(name)` become
  `….versions.has(name)`; the three `….names.size` in `checked_against` become `….versions.size`.

The result is unchanged on the recorded fixtures: the strict parse yields the same 186 CRAN names,
`GO.db`, and the two experiment names.

### `src/core/pkg/repo-diff.ts`

- Import `getBiocPackagesFile` instead of `getPackagesFile` and `parsePackagesFile`.
- In `loadRepoDiff`:

  ```ts
  const files = await Promise.all(BIOC_REPOS.map((repo) => getBiocPackagesFile(deps, bioconductorVersion, repo)));
  …
  const key = [bioconductorVersion, ...files.map((f) => `${f.response.url} ${f.response.fetchedAt}`)].join('\n');
  …
  diff: diffRepos(
    index.packages,
    files.map((file, i) => ({ repo: BIOC_REPOS[i]!, versions: file.versions })),
    index.response.url,
  ),
  …
  sources: [sourceFor(index.response), sourceFor(configResponse), ...files.map((file) => sourceFor(file.response))],
  ```

  Update the comment above `key`: a memoized PACKAGES file keeps its `fetchedAt`, so the key
  changes only when a PACKAGES file is reloaded. `diffRepos`, the `repoDiffs` WeakMap, the schemas
  and the handler are unchanged.

A memo hit now skips the cache read and the parse of four PACKAGES bodies (about 1 MB for devel
software), and concurrent cold calls share one fetch and parse per file.

### MCP tools and REST routes

No change. `pkg_repo_diff` (`GET /api/v1/pkg/repo_diff`) and `pkg_missing_deps`
(`GET /api/v1/pkg/missing_deps`) keep their input schemas, output schemas, summaries and sources.
Only the text of two `upstream_error` messages changes (the bioconductor.org 404 above; a CRAN or
data-repository body with a stanza lacking `Package` now reads "unexpected format" instead of
"no packages").

### Upstream calls

The same URLs as today, for example:

| Caller | URL | Through | `allowEmpty` |
|---|---|---|---|
| `getCranPackagesFile` | `https://cloud.r-project.org/src/contrib/PACKAGES` | `getPackagesFile` | no |
| `getBiocDataPackagesFile(deps, 'bioc', 'data/annotation')` | `https://bioconductor.org/packages/devel/data/annotation/src/contrib/PACKAGES` | `getPackagesFile` | no |
| `getBiocDataPackagesFile(deps, 'bioc-release', 'data/experiment')` | `https://bioconductor.org/packages/release/data/experiment/src/contrib/PACKAGES` | `getPackagesFile` | no |
| `getBiocPackagesFile(deps, '3.24', 'bioc')` | `https://bioconductor.org/packages/3.24/bioc/src/contrib/PACKAGES` | `getPackagesFile` | yes |
| `getBiocPackagesFile(deps, '3.23', 'data-experiment')` | `https://bioconductor.org/packages/3.23/data/experiment/src/contrib/PACKAGES` | `getPackagesFile` | yes |

The devel `data/experiment` URL and the `3.24` one are different URLs with different memo entries
even when 3.24 is devel; that was already true of the response cache.

### Fixtures

None recorded. Existing ones used: `test/fixtures/cran/src/contrib/PACKAGES`,
`test/fixtures/bioconductor/packages/{3.23,3.24}/{bioc,data/experiment,workflows,books}/src/contrib/PACKAGES`,
`test/fixtures/bioconductor/packages/devel/data/{annotation,experiment}/src/contrib/PACKAGES`.

## Acceptance criteria

- [ ] `src/upstreams/packages-file.ts` exports `PackagesFile`, `parsePackagesFile` and
  `getPackagesFile` with the signatures above, and nothing named `PackageList`,
  `parsePackagesFileNames` or `getPackageList` exists in `src/` or `test/`
  (`grep -rn 'PackageList\b\|parsePackagesFileNames\|getPackageList\|getCranPackageList\|getBiocDataPackageList' src test`
  prints nothing).
- [ ] `src/upstreams/bioconductor.ts` contains no PACKAGES parser: no `PACKAGES_FIELD`, no
  `PACKAGES_VERSION`, no `parsePackagesFile`, no function named `getPackagesFile`.
- [ ] `PACKAGES_FIELD` is `/^([^\s:]+):(.*)$/s` and is defined only in `packages-file.ts`.
- [ ] `parsePackagesFile` on the CRAN fixture returns 186 entries, `MASS` → `7.3-66`, in order of
  first appearance; on the 3.24 software fixture it returns the ten `[name, version]` pairs the
  Spec #50 test lists, in file order.
- [ ] Every Spec #50 violation case (the twelve in today's `parsePackagesFile` `test.each`) throws
  `upstream_error` whose message contains the URL and whose details are
  `{ upstream: 'bioconductor', url }` under `bioconductorUpstream`. One case (`'Version: 1.0\n'`)
  under `cranUpstream` throws with message
  `CRAN returned a PACKAGES file in an unexpected format (<url>)` and details
  `{ upstream: 'cran', url }`.
- [ ] A name repeated in `Path` stanzas parses: the stanza without `Path` gives the version
  whether it comes first or last, the name keeps its first position, and a name only in `Path`
  stanzas takes the first one's version. Two stanzas without `Path` for one name throw, also when
  a `Path` stanza sits between them. A `Path` stanza with an invalid name or version, or without
  `Version`, throws.
- [ ] `'Package:' + ' '.repeat(200_000) + '\r' + 'xxxxxxxxxx y\nVersion: 1.0\n'` throws
  `upstream_error` in under 250 ms.
- [ ] `getPackagesFile` keeps every `getPackageList` behaviour test (memo hit and `fromCache`, no
  `body` on `response`, concurrent sharing, shared failure not cached, never-settling load times
  out owner and joiner, isolation per cache, expiry at fetchedAt + TTL, 404 message, 500 not
  memoized), now asserting on `versions`.
- [ ] Without `allowEmpty`, an empty body and an all-blank body are `upstream_error`
  "`<name>` returned a PACKAGES file with no packages (`<url>`)"; with `allowEmpty: true` they
  return `versions.size === 0`. A body `'Version: 1\n'` is `upstream_error` "unexpected format"
  either way.
- [ ] `getBiocPackagesFile(deps, '3.24', 'data-experiment')` resolves to the fixture's entries
  with `response.lastModified === '2026-10-22T21:31:29.000Z'` and no `body`; a 404 is
  `upstream_error` with message `bioconductor.org has no PACKAGES file at <url>`; a bad version
  (`'3.24/../x'`, `'devel'`) rejects with `upstream_error` and makes no fetch; an empty 200 body
  resolves with `versions.size === 0`.
- [ ] `getBiocDataPackagesFile(deps, 'bioc', 'data/annotation')` resolves to
  `[...versions.keys()]` equal to `['GO.db']`, with the same url, lastModified and single fetch as
  today's test.
- [ ] Two concurrent `loadRepoDiff(deps, 'bioc')` calls on a fresh cache fetch each of the four
  3.24 PACKAGES URLs exactly once.
- [ ] Every existing `pkg_repo_diff` and `pkg_missing_deps` test passes with no change to its
  expectations (the size-limit test still serves three empty PACKAGES bodies).
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.

## Test plan

All tests use recorded fixtures or inline strings through `fixtureFetch`; none touch the network.

`test/upstreams/packages-file.test.ts`:

- `describe('parsePackagesFile')`, with `const URL = CRAN_PACKAGES_URL` and `cranUpstream` unless
  noted:
  - the CRAN fixture: 200 `Package:` lines, 186 entries, `versions.get('MASS') === '7.3-66'`,
    and `[...keys]` equals the distinct `Package:` values in order of first appearance;
  - moved from `bioconductor.test.ts`, unchanged except for the extra `bioconductorUpstream`
    argument: the 3.24 software fixture, continuation lines ignored, CRLF equals LF, consecutive
    blank lines and empty bodies, and the twelve-case violation `test.each` (expect
    `details` `{ upstream: 'bioconductor', url: URL }` with the 3.24 software URL);
  - one violation case run with `cranUpstream`, expecting the message
    `CRAN returned a PACKAGES file in an unexpected format (${CRAN_PACKAGES_URL})` and details
    `{ upstream: 'cran', url: CRAN_PACKAGES_URL }`;
  - kept from today's `parsePackagesFileNames` tests: a trailing space after the name; an indented
    `Package:` line is a continuation and is ignored;
  - `Path`: `stanza('MASS','7.3-66') + '\n' + stanza with Path 4.7.0/Recommended and version 7.3-65`
    → `MASS` → `7.3-66`; the same with the `Path` stanza first → `7.3-66`, and the key order of a
    body `Path(MASS) / abc / MASS` is `['MASS', 'abc']`; only `Path` stanzas `7.3-65`, `7.3-64` →
    `7.3-65`; two plain `MASS` stanzas → throws; plain, `Path`, plain → throws; a `Path` stanza
    with version `1.0a`, with name `1abc`, or without `Version` → throws;
  - backtracking: the 200,000-space body above throws `upstream_error`, timed with
    `performance.now()` to under 250 ms;
  - a `Package` value with a `\r` in the middle (`'Package: ab\rcd\nVersion: 1.0\n'`) throws.
- `describe('getPackagesFile')`: today's `getPackageList` tests renamed, with `.names` →
  `.versions` (`toBe` identity checks on `versions`; `size` 186). The "a list with no packages"
  test's body changes from `'Version: 1\n'` (now a stanza without `Package`, so "unexpected
  format") to `''`, keeping its exact expected message; add: `'\n\n  \n'` gives the same error;
  with `{ allowEmpty: true }` an empty body resolves to `versions.size === 0`; `'Version: 1\n'`,
  with and without `{ allowEmpty: true }`, is `upstream_error` whose message is
  `CRAN returned a PACKAGES file in an unexpected format (${CRAN_PACKAGES_URL})`.

`test/upstreams/bioconductor.test.ts`: drop `parsePackagesFile` and `getPackagesFile` from the
import; `describe('getPackagesFile')` becomes `describe('getBiocPackagesFile')` with the
acceptance cases above (it reads `[...file.versions]` against
`parsePackagesFile(readBiocFixture(…), bioconductorUpstream, url)`, checks `'body' in file.response`
is false, and expects the new 404 message exactly); `describe('getBiocDataPackageList')` becomes
`describe('getBiocDataPackagesFile')` reading `[...list.versions.keys()]`. The `packagesPath` and
`biocDataRepoPath` tests are unchanged.

`test/core/pkg/repo-diff.test.ts`: add "concurrent loadRepoDiff calls fetch each PACKAGES file
once": `makeDeps(fixtureRoutes())`, `await Promise.all([loadRepoDiff(deps, 'bioc'), loadRepoDiff(deps, 'bioc')])`,
then for each of `packagesUrl('3.24', p)` with p in `bioc`, `data/experiment`, `workflows`,
`books`, `fetch.calls.filter((u) => u === url)` has length 1, and both results' `diff` are equal
(`toEqual`). Nothing else in the file changes.

`test/core/pkg/missing-deps.test.ts`: no change; it must pass as is.

Commands: `npm test`, `npm run typecheck`, `npm run build`, and the grep in the first acceptance
criterion.

## Risks

- **A strict parse makes CRAN a single point of failure for `pkg_missing_deps`.** Today one odd
  CRAN stanza is skipped; after this change it fails the tool with `upstream_error` for up to the
  TTL. The issue asks for strict, and the live file passes today (verified above). R's own checks
  on package names and versions should keep CRAN inside rule 4 (reasoned, not verified). If CRAN ever adds a stanza shape
  this rejects, the error names the URL, so it is visible rather than a silent wrong answer.
- **The `Path` rule is inferred from one day's CRAN file.** It matches how `write_PACKAGES` with
  subdirectories lists packages (the `Path` stanza describes a copy under a subdirectory), but no
  R documentation was read for this spec. Names only in `Path` stanzas do not exist today; the rule
  for them (first stanza wins) is a choice, not an observation.
- **CPU.** The strict parse of CRAN's 7.4 MB takes about 30 ms in Node against 6 ms for the names
  regex, once per isolate per hour thanks to the memo. Not measured in workerd.
- **Error message text changes** for the bioconductor.org PACKAGES 404 and for a CRAN or data body
  with no `Package` line. Codes and details are unchanged. `grep -rn 'PACKAGES for Bioconductor\|no packages' test`
  finds only the two assertions this spec rewrites (`bioconductor.test.ts` 404 test,
  `packages-file.test.ts` "a list with no packages"); `missing-deps.test.ts`'s
  `'Version: 1\n'` case checks only the code.
