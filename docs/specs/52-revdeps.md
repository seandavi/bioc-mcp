# Spec #52: `pkg_revdeps` and `pkg_missing_deps`

Issue: [seandavi/bioc-mcp#52](https://github.com/seandavi/bioc-mcp/issues/52), part of #48 (tester
feedback, round 1). Related: [bioc-registry#56](https://github.com/seandavi/bioc-registry/issues/56)
(the deps rule treats unknown dependencies as satisfied). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Size discipline": lists are paginated with a cursor). Conventions: [AGENTS.md](../../AGENTS.md).
Builds on the `pkg` module ([spec #6](6-pkg-status.md), [spec #8](8-pkg-release-info.md)).

Every upstream shape below was checked on 2026-10-22 against the live endpoints. Notes marked
**Verified** record what the implementer must account for. No new npm package is needed.

## Goal

The tester asked two questions:

- "If S4Vectors fails today, what's blocked downstream?"
- "Which packages wait on a dependency that isn't in the index?" (bioc-registry#56)

This spec adds two `pkg` capabilities to answer them. Both read the registry's propagation index,
which `pkg_status` already loads and memoizes.

- **`pkg_revdeps(package, universe?, depth?, cursor?)`** lists the packages in the propagation
  index that depend on `package` through a hard dependency (Depends, Imports or LinkingTo), direct
  and transitive. It gives a count per level and a split of the direct ones by field. It works for
  a name that is not in the index, such as `BiocSet` in devel today. Long lists are paged.
- **`pkg_missing_deps(universe?, cursor?)`** lists the index packages with a hard dependency that
  is in none of these places: the index, base R, CRAN's current package list, or the Bioconductor
  annotation and experiment data repositories. It also ranks the missing dependencies by how many
  packages need them, and it lists what it does not check. The CRAN check matches by name only,
  so it is best-effort.

## Non-goals

- **Suggests and Enhances.** Neither tool follows them. Only Depends, Imports and LinkingTo are
  hard dependencies.
- **Version requirements.** `limma (>= 3.60)` is satisfied by any `limma`.
- **CRAN reverse dependencies.** `pkg_revdeps` lists index packages only.
- **The dependency path.** `pkg_revdeps` does not say which chain links a transitive dependent to
  the package. The agent can call `pkg_revdeps` on an intermediate package to find out.
- **The build state of each dependent.** Use `pkg_status` for that.
- **Telling "removed from Bioconductor" apart from "not propagated yet".** A missing dependency
  that is still in bioconductor.org's software repository counts as missing, because it cannot be
  installed from the registry. The bioconductor.org software repository, the workflows repository
  and the books repository are not consulted.
- **Reading `/repo/{universe}/VIEWS`.** The registry builds VIEWS from the same index. VIEWS has
  `dependsOnMe`, `importsMe` and `suggestsMe`, but no `linkingToMe`. It is 4.7 MB of text with
  `cache-control: no-store`. Transitive dependents need the whole graph anyway, and the index
  `desc` field already holds that graph. **Verified:** S4Vectors' VIEWS `dependsOnMe` and
  `importsMe` match the index-derived dependents.
- **Any change to `src/upstreams/http.ts` or `cache.ts`, `src/envelope.ts`, or the transports.**
  `registry.ts` changes only by moving its in-flight memo into `shared-load.ts`; behaviour is
  unchanged.
- **An MCP prompt or resource.**

## Design

### Files

```
src/upstreams/shared-load.ts          NEW  SharedLoads: per-cache memo of in-flight loads with a load deadline
                                           (moved out of registry.ts; getPropagationIndex uses it too)
src/upstreams/packages-file.ts        NEW  PackageList, parsePackagesFileNames(), getPackageList()
src/upstreams/cran.ts                 NEW  cranUpstream, CRAN_BASE_URL, getCranPackageList()
src/upstreams/bioconductor.ts         + BIOC_DATA_REPOS, BiocDataRepo, biocDataRepoPath(), getBiocDataPackageList()
src/core/pkg/dependency-graph.ts      NEW  HARD_DEPENDENCY_FIELDS, HardDependencyField, BASE_R_PACKAGES,
                                           parseDependencyField(), DependencyGraph, dependencyGraph(),
                                           ReverseDependency, reverseDependencies()
src/core/pkg/paging.ts                NEW  CursorSchema, parseCursor(), takePage(), packagesPhrase()
src/core/pkg/revdeps.ts               NEW  pkgRevdeps, PkgRevdepsDataSchema
src/core/pkg/missing-deps.ts          NEW  pkgMissingDeps, PkgMissingDepsDataSchema, MISSING_DEPS_NOT_CHECKED
src/core/pkg/index.ts                 upstreams += cranUpstream; capabilities += pkgRevdeps, pkgMissingDeps;
                                           new description
README.md                             "What is live today": two rows after pkg_downloads
test/support/deps-routes.ts           NEW  route map and URL constants for the new fixtures
test/upstreams/packages-file.test.ts  NEW
test/upstreams/bioconductor.test.ts   + biocDataRepoPath, getBiocDataPackageList
test/core/pkg/dependency-graph.test.ts NEW
test/core/pkg/paging.test.ts          NEW
test/core/pkg/revdeps.test.ts         NEW
test/core/pkg/missing-deps.test.ts    NEW
test/transports/text-content.test.ts  DEPS_TOOLS + CALLS rows for the two new tools
test/transports/pkg.test.ts           tools lists, REST/MCP equality, 400/404 bodies, about upstreams
test/fixtures/registry/prop/bioc/index-deps.json                          NEW (trimmed, see Fixtures)
test/fixtures/cran/src/contrib/PACKAGES                                   NEW (trimmed)
test/fixtures/bioconductor/packages/devel/data/annotation/src/contrib/PACKAGES  NEW (trimmed)
test/fixtures/bioconductor/packages/devel/data/experiment/src/contrib/PACKAGES  NEW (trimmed)
```

Import zod as `import * as z from 'zod'`. Fetch only through `fetchUpstream`. Every upstream path
in this spec is built from constants and enum values, never from a caller's free text, so no new
`pathSegment()` call is needed. `package` is never put in a URL.

### `src/upstreams/packages-file.ts`

A CRAN-style `PACKAGES` file is made of stanzas in Debian control format. Only the set of
`Package:` names is needed.

```ts
export interface PackageList {
  response: UpstreamResponseMeta; // for sourceFor(); the body is dropped once parsed
  names: ReadonlySet<string>;
}

/** The value of every `Package:` line (at line start), as a Set. Accepts \n and \r\n. */
export function parsePackagesFileNames(body: string): Set<string>;

/**
 * GET `path` on `upstream` through fetchUpstream, parsed with parsePackagesFileNames and memoized
 * per cache and URL until the response's fetchedAt + upstream.ttlSeconds.
 */
export async function getPackageList(deps: Deps, upstream: Upstream, path: string): Promise<PackageList>;
```

`parsePackagesFileNames` uses the regex `/^Package:[ \t]*(\S+)[ \t]*\r?$/gm` and adds group 1 of
each match. Duplicate names collapse: CRAN lists recommended packages such as `MASS` and `Matrix`
twice. **Verified:** CRAN's file has 25,528 `Package:` lines and 25,498 distinct names.

`getPackageList` behaviour:

1. Memo: `const parsedLists = new WeakMap<UpstreamCache, Map<string, { expiresAt: number; list: PackageList }>>()`,
   keyed by `deps.cache` and then by the absolute URL (`new URL(path, upstream.baseUrl).href`).
   On a hit with `deps.now().getTime() < expiresAt`, return
   `{ names: list.names, response: { ...list.response, fromCache: true } }`. Only settled
   successes are stored. The memo holds the in-flight load Promise, so concurrent callers on a
   cold or expired entry share one fetch and one parse. CRAN's file is 7.4 MB and the cap allows
   16 MiB, and each independent load transiently holds several copies of the body, so N concurrent
   cold calls from one client would multiply memory use on a 128 MB isolate. A joiner waits at
   most the load deadline (`timeoutMs` + 5 s), so a stalled or cancelled owner cannot hang it, and
   an in-flight entry past its deadline is replaced by the next caller. Errors are not cached. The
   memo, the deadline and the timeout error live in `SharedLoads` (`src/upstreams/shared-load.ts`),
   which `getPropagationIndex` in `registry.ts` also uses.
2. `response = await fetchUpstream(deps, upstream, path)`. A `CapabilityError` with code
   `not_found` becomes
   `CapabilityError('upstream_error', \`${upstream.name} has no PACKAGES file at ${url}\`, { upstream: upstream.id, url })`,
   because a missing package list is a broken upstream, not a missing package. Other errors
   propagate.
3. `names = parsePackagesFileNames(response.body)`. An empty set →
   `CapabilityError('upstream_error', \`${upstream.name} returned a PACKAGES file with no packages (${url})\`, { upstream: upstream.id, url })`.
   This guard matters. An empty or truncated list would report every CRAN dependency as missing.
4. Store `{ expiresAt: Date.parse(response.fetchedAt) + upstream.ttlSeconds * 1000, list }`, with
   `list.response` being the response without `body`, and return the list.

### `src/upstreams/cran.ts`

```ts
export const CRAN_BASE_URL = 'https://cloud.r-project.org/';

export const cranUpstream: Upstream = {
  id: 'cran',
  name: 'CRAN',
  baseUrl: CRAN_BASE_URL,
  ttlSeconds: 3600,
  timeoutMs: 20_000, // the PACKAGES file is ~7.4 MB, uncompressed
  maxBytes: 16 * 1024 * 1024, // 7.4 MB on 2026-10-22
  description:
    "CRAN's current source package list (src/contrib/PACKAGES), read for package names only, to tell which " +
    'dependencies of Bioconductor packages are on CRAN.',
};

/** GET src/contrib/PACKAGES on CRAN. */
export function getCranPackageList(deps: Deps): Promise<PackageList> {
  return getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
}
```

**Why `src/contrib/PACKAGES`.** `install.packages()` reads this file, and it lists only packages
CRAN serves today. **Verified (2026-10-22):** HTTP 200, 7,396,971 bytes, `last-modified` set,
`cache-control: max-age=1800`. It was not gzip-encoded, even with `Accept-Encoding: gzip`.

Two alternatives were rejected:

- **`PACKAGES.gz`** is 1.96 MB, but it would need a binary body read and a `DecompressionStream`.
  `fetchUpstream` reads text only.
- **`https://cran.r-universe.dev/api/ls`** is 362 KB of JSON, but it is not CRAN's list.
  **Verified:** it has 180 names that CRAN's PACKAGES does not. Three of them, `AmpliconDuo`,
  `ArCo` and `CEC`, were archived on CRAN on 2026-10-12 and 2026-09-16. It also lacks 14
  Windows-only CRAN packages. An archived CRAN dependency is exactly the case bioc-registry#56 is
  about, so this list would hide it.

### `src/upstreams/bioconductor.ts` (additions)

```ts
export const BIOC_DATA_REPOS = ['data/annotation', 'data/experiment'] as const;
export type BiocDataRepo = (typeof BIOC_DATA_REPOS)[number];

/** 'packages/devel/{repo}/src/contrib/PACKAGES' for 'bioc', 'packages/release/…' for 'bioc-release'. */
export function biocDataRepoPath(universe: Universe, repo: BiocDataRepo): string;

/** getPackageList(deps, bioconductorUpstream, biocDataRepoPath(universe, repo)). */
export function getBiocDataPackageList(deps: Deps, universe: Universe, repo: BiocDataRepo): Promise<PackageList>;
```

`Universe` is imported as a type from `./registry`. The paths use bioconductor.org's `devel` and
`release` symlinks, so no config.yaml lookup is needed.

**Verified (2026-10-22):** `packages/devel/data/annotation/src/contrib/PACKAGES` returns 200 with
218,067 bytes, byte-identical to `packages/3.24/…`. The release path is identical to `3.23`.
Experiment data is 97,357 bytes (devel) and 96,997 bytes (release). Both send `last-modified` and
`content-encoding: gzip`. The default `maxBytes` of 2 MiB and the 3600 s TTL of
`bioconductorUpstream` apply.

**Why not the workflows repository.** 22 workflow packages are in the bioc index, and no index
package has a hard dependency that only the workflows repository would satisfy. The experiment
repository is needed: `ChIPXpress` Depends on `ChIPXpressData`, which is only there. The
annotation repository is needed too: no annotation package is in the index, and many packages
need one (`GO.db`, `org.*`).

### `src/core/pkg/dependency-graph.ts`

```ts
export const HARD_DEPENDENCY_FIELDS = ['Depends', 'Imports', 'LinkingTo'] as const;
export type HardDependencyField = (typeof HARD_DEPENDENCY_FIELDS)[number];

/** R itself and the base-priority packages of R 4.6; never on CRAN, always installed. */
export const BASE_R_PACKAGES: ReadonlySet<string> = new Set([
  'R', 'base', 'compiler', 'datasets', 'graphics', 'grDevices', 'grid', 'methods',
  'parallel', 'splines', 'stats', 'stats4', 'tcltk', 'tools', 'utils',
]);

/** Package names in one DESCRIPTION dependency field, in order, de-duplicated. */
export function parseDependencyField(value: string): string[];

export interface DependencyGraph {
  /** Index entry → its hard dependencies (field order, then DESCRIPTION order), self-references dropped. */
  dependencies: ReadonlyMap<string, readonly { name: string; field: HardDependencyField }[]>;
  /** Any dependency name (in the index or not) → index entries naming it → the fields that name it. */
  dependents: ReadonlyMap<string, ReadonlyMap<string, readonly HardDependencyField[]>>;
  /** Index entries whose dependencies are unknown (no usable `desc`), sorted by code unit. */
  depsUnknown: readonly string[];
}

/** Built once per parsed index (memoized on index.packages). */
export function dependencyGraph(index: PropagationIndex): DependencyGraph;

export interface ReverseDependency { name: string; depth: number }

/**
 * Index entries that depend on `name`, at their shortest depth (1 = names it directly), up to
 * maxDepth levels (undefined = all). Sorted by depth, then name in code-unit order. `name` itself
 * is never included, even through a cycle.
 */
export function reverseDependencies(graph: DependencyGraph, name: string, maxDepth?: number): ReverseDependency[];
```

**`parseDependencyField`** works like this:

1. Split on `,`.
2. Trim each part, newlines included.
3. Take `/^[A-Za-z][A-Za-z0-9.]*/` from each part.
4. Drop parts that do not match, including empty parts.
5. Keep the first occurrence of each name.

Examples:

- `'R (>= 3.5.0)'` → `['R']`
- `'Biobase, BiocGenerics (>= 0.59.5),\n    cytolib'` → `['Biobase', 'BiocGenerics', 'cytolib']`
- `'jsonlite, methods, jsonlite'` → `['jsonlite', 'methods']`
- `''` → `[]`
- `', ,x(>=1)'` → `['x']`

**Verified:** every one of the 13,818 `desc` values in the live bioc index is a string. With this
rule, no hard-field part fails to match.

**`dependencyGraph`** works like this:

- **Memo:** `const graphs = new WeakMap<Record<string, unknown>, DependencyGraph>()`, keyed by
  `index.packages`. `getPropagationIndex` returns the same `packages` object for every call
  within one memo period, so each index version is parsed once per isolate.
- **Which entries have usable dependencies.** For each key of `index.packages`, in
  `Object.keys()` order, the entry is accepted when
  `EntryDepsSchema = z.object({ desc: z.object({ Depends: z.string().optional(), Imports: z.string().optional(), LinkingTo: z.string().optional() }) })`
  `.safeParse(entry)` succeeds. Any other shape puts the name in `depsUnknown`: no `desc`, a
  `desc` that is not an object, or a hard field that is not a string. One bad entry never fails
  the call. `registryEntry()` is not used here, because it throws on any unexpected entry shape.
- **Entries with usable dependencies.** For each field in `HARD_DEPENDENCY_FIELDS` order and each
  `parseDependencyField` name, skip the name if it equals the entry's own name. Otherwise record
  `{ name, field }` in `dependencies` and add `field` to `dependents[name][entry]`. Use `Map`s
  throughout, so keys such as `constructor` and `__proto__` are ordinary.
- **Verified:** one live bioc entry, `easier`, has no `desc` (2,895 of 2,896 have it). The
  bioc-release index has none without it.

**`reverseDependencies`** is a breadth-first search, one level at a time:

- Level 1 is the keys of `dependents.get(name)`. Level n+1 is each level-n entry's dependents
  that have not been seen yet. `name` itself counts as seen from the start, so a cycle never
  lists it.
- Stop after `maxDepth` levels, or when a level is empty.
- Each entry is recorded at the first level it appears.
- The final order is by depth, then by name, compared with `<` (code units, not `localeCompare`).

### `src/core/pkg/paging.ts`

```ts
/** next_cursor of a previous call: the 0-based offset of the next item, as decimal digits. */
export const CursorSchema = z
  .string()
  .regex(/^\d{1,6}$/, 'cursor must be the next_cursor of a previous call')
  .optional()
  .describe('next_cursor from the previous call, to get the next page; same other arguments');

/** Offset for `cursor` (0 when undefined). Throws invalid_input when the offset is not below `total` (unless 0). */
export function parseCursor(cursor: string | undefined, total: number): number;

/**
 * items[offset…] while the running sum of (UTF-8 bytes of JSON.stringify(item) + 1) stays within
 * budgetBytes, but always at least one item when any remain. nextCursor is String(end), or null
 * when the page reaches the end.
 */
export function takePage<T>(items: readonly T[], offset: number, budgetBytes: number): { page: T[]; nextCursor: string | null };

/** '1 package', '16 packages'. */
export function packagesPhrase(n: number): string;
```

`parseCursor` message for an out-of-range offset:
`` `cursor ${cursor} is past the end of the list (${total} items); the index may have changed since the previous call. Call again without cursor.` ``

A cursor is an offset into a list that is rebuilt on every call, so a page can skip or repeat
items if the index changes between calls (every 5 minutes at most). The output's `counts` let the
agent notice when that happens. A token that pins the index version is not worth its cost here.

### `src/core/pkg/revdeps.ts`

#### Input

```ts
input: z.object({
  package: PackageNameSchema,
  universe: z
    .enum(UNIVERSES)
    .default('bioc')
    .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Levels to follow: 1 = direct dependents only; default: all levels'),
  cursor: CursorSchema,
}),
```

REST: `GET /api/v1/pkg/revdeps?package=S4Vectors&universe=bioc&depth=1&cursor=307`. **Verified:**
the deepest chain in the live bioc index is 7 levels (from `Rhtslib`), so a maximum of 20 never
truncates.

#### Data (output) schema

```ts
const FieldCountsSchema = z.object({
  depends: z.number().int(),
  imports: z.number().int(),
  linking_to: z.number().int(),
});

export const PkgRevdepsDataSchema = z.object({
  package: z.string(),
  universe: z.enum(UNIVERSES),
  in_index: z
    .boolean()
    .describe('Whether the package itself is in the propagation index; a name outside it can still have dependents waiting on it'),
  max_depth: z.number().int().nullable().describe('The depth asked for; null for all levels'),
  counts: z.object({
    direct: z.number().int().describe('Index packages naming it in Depends, Imports or LinkingTo'),
    direct_by_field: FieldCountsSchema.describe(
      'direct, split by the field that names it; a package naming it in two fields counts in both',
    ),
    total: z.number().int().describe('All dependents found, direct and transitive, within max_depth'),
    by_depth: z
      .array(z.object({ depth: z.number().int(), count: z.number().int() }))
      .describe('Dependents per level, each at its shortest depth; depth 1 is direct'),
  }),
  dependents: z
    .array(z.object({ depth: z.number().int(), names: z.array(z.string()) }))
    .describe('This page of dependents, grouped by depth, ordered by depth then name (code-unit order)'),
  offset: z.number().int().describe("0-based position of this page's first dependent in the full list"),
  next_cursor: z.string().nullable().describe('Pass as cursor, with the same package, universe and depth, for the next page; null on the last page'),
  deps_unknown: z
    .array(z.string())
    .describe('Index packages with no recorded DESCRIPTION fields (first 20, sorted): their dependencies are unknown, so they are never counted'),
  deps_unknown_count: z.number().int(),
});
```

#### Handler

```ts
const REVDEPS_PAGE_BYTES = 4000;
const DEPS_UNKNOWN_LISTED = 20;

async handler({ package: name, universe, depth, cursor }, deps) {
  const index = await getPropagationIndex(deps, universe);
  const graph = dependencyGraph(index);
  const inIndex = Object.hasOwn(index.packages, name);
  const direct = graph.dependents.get(name);
  if (!inIndex && direct === undefined) {
    // not_found, below
  }
  const all = reverseDependencies(graph, name, depth);
  const offset = parseCursor(cursor, all.length); // invalid_input before any shaping
  const { page, nextCursor } = takePage(all.map((d) => d.name), offset, REVDEPS_PAGE_BYTES);
  // shape: counts from `direct` and `all`; group page names by depth (from `all[offset + i].depth`)
  return { data, summary, sources: [sourceFor(index.response)] };
}
```

The index is fetched before the cursor is checked, because the cursor is checked against the
list's length. Schema errors such as `cursor=abc` are still rejected before any fetch.

**Not found.** The package is not in the index and no index entry names it:

`` `No ${universe} propagation entry named "${name}", and no package in the ${universe} index depends on it. Package names are case-sensitive.` ``
followed by `` ` Did you mean: ${matches.join(', ')}?` `` when
`closeMatches(name, Object.keys(index.packages))` is not empty, and then by the same
other-universe hint `pkg_status` gives (`" To check release, call again with universe
'bioc-release'."` or `" To check devel, call again with universe 'bioc'."`).

**Shaping.**

- `counts.direct` is `direct?.size ?? 0`.
- `counts.direct_by_field` counts the entries of `direct` whose field list includes `Depends`,
  `Imports` or `LinkingTo`.
- `counts.total` is `all.length`.
- `counts.by_depth` has one row per depth present, in ascending order.
- `dependents` groups consecutive names of the page by depth, in order.
- `deps_unknown` is `graph.depsUnknown.slice(0, 20)`, and `deps_unknown_count` is
  `graph.depsUnknown.length`.

#### Summary

The parts below are joined with no separator. Each part after the first starts with its own
space. Numbers are written with `String(n)`.

1. If `counts.total > 0`:
   `` `${name} (${universe}): ${packagesPhrase(total)} in the propagation index ${total === 1 ? 'depends' : 'depend'} on it through Depends, Imports or LinkingTo (${direct} directly${max_depth === null ? '' : `; levels searched: ${max_depth}`}).` ``
   `packagesPhrase(n)` is exported from `paging.ts`:
   `` `${n} ${n === 1 ? 'package' : 'packages'}` ``.
   Otherwise:
   `` `${name} (${universe}): no package in the propagation index depends on it through Depends, Imports or LinkingTo.` ``
2. If `!in_index`: `` ` ${name} itself is not in the index.` ``
3. If `next_cursor !== null`:
   `` ` Listed: ${offset + 1}–${offset + shown} of ${total}; call again with cursor "${next_cursor}" for the rest.` ``
   If `next_cursor === null && offset > 0`: `` ` Listed: ${offset + 1}–${total} of ${total}.` ``
   (both use an en dash).
4. If `deps_unknown_count > 0`:
   `` ` Not counted: ${packagesPhrase(deps_unknown_count)} in the index without recorded dependencies (deps_unknown).` ``

#### Capability

```ts
export const pkgRevdeps = defineCapability({
  module: 'pkg',
  name: 'pkg_revdeps',
  title: 'Reverse dependencies (blast radius)',
  description:
    'Which packages depend on this one, and how many: the reverse hard dependencies (Depends, Imports, ' +
    'LinkingTo) within the Bioconductor propagation index, direct and transitive, with counts per level. ' +
    'Answers "if this package breaks, what is blocked downstream?". Also works for a name that is not in ' +
    'the index, listing the packages still waiting on it. depth 1 gives direct dependents only. Long lists ' +
    'are paged: pass next_cursor back as cursor with the same package, universe and depth. Suggests is not ' +
    "followed, and CRAN packages are not included. universe 'bioc' is devel (default), 'bioc-release' is " +
    'release. Package names are case-sensitive. For the build state of a package use pkg_status; for ' +
    'packages whose dependencies cannot be found at all use pkg_missing_deps.',
  input,
  data: PkgRevdepsDataSchema,
  handler,
});
```

### `src/core/pkg/missing-deps.ts`

#### Input

```ts
input: z.object({
  universe: z
    .enum(UNIVERSES)
    .default('bioc')
    .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
  cursor: CursorSchema,
}),
```

REST: `GET /api/v1/pkg/missing_deps?universe=bioc-release&cursor=30`.

#### Data (output) schema

```ts
const CHECKED_SOURCES = ['registry_index', 'base_r', 'cran', 'bioc_data_annotation', 'bioc_data_experiment'] as const;

export const PkgMissingDepsDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  packages_checked: z.number().int().describe('Index packages whose dependencies are known and were checked'),
  checked_against: z
    .array(z.object({ source: z.enum(CHECKED_SOURCES), packages: z.number().int().describe('Package names it supplied') }))
    .describe('Where a dependency was looked for, in lookup order; the URLs are in sources'),
  counts: z.object({
    packages: z.number().int().describe('Index packages with at least one missing hard dependency'),
    dependencies: z.number().int().describe('Distinct missing dependency names'),
  }),
  dependencies: z
    .array(z.object({ name: z.string(), needed_by: z.number().int().describe('Index packages naming it') }))
    .describe('Missing dependencies, most needed first, then by name; at most 20 (counts.dependencies has the total)'),
  packages: z
    .array(
      z.object({
        package: z.string(),
        version: z.string().nullable().describe('Propagated version; null if the entry has none'),
        origin: z.string().describe("Index entry origin: 'r-universe', 'bioc-build' or 'bioconductor' (seeded)"),
        missing: z
          .array(z.object({ name: z.string(), field: z.enum(HARD_DEPENDENCY_FIELDS) }))
          .describe('Missing hard dependencies, at most 10, each once, under the first field that names it'),
        missing_count: z.number().int(),
      }),
    )
    .describe('This page of affected packages, by name (code-unit order)'),
  offset: z.number().int().describe("0-based position of this page's first package in the full list"),
  next_cursor: z.string().nullable().describe('Pass as cursor, with the same universe, for the next page; null on the last page'),
  deps_unknown: z
    .array(z.string())
    .describe('Index packages with no recorded DESCRIPTION fields (first 20, sorted): not checked'),
  deps_unknown_count: z.number().int(),
  not_checked: z.array(z.string()).describe('What this check does not cover'),
});
```

```ts
export const MISSING_DEPS_NOT_CHECKED = [
  'Version requirements: a dependency counts as present at any version (limma (>= 3.60) is satisfied by any limma).',
  'Suggests, Enhances and SystemRequirements.',
  "CRAN is matched by name against its current src/contrib/PACKAGES (best-effort): not platform binaries, OS_type, or whether CRAN's package of that name is the one meant.",
  "bioconductor.org's software, workflows and books repositories: a dependency found only there counts as missing, because it cannot be installed from the registry.",
  "Dependencies of dependencies: each package's own fields are checked. Use pkg_revdeps on a missing dependency for everything downstream of it.",
  'Index packages without recorded DESCRIPTION fields (deps_unknown).',
] as const;
```

#### Handler

```ts
const MISSING_DEPS_PAGE_BYTES = 3000;
const MISSING_LISTED_PER_PACKAGE = 10;
const DEPENDENCIES_LISTED = 20;

async handler({ universe, cursor }, deps) {
  const [index, cran, annotation, experiment] = await Promise.all([
    getPropagationIndex(deps, universe),
    getCranPackageList(deps),
    getBiocDataPackageList(deps, universe, 'data/annotation'),
    getBiocDataPackageList(deps, universe, 'data/experiment'),
  ]);
  const graph = dependencyGraph(index);
  // shape (below)
  return {
    data,
    summary,
    sources: [sourceFor(index.response), sourceFor(cran.response), sourceFor(annotation.response), sourceFor(experiment.response)],
  };
}
```

If any of the four fails, the whole call fails with that error (`upstream_error` or
`upstream_timeout`). Nothing is returned without the CRAN list, because without it about 2,200
packages would be wrongly listed.

**Shaping.**

- **Which names are found.** A dependency `d` is found when any of these holds:
  `Object.hasOwn(index.packages, d)`, `BASE_R_PACKAGES.has(d)`, `cran.names.has(d)`,
  `annotation.names.has(d)` or `experiment.names.has(d)`.
- **Affected packages.** For each `[pkg, list]` of `graph.dependencies`, the missing dependencies
  are the elements of `list` whose name is not found, de-duplicated by name (the first field
  wins). Keep the packages with at least one, sorted by name in code-unit order. This is the full
  list, before paging.
- **Each item.** `version` is the entry's `version` when it is a string, otherwise null.
  `origin` is the entry's `origin` when it is a string, otherwise `'r-universe'` (the registry
  docs say to read an absent origin that way). `missing` is the first 10. `missing_count` is the
  full count.
- **`dependencies`.** For each missing name, `needed_by` is the number of affected packages that
  list it. Sort by `needed_by` descending, then name in code-unit order, and keep 20.
  `counts.dependencies` is the number of distinct missing names.
- **`checked_against`.** In this order:
  - `registry_index`: `Object.keys(index.packages).length`
  - `base_r`: `BASE_R_PACKAGES.size`, which is 15
  - `cran`: `cran.names.size`
  - `bioc_data_annotation`: `annotation.names.size`
  - `bioc_data_experiment`: `experiment.names.size`
- **The rest.**
  - `packages_checked` is `graph.dependencies.size`.
  - `offset` comes from `parseCursor(cursor, affected.length)`.
  - The page is `takePage(affected items, offset, MISSING_DEPS_PAGE_BYTES)`.
  - `deps_unknown` and `deps_unknown_count` are filled as in `pkg_revdeps`.
  - `not_checked` is `[...MISSING_DEPS_NOT_CHECKED]`.

#### Summary

The parts below are joined in the same way as `pkg_revdeps`.

1. If `counts.packages > 0`:
   `` `${counts.packages} of ${packages_checked} packages in the ${universe} propagation index have a hard dependency (Depends, Imports or LinkingTo) that is in none of: the index, base R, CRAN, Bioconductor annotation or experiment data. Most needed: ${top5}.` ``
   Here `top5` is the first five `dependencies` written as `` `${name} (${needed_by})` `` and
   joined with `', '`. Otherwise:
   `` `None of the ${packages_checked} packages in the ${universe} propagation index has a hard dependency (Depends, Imports or LinkingTo) missing from the index, base R, CRAN and Bioconductor annotation and experiment data.` ``
2. Always: `' CRAN is matched by name only (best-effort); see not_checked.'`
3. The same paging sentence as `pkg_revdeps`, with `counts.packages` as the total.
4. The same `deps_unknown` sentence as `pkg_revdeps`.

#### Capability

```ts
export const pkgMissingDeps = defineCapability({
  module: 'pkg',
  name: 'pkg_missing_deps',
  title: 'Packages with unresolvable dependencies',
  description:
    'Which packages in the Bioconductor propagation index have a hard dependency (Depends, Imports, LinkingTo) ' +
    'that cannot be found: not in the index, not base R, not on CRAN (matched by name against its current ' +
    'package list, best-effort) and not in the Bioconductor annotation or experiment data repositories. Such ' +
    'packages are published but cannot be installed. Lists each one with its missing dependencies, and ranks the ' +
    'missing dependencies by how many packages need them. Version requirements, Suggests and system ' +
    'requirements are not checked (not_checked in the result says what else is not). Long lists are paged ' +
    "with cursor. universe 'bioc' is devel (default), 'bioc-release' is release. For everything downstream of " +
    'one missing dependency use pkg_revdeps on it; for one package\'s build state use pkg_status.',
  input,
  data: PkgMissingDepsDataSchema,
  handler,
});
```

### `src/core/pkg/index.ts`

```ts
export const pkgModule: Module = {
  name: 'pkg',
  description:
    'Package build and propagation state (Bioconductor registry, r-universe), check output and build ' +
    'environments of r-universe jobs, reverse dependencies and unresolvable dependencies in the propagation ' +
    'index (with CRAN), release versions and download stats (bioconductor.org).',
  upstreams: [
    registryUpstream,
    rUniverseUpstreams.bioc,
    rUniverseUpstreams['bioc-release'],
    bioconductorUpstream,
    cranUpstream,
  ],
  capabilities: [
    pkgStatus,
    pkgCheckOutput,
    pkgBuildEnvironment,
    pkgReleaseInfo,
    pkgDownloads,
    pkgRevdeps,
    pkgMissingDeps,
  ],
};
```

`pkg_status`'s description is unchanged. Its own question is unchanged, and the new tools'
descriptions point back to it.

### README

Add these rows to "What is live today", after `pkg_downloads`:

```
| `pkg` | `pkg_revdeps` | Which packages depend on this one, directly or transitively? What breaks downstream if it fails? |
| `pkg` | `pkg_missing_deps` | Which published packages have a hard dependency that is in neither the registry, CRAN nor the Bioconductor data repositories? |
```

### Transports

No changes. The scaffold derives everything:

- **MCP:** `pkg_revdeps` and `pkg_missing_deps` on `/mcp` and `/mcp/pkg`, after
  `pkg_downloads`.
- **REST:** `GET /api/v1/pkg/revdeps` and `GET /api/v1/pkg/missing_deps`.
- **About:** `bioc://about` and `GET /api/v1/about` list upstream `cran`, with
  `base_url: 'https://cloud.r-project.org/'`, `ttl_seconds: 3600` and `used_by: ['pkg']`.

### Upstream calls

| Call | Example URL | Size (2026-10-22) | Cache | `as_of` |
|---|---|---|---|---|
| Propagation index (existing) | `https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` | 8.0 MB | 300 s, parsed once per TTL | fetch time (no `Last-Modified`) |
| CRAN package list | `https://cloud.r-project.org/src/contrib/PACKAGES` | 7.4 MB | 3600 s, parsed once per TTL | `Last-Modified` |
| Annotation data list | `https://bioconductor.org/packages/devel/data/annotation/src/contrib/PACKAGES` (`release/` for bioc-release) | 218 KB | 3600 s | `Last-Modified` |
| Experiment data list | `https://bioconductor.org/packages/devel/data/experiment/src/contrib/PACKAGES` | 97 KB | 3600 s | `Last-Modified` |

`pkg_revdeps` reads only the index. `pkg_missing_deps` reads all four, in parallel.

### Fixtures

The index fixture is the live bioc index trimmed to the set of entries listed below. Each entry
is left unchanged, and the file is written compact (`JSON.stringify`, 341 KB). The full index is
8 MB. The kept entries are:

- the reverse closures of `flowWorkspace`, `BiocSet` and `decoupleR`;
- `synergyfinder`, `SpiecEasi`, `scRecover`, `ChIPXpress` and `easier`;
- everything those depend on inside the index (their forward closure), so that no dependency is
  reported missing only because the fixture dropped it.

The three PACKAGES fixtures keep only the stanzas (verbatim) whose `Package` is a hard dependency
of a kept index entry. The existing `registry/prop/bioc/index.json` fixture and its `pkg_status`
tests are unchanged.

Record from the repo root with:

```bash
set -euo pipefail
R=https://bioc-registry.seandavi.workers.dev
B=https://bioconductor.org/packages/devel/data
F=test/fixtures
W=$(mktemp -d)
curl -sf $R/data/prop/bioc/index.json -o $W/index.json
curl -sf https://cloud.r-project.org/src/contrib/PACKAGES -o $W/cran
curl -sf $B/annotation/src/contrib/PACKAGES -o $W/annotation
curl -sf $B/experiment/src/contrib/PACKAGES -o $W/experiment
mkdir -p $F/registry/prop/bioc $F/cran/src/contrib $F/bioconductor/packages/devel/data/annotation/src/contrib \
         $F/bioconductor/packages/devel/data/experiment/src/contrib
node - "$W" "$F" <<'JS'
const fs = require('node:fs');
const [w, f] = process.argv.slice(2);
const HARD = ['Depends', 'Imports', 'LinkingTo'];
const parse = (v) => (typeof v === 'string' ? v.split(',').map((p) => /^[A-Za-z][A-Za-z0-9.]*/.exec(p.trim())?.[0]).filter(Boolean) : []);
const index = JSON.parse(fs.readFileSync(`${w}/index.json`, 'utf8'));
const depsOf = (name) => HARD.flatMap((field) => parse(index[name]?.desc?.[field]));
const dependents = new Map();
for (const name of Object.keys(index)) for (const dep of depsOf(name)) if (dep !== name) dependents.set(dep, [...(dependents.get(dep) ?? []), name]);
const reverseClosure = (root) => { const seen = new Set([root]); const queue = [root]; while (queue.length) for (const r of dependents.get(queue.shift()) ?? []) if (!seen.has(r)) { seen.add(r); queue.push(r); } return seen; };
const seeds = new Set(['synergyfinder', 'SpiecEasi', 'scRecover', 'ChIPXpress', 'easier']);
for (const root of ['flowWorkspace', 'BiocSet', 'decoupleR']) for (const name of reverseClosure(root)) seeds.add(name);
const keep = new Set(); const stack = [...seeds];
while (stack.length) { const name = stack.pop(); if (keep.has(name) || !Object.hasOwn(index, name)) continue; keep.add(name); stack.push(...depsOf(name)); }
const trimmed = Object.fromEntries(Object.entries(index).filter(([name]) => keep.has(name)));
fs.writeFileSync(`${f}/registry/prop/bioc/index-deps.json`, JSON.stringify(trimmed) + '\n');
const needed = new Set(Object.keys(trimmed).flatMap(depsOf));
const trimPackages = (from, to) => {
  const stanzas = fs.readFileSync(from, 'utf8').split(/\n{2,}/).filter((s) => needed.has(/^Package:[ \t]*(\S+)/.exec(s)?.[1]));
  fs.writeFileSync(to, stanzas.map((s) => s.trim()).join('\n\n') + '\n');
  console.log(to, stanzas.length);
};
trimPackages(`${w}/cran`, `${f}/cran/src/contrib/PACKAGES`);
trimPackages(`${w}/annotation`, `${f}/bioconductor/packages/devel/data/annotation/src/contrib/PACKAGES`);
trimPackages(`${w}/experiment`, `${f}/bioconductor/packages/devel/data/experiment/src/contrib/PACKAGES`);
console.log('index entries', keep.size);
JS
```

**Verified:** this script, run on 2026-10-22, gave 109 index entries (341,117 bytes), 200 CRAN
stanzas (68,467 bytes), 1 annotation stanza (`GO.db`) and 2 experiment stanzas (`ALL`, which is
also in the index, and `ChIPXpressData`). That is about 410 KB in total. A Python implementation of
this spec's rules, run on the result, gave the expected values in the scenario table below.

`test/support/deps-routes.ts` exports:

- `CRAN_PACKAGES_URL = 'https://cloud.r-project.org/src/contrib/PACKAGES'`
- `biocDataUrl(universe, repo)`
- `depsRoutes: Record<string, FixtureRoute>`, containing:
  - `BIOC_INDEX_URL` → `{ file: 'registry/prop/bioc/index-deps.json' }`;
  - the CRAN route with `'last-modified': 'Thu, 22 Oct 2026 23:51:28 GMT'` (the value observed;
    use the live value when recording);
  - the two devel data routes, each with `'last-modified': 'Wed, 21 Oct 2026 15:23:33 GMT'`
    (the annotation value observed; use the live values).

`depsRoutes` overrides `BIOC_INDEX_URL`, so it is never merged into the existing `testApp()` in
`test/transports/pkg.test.ts`. The new tests use their own app,
`makeTestApp({ routes: { ...pkgRoutes, ...bioconductorRoutes, ...depsRoutes }, extraModules: [pkgModule] })`.
The `pkg_status` tests keep the original index.

Tests that need other shapes (paging, cycles, bad entries, bioc-release) use inline routes whose
body is built in the test: `{ status: 200, body: JSON.stringify(syntheticIndex) }`.

Scenarios, with the state observed on 2026-10-22. Tests assert against the recorded files. If a
package no longer fits its scenario when recorded, substitute one that does and say so in the PR.

| Scenario | Input | Expected on the fixtures |
|---|---|---|
| Dependents, all levels | `{ package: 'flowWorkspace' }` | in_index true; direct 10, `direct_by_field { depends: 3, imports: 7, linking_to: 1 }` (CytoML names it in Imports and LinkingTo); total 16; by_depth `[1:10, 2:3, 3:2, 4:1]`; first group depth 1 `['CyFj11', 'CytoML', 'PeacoQC', 'flowGate', 'flowStats', 'ggcyto', 'highthroughputassays', 'openCyto', 'polyICSFlow', 'staRgate']`; last group depth 4 `['MDSvis']`; next_cursor null; deps_unknown `['easier']` |
| Direct only | `{ package: 'flowWorkspace', depth: 1 }` | total 10, by_depth `[1:10]`, max_depth 1, the same 10 names |
| Mid-graph | `{ package: 'ggcyto' }` | direct 4 (`CompensAID`, `CytoML`, `CytoPipeline`, `flowGate`), total 7, deepest `MDSvis` at 3 |
| Leaf | `{ package: 'MDSvis' }` | in_index true; total 0; dependents `[]`; the "no package … depends on it" summary |
| Name not in the index | `{ package: 'BiocSet' }` | in_index false; direct 3 (`RegEnrich` Depends; `plaid`, `sparrow` Imports); total 3; the summary says it is not in the index |
| Unknown name | `{ package: 'flowWorkspac' }` | `not_found`; the message contains `Did you mean: flowWorkspace?` and the release hint |
| Missing deps, devel | `{}` | packages_checked 108; counts `{ packages: 11, dependencies: 5 }`; dependencies `[decoupleR 5, BiocSet 3, SpatialExtremes 1, preseqR 1, pulsar 1]`; packages in order `GSABenchmark, RegEnrich, SmartPhos, SpiecEasi, cosmosR, pathMED, plaid, progeny, scRecover, sparrow, synergyfinder`; `RegEnrich` missing `[{ name: 'BiocSet', field: 'Depends' }]`; `ChIPXpress` not listed (its dependency is found in experiment data); next_cursor null; deps_unknown `['easier']` |

**Live state (not fixtures), 2026-10-22, using the same rules:**

- `pkg_missing_deps` in bioc gives the 11 packages above. bioc-release gives 15, including
  `Melissa` (BPRMeth), `Ularcirc` and `linkSet` (Organism.dplyr), `phenomis` (biodbChebi), and
  four seeded entries needing `biclust`. bioc-registry#56 counted 9 for devel and 13 for release
  on 2026-09-28.
- `pkg_revdeps` for S4Vectors in bioc gives 876 direct and 1,936 total dependents, at depths
  1–4. That is 6 pages of 307–346 names, with a first-page envelope of about 4.9 KB.

## Acceptance criteria

- [ ] `pkg_revdeps` and `pkg_missing_deps` are registered in module `pkg`, after
      `pkg_downloads`. `validateRegistry(modules)` passes on the production list.
- [ ] `/mcp/pkg` lists exactly `['pkg_status', 'pkg_check_output', 'pkg_build_environment',
      'pkg_release_info', 'pkg_downloads', 'pkg_revdeps', 'pkg_missing_deps']`. `/mcp` contains
      both new tools.
- [ ] `GET /api/v1/pkg/revdeps?package=flowWorkspace` and `GET /api/v1/pkg/missing_deps` return
      200, and each body deep-equals the MCP `structuredContent` for the same input.
- [ ] `/api/v1/about` lists upstream `cran` (`base_url: 'https://cloud.r-project.org/'`,
      `ttl_seconds: 3600`, `used_by: ['pkg']`). The pkg module's tool list includes both new tools.
- [ ] Each scenario row above has one fixture test through `invokeCapability`. It asserts every
      value the row names, the `sources` (URLs and `as_of`) and the exact `fetch.calls`:
      `pkg_revdeps` requests only the index, and `pkg_missing_deps` requests the index, CRAN and
      the two devel data lists, once each.
- [ ] The summaries for `flowWorkspace` (all levels), `BiocSet` and missing deps (devel) are
      checked exactly.
- [ ] Unknown name (`flowWorkspac`): REST 404 `not_found`. MCP returns `isError`, with text
      starting `not_found:`.
- [ ] Invalid input gives REST 400 `invalid_input` with `fetch.calls` empty, for each of these on
      revdeps: `package=a'b`, `package=x`, `depth=0`, `depth=21`, `depth=1.5`, `cursor=abc`,
      `cursor=-1`, `universe=cran`. Missing deps also rejects `cursor=abc` and `universe=x`.
- [ ] `cursor` past the end (`revdeps?package=flowWorkspace&cursor=16`) gives 400
      `invalid_input` whose message says to call again without cursor. `cursor=0` on a leaf
      (`MDSvis`, total 0) returns 200.
- [ ] Paging, on a synthetic index of 2,000 entries with 40-character names (`Dep0000` …
      `Dep1999`, each padded with `x` to 40 characters) that each import `Hub` (depth 1), plus
      500 entries of the same form importing the first of them (depth 2):
      - walking `next_cursor` from no cursor until null returns every dependent exactly once, in
        (depth, name) order;
      - every page's envelope is at most 8,192 bytes (`envelopeBytes`);
      - every page except the last has `next_cursor !== null`.

      The same walk for `pkg_missing_deps` uses a synthetic index of 300 entries, each missing
      12 dependencies with 40-character names. Every item has `missing.length === 10` and
      `missing_count === 12`. The PR reports the largest envelope of each walk.
- [ ] The CRAN list memo: two `pkg_missing_deps` calls within 3600 s make exactly one CRAN
      request. After 3600 s, the next call makes one more.
- [ ] Each of these fails `pkg_missing_deps` with no partial result:
      - a CRAN 500 (`upstream_error`);
      - a CRAN 404 (`upstream_error`);
      - a CRAN body with no `Package:` line (`upstream_error`);
      - a CRAN fetch that rejects with `new DOMException('timed out', 'TimeoutError')`
        (`upstream_timeout`). Use a wrapping fetch, as `test/core/ops/token.test.ts` does, not
        the `'timeout'` route, which would wait the full 20 s.

      `pkg_revdeps` makes no CRAN request.
- [ ] `universe: 'bioc-release'` requests `https://bioconductor.org/packages/release/data/annotation/src/contrib/PACKAGES`
      and `…/release/data/experiment/…`, and the bioc-release index (synthetic inline routes).
- [ ] README lists both tools.
- [ ] `npm test` and `npm run typecheck` pass. `npm run build` passes, and the PR reports the
      bundle size before and after.

## Test plan

All tests run in Node with `fixtureFetch` and `createMemoryCache`. There is no network.

- **`test/upstreams/packages-file.test.ts`**
  - `parsePackagesFileNames`:
    - the CRAN fixture has 200 `Package:` lines and 186 distinct names;
    - `\r\n` line endings parse;
    - a trailing space after the name is ignored;
    - a duplicate stanza is counted once;
    - `Package:` not at line start (`  Package: x`, or inside `Description:`) is ignored;
    - an empty body gives an empty set.
  - `getPackageList`:
    - memo hit: no second fetch and `fromCache: true`;
    - two concurrent cold calls make one fetch (`fetch.calls` length 1) and share one `names`;
    - a failed load is shared by concurrent callers and not cached;
    - a load that never settles fails owner and joiner with `upstream_timeout` and is not cached;
    - the memo is isolated between two caches;
    - the memo expires at fetchedAt + TTL;
    - a 404 gives `upstream_error` with the "has no PACKAGES file" message;
    - an empty list gives `upstream_error`;
    - a 500 is not memoized (the next call fetches again).
- **`test/upstreams/bioconductor.test.ts`** (extend): `biocDataRepoPath` for both universes and
  both repos, and `getBiocDataPackageList` on the devel annotation fixture (`GO.db`).
- **`test/core/pkg/dependency-graph.test.ts`**
  - The `parseDependencyField` examples above.
  - `dependencyGraph` on the fixture:
    - `depsUnknown` is `['easier']`;
    - `dependents.get('flowWorkspace').get('CytoML')` is `['Imports', 'LinkingTo']`;
    - `dependencies` of `RegEnrich` includes `{ name: 'BiocSet', field: 'Depends' }`;
    - two calls on the same `index` return the same object (the memo).
  - Synthetic graphs:
    - a self-dependency is dropped;
    - a cycle (`A` imports `B`, `B` imports `A`) terminates, and `reverseDependencies(g, 'A')` is
      `[{ name: 'B', depth: 1 }]`;
    - an entry with `desc.Imports: 42` goes to `depsUnknown` and the others are still built;
    - entries named `constructor` and `__proto__` (from `JSON.parse`) are ordinary;
    - a diamond (`D` imports `B` and `C`, which both import `A`) puts `D` once, at depth 2;
    - `maxDepth` 1 stops at direct dependents;
    - the order is code-unit (`'Zeta'` before `'alpha'`).
- **`test/core/pkg/paging.test.ts`**
  - `parseCursor`:
    - `undefined` → 0;
    - `'0'` with total 0 → 0;
    - `'5'` with total 5 → `invalid_input`;
    - `'4'` with total 5 → 4.
  - `takePage`:
    - the byte budget is honoured;
    - one oversized item is still returned alone;
    - `nextCursor` is null at the end;
    - multi-byte names are counted in UTF-8 bytes.
- **`test/core/pkg/revdeps.test.ts`**: every revdeps scenario row, the exact summaries, the
  paging walk, the past-the-end cursor, and the summary's paging sentence on a middle page.
- **`test/core/pkg/missing-deps.test.ts`**:
  - the devel scenario;
  - `checked_against` values from the fixtures (`registry_index` 109, `base_r` 15, `cran` 186,
    `bioc_data_annotation` 1, `bioc_data_experiment` 2);
  - `not_checked` equals `MISSING_DEPS_NOT_CHECKED`;
  - `sources` in order: index (`as_of` = fetch time), CRAN (`'2026-10-22T23:51:28.000Z'`),
    annotation, experiment;
  - a synthetic index where nothing is missing gives the "None of the …" summary and
    `packages: []`;
  - a seeded entry (`origin: 'bioconductor'`) and an entry with no `origin` (`'r-universe'`);
  - the paging walk, the upstream failures, the memo, and bioc-release.
- **`test/transports/pkg.test.ts`** (extend):
  - the tools lists;
  - REST/MCP equality for both new tools;
  - the 400 table, the 404 body, and the MCP `not_found:` text;
  - the about upstreams (`cran`) and the pkg tool list.

## Risks

- **CRAN's 7.4 MB file per isolate per hour.** On a memo miss, the Worker reads 7.4 MB, from the
  Cache API or from CloudFront, and runs one regex over it (about 10 ms in Node). It holds that
  text alongside the 8 MB index while parsing. That is well inside the 128 MB isolate limit. Only
  `pkg_missing_deps` pays the cost. If it proves heavy, two fixes are available: a registry-side
  CRAN name list (bioc-registry#56 proposes capturing one), or `PACKAGES.gz` with
  `DecompressionStream`, which needs a binary read in `http.ts`. **Not verified:** a fetch of
  cloud.r-project.org from the deployed Worker. The PR's post-deploy check should call
  `pkg_missing_deps` once.
- **"Best-effort" CRAN.** The CRAN list is current, but the registry may have propagated a
  package while its CRAN dependency was still published. Names are matched without versions, and
  a Bioconductor dependency and a CRAN package with the same name would mask each other. The
  result's `not_checked` and summary say so.
- **Cursor drift.** Offsets into a list rebuilt per call can skip or repeat items when the index
  changes between pages. The lists are small, and the counts expose the drift.
- **Size.** Pages are budgeted in bytes. The remaining output is bounded: 20 dependencies, 20
  deps_unknown names, and 10 missing names per item. The synthetic walks with 40-character names
  prove the bound. A pathological upstream name of hundreds of characters could still exceed
  8 KB. `assertEnvelopeSize` then returns `result_too_large` rather than a truncated result.
- **Symlinked data repos.** On release day, bioconductor.org's `devel` and `release` symlinks and
  the registry's universes may flip at different moments. For a few hours, the data-repo lists
  could belong to the other Bioconductor version, and a data package added or removed at the
  release could be misclassified. `pkg_release_info` already reports such a window.
- **Fixture size and drift.** The trimmed fixtures total about 410 KB. They pin the 2026-10-22
  state. Re-recording follows the script and the scenario criteria.
