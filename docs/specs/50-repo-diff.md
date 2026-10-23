# Spec #50: `pkg_repo_diff`, the registry's propagation index against bioconductor.org

Issue: [seandavi/bioc-mcp#50](https://github.com/seandavi/bioc-mcp/issues/50), part of
[#48](https://github.com/seandavi/bioc-mcp/issues/48) (tester feedback, round 1). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
(adapter, provenance, size and caching rules). Background on what is being compared:
[registry-switch.qmd](https://github.com/seandavi/bioc-infrastructure/blob/main/registry-switch.qmd)
("2,374 of 2,384 source packages at the same version"). Conventions: [AGENTS.md](../../AGENTS.md).
Builds on [Spec #6](6-pkg-status.md) (the propagation-index adapter and its memo) and
[Spec #8](8-pkg-release-info.md) (the bioconductor.org adapter and `config.yaml`).

Every upstream shape and number below was checked on 2026-10-22 (about 02:50 UTC on the 23rd)
against the live endpoints. **Verified** marks what the implementer must account for.

- **Verified:** `GET https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` is
  8,035,095 bytes with 2,896 entries; `bioc-release` is 7,780,823 bytes with 2,845 entries. Neither
  sends `last-modified` (`cache-control: no-store`). Every entry has `version`; `origin` is absent on
  1,957 (bioc) and 2,163 (bioc-release) entries, which the registry docs say to read as
  `r-universe`. The other origins: `r-universe` 793/510, `bioconductor` (seeded) 119/148,
  `bioc-build` 27/24. Every key matches the package-name regex and every `version` matches
  `^\d+([.-]\d+)*$`.
- **Verified:** `https://bioconductor.org/packages/{3.23,3.24}/{bioc,data/experiment,workflows,books}/src/contrib/PACKAGES`
  are all 200, `text/plain; charset=utf-8`, with `last-modified`. Sizes for 3.24: bioc 971,064
  bytes (2,430 stanzas), data/experiment 97,357 (434), workflows 9,850 (26), books 4,958 (11).
  3.23: bioc 944,985 (2,385), data/experiment 96,997 (434), workflows 9,506 (25), books 6,268 (13).
  The largest is under half of `DEFAULT_MAX_BYTES` (2 MiB). Each stanza starts with `Package:`,
  then `Version:`; continuation lines start with whitespace; stanzas are separated by one blank
  line; no `\r`; no package appears twice in one file; every `Version` matches
  `^\d+([.-]\d+)*$`.
- **Verified:** the registry has **no** data-annotation packages: 0 of the 926 (3.24) and 928
  (3.23) packages in `data/annotation/src/contrib/PACKAGES` are in either index. It does carry
  data-experiment, workflow and book packages (r-universe's `bioc` universe builds them).
- **Verified:** the comparison today, computed by a throwaway script over the files above:

  | | bioc (3.24) | bioc-release (3.23) |
  |---|---|---|
  | software `bioc`: same version / in PACKAGES | 2,392 / 2,430 | 2,375 / 2,385 |
  | software: registry newer / seeded behind / gated behind | 23 / 9 / 5 | 5 / 4 / 0 |
  | software: only on bioconductor.org | 1 (`lipidr`) | 1 (`motifbreakR`) |
  | data-experiment: same / differ / only bioconductor.org | 416 / 2 / 16 | 423 / 2 / 9 |
  | workflows: same / differ / only bioconductor.org | 21 / 1 / 4 | 21 / 1 / 3 |
  | books: same / differ / only bioconductor.org | 6 / 0 / 5 | 6 / 0 / 7 |
  | only in the registry (in none of the four repos) | 21 (16 r-universe, 5 bioc-build) | 8 (5 r-universe, 3 bioc-build) |

  The release software row reproduces registry-switch.qmd's figure (2,374 of 2,384 then, 2,375
  of 2,385 now).
- **Verified (Node 26, M-series Mac):** `JSON.parse` of the 8 MB index takes about 22 ms (already
  paid and memoized by `getPropagationIndex`). Parsing the four 3.24 PACKAGES files with the line
  scanner below and diffing them against the index takes 2–6 ms; `safeParse` of all 2,896 entries
  with the narrow entry schema below takes 1–7 ms (zod 4, cold to warm). So one uncached diff
  costs about 10 ms of CPU; the memo below makes paging calls cost only the cache reads.

## Goal

One new `pkg` capability, **`pkg_repo_diff`**, served as the MCP tool `pkg_repo_diff` and the REST
route `GET /api/v1/pkg/repo_diff`. For one universe it compares every package in the registry's
propagation index with the source `PACKAGES` of bioconductor.org's own repositories for the
matching Bioconductor version (`bioc` → devel, `bioc-release` → release, read from
`config.yaml`), and returns:

- counts: packages in both, at the same version, at a different version, only on bioconductor.org,
  only in the registry; per repository too;
- why versions differ, where the index shows it (`registry_newer`, `seeded_behind`,
  `gated_behind`, `incomparable`);
- one page of one category's packages (`version_differs`, `only_registry` or
  `only_bioconductor`), with both versions and the registry entry's origin, paged with a cursor.

It answers "is the registry ready to serve bioconductor.org?" with live numbers instead of the
snapshot in the docs.

## Non-goals

- **data/annotation.** The registry carries none of those packages (verified above), so the diff
  would be 926 "only on bioconductor.org" entries and nothing else. registry-switch.qmd keeps
  annotation on the mirror. The description says so.
- **Listing the packages that agree.** Only their count is returned. `pkg_status` answers for one
  package.
- **Per-package r-universe, gate or dependency lookups.** No call to r-universe, `/gate` or
  `/repo`. Reasons come only from the propagation index and the version comparison. The
  description points to `pkg_status` for one package's why.
- **Binary indexes** (`bin/windows`, `bin/macosx`), `PACKAGES.rds`, `VIEWS`, the registry's own
  `/repo/{universe}/…` PACKAGES, and comparing sha256 or MD5 sums.
- **Choosing a Bioconductor version** other than the one `config.yaml` maps the universe to, and
  reconciling config.yaml with the manifest index around a release (`pkg_release_info` reports
  that).
- **A cursor that survives an upstream change.** The cursor is an offset (see Risks).
- Any change to `src/upstreams/http.ts`, `src/upstreams/cache.ts`, `src/upstreams/registry.ts`,
  `src/envelope.ts`, the transports, `bioconductorUpstream.ttlSeconds` or its `maxBytes`.

## Design

### Files

```
src/upstreams/bioconductor.ts          + BIOC_REPOS, BiocRepo, packagesPath(), getPackagesFile(),
                                          parsePackagesFile(); bioconductorUpstream.description extended
src/upstreams/package-name.ts          NEW  PackageNameSchema, moved from src/core/pkg/package-name.ts
src/core/pkg/package-name.ts           re-exports PackageNameSchema; closeMatches stays
src/core/pkg/repo-diff.ts              NEW  pkgRepoDiff, PkgRepoDiffDataSchema, REPO_DIFF_CATEGORIES,
                                          RepoDiffCategory, REPO_DIFF_REASONS, RepoDiff, diffRepos(),
                                          loadRepoDiff()
src/core/pkg/index.ts                  capabilities += pkgRepoDiff (last); description extended
src/core/pkg/status.ts                 description: one sentence pointing to pkg_repo_diff
README.md                              tool table row; one example question
test/support/bioconductor-routes.ts    + packagesUrl(), PACKAGES routes in bioconductorRoutes
test/upstreams/bioconductor.test.ts    + packagesPath / parsePackagesFile / getPackagesFile tests
test/core/pkg/repo-diff.test.ts        NEW
test/transports/pkg.test.ts            tool lists and about.tools += pkg_repo_diff; REST/MCP equality
test/fixtures/registry/prop/bioc/index.json   EXTENDED with five verbatim entries (see Fixtures)
test/fixtures/bioconductor/packages/{3.23,3.24}/{bioc,data/experiment,workflows,books}/src/contrib/PACKAGES
                                       NEW (trimmed to whole verbatim stanzas, see Fixtures)
```

Import zod as `import * as z from 'zod'`. No new dependency. Every upstream path goes through
`pathSegment()` for the value that does not come from a constant (the Bioconductor version), and
every fetch goes through `fetchUpstream` (via `getPropagationIndex`, `getBiocConfig` and
`getPackagesFile`).

### `src/upstreams/bioconductor.ts` additions

```ts
/** bioconductor.org repositories the registry carries packages for; data/annotation is not one (it has none). */
export const BIOC_REPOS = ['bioc', 'data-experiment', 'workflows', 'books'] as const;
export type BiocRepo = (typeof BIOC_REPOS)[number];

const BIOC_REPO_PATHS: Record<BiocRepo, string> = {
  bioc: 'bioc',
  'data-experiment': 'data/experiment',
  workflows: 'workflows',
  books: 'books',
};

const BIOC_VERSION = /^\d+\.\d+$/;

/** 'packages/{version}/{repo path}/src/contrib/PACKAGES'; version through pathSegment(), repo paths are constants. */
export function packagesPath(biocVersion: string, repo: BiocRepo): string;

/** GET packages/{version}/{repo path}/src/contrib/PACKAGES. The body is parsed by the caller (parsePackagesFile). */
export async function getPackagesFile(deps: Deps, biocVersion: string, repo: BiocRepo): Promise<UpstreamResponse>;

/** Package → Version from a PACKAGES (DCF) body; throws upstream_error (with `url`) on any deviation. */
export function parsePackagesFile(body: string, url: string): Map<string, string>;
```

`packagesPath(biocVersion, repo)`:

- If `!BIOC_VERSION.test(biocVersion)` throw
  `CapabilityError('upstream_error', \`bioconductor.org config.yaml names version "${biocVersion}", which is not of the form 3.24\`, { upstream: 'bioconductor', url: 'https://bioconductor.org/config.yaml' })`.
  (The version comes from config.yaml, so a bad one is an upstream fault.)
- Return `` `packages/${pathSegment(biocVersion)}/${BIOC_REPO_PATHS[repo]}/src/contrib/PACKAGES` ``.

`getPackagesFile`:

- `fetchUpstream(deps, bioconductorUpstream, packagesPath(biocVersion, repo))`.
- A `CapabilityError` with `code === 'not_found'` becomes
  `CapabilityError('upstream_error', \`bioconductor.org has no ${BIOC_REPO_PATHS[repo]} PACKAGES for Bioconductor ${biocVersion} (${url})\`, error.details)`,
  where `url` is `error.details.url`. A missing index is the upstream's fault, not a missing
  package the caller asked for. Every other error propagates.

`parsePackagesFile(body, url)` rules. Any violation throws
`CapabilityError('upstream_error', \`bioconductor.org returned a PACKAGES file in an unexpected format (${url})\`, { upstream: 'bioconductor', url })`:

1. `lines = body.split(/\r?\n/)`. A line matching `/^\s*$/` ends the current stanza (consecutive
   blank lines are allowed; a body that is empty or only blank lines gives an empty Map).
2. A line starting with a space or tab is a continuation of the previous field: allowed only
   inside a stanza after at least one field line, otherwise a violation. Its content is ignored.
3. Any other line must match `/^([^\s:]+):[ \t]*(.*)$/`. Only `Package` and `Version` are kept;
   their values are `match[2].trim()`. Other field names are ignored.
4. At the end of each stanza (blank line or end of body): exactly one `Package` and exactly one
   `Version` line were seen; `Package` passes `PackageNameSchema` (`src/upstreams/package-name.ts`;
   import the schema, not a copy of its regex. It lives under `src/upstreams` because adapters may
   not value-import `src/core` (`test/upstreams/imports.test.ts`); `src/core/pkg/package-name.ts`
   re-exports it, so existing imports keep working); `Version` matches `/^\d+([.-]\d+)*$/`; and the
   name is not already in the Map.
5. Return the Map in file order.

Use a `Map`, never an object literal: a stanza named `__proto__` is impossible after rule 4, but
the Map makes the lookups in `diffRepos` independent of that.

Change `bioconductorUpstream.description` to:

```ts
'bioconductor.org: config.yaml (release and devel versions), the published manifest index, ' +
  'the source PACKAGES index of each repository, and package download stats (/packages/stats).',
```

The upstream's `ttlSeconds` (3600), timeout (10 s default) and `maxBytes` (2 MiB default) are
unchanged; the 971 KB devel software PACKAGES is the largest body.

### `src/core/pkg/repo-diff.ts`

#### Schemas

```ts
export const REPO_DIFF_CATEGORIES = ['version_differs', 'only_registry', 'only_bioconductor'] as const;
export type RepoDiffCategory = (typeof REPO_DIFF_CATEGORIES)[number];

export const REPO_DIFF_REASONS = ['registry_newer', 'seeded_behind', 'gated_behind', 'incomparable'] as const;
export type RepoDiffReason = (typeof REPO_DIFF_REASONS)[number];

const ReasonSchema = z
  .enum(REPO_DIFF_REASONS)
  .describe(
    "Why the versions differ. 'registry_newer': the registry's version is newer, so r-universe (or bioc-build) " +
      "published it before bioconductor.org's build system did. 'seeded_behind': bioconductor.org is newer and the " +
      "registry entry was seeded from Bioconductor's release build; a seed is replaced only when r-universe builds a " +
      "newer version that passes the gate. 'gated_behind': bioconductor.org is newer and the registry entry is not " +
      'seeded, so the newer version has not passed the gate (pkg_status shows its r-universe build). ' +
      "'incomparable': the version strings differ but cannot be ordered",
  );

const RepoDiffItemSchema = z.object({
  package: z.string(),
  repo: z
    .enum(BIOC_REPOS)
    .nullable()
    .describe('bioconductor.org repository the package is in; null for only_registry'),
  registry_version: z.string().nullable().describe('Version in the propagation index; null for only_bioconductor'),
  bioconductor_version: z
    .string()
    .nullable()
    .describe("Version in that repository's src/contrib/PACKAGES; null for only_registry"),
  origin: z
    .string()
    .nullable()
    .describe(
      "The registry entry's origin: 'r-universe' or 'bioc-build' passed the gate, 'bioconductor' was seeded from " +
        "Bioconductor's release build; null for only_bioconductor",
    ),
  reason: ReasonSchema.nullable().describe('Set for version_differs; null otherwise'),
});
export type RepoDiffItem = z.infer<typeof RepoDiffItemSchema>;

const RepoCountsSchema = z.object({
  repo: z.enum(BIOC_REPOS),
  bioconductor_packages: z.number().int().describe("Packages in this repository's src/contrib/PACKAGES"),
  same_version: z.number().int().describe('Also in the propagation index, at the same version string'),
  version_differs: z.number().int().describe('Also in the propagation index, at a different version'),
  only_bioconductor: z.number().int().describe('Not in the propagation index'),
});
export type RepoCounts = z.infer<typeof RepoCountsSchema>;

export const PkgRepoDiffDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  bioconductor_version: z
    .string()
    .describe("Bioconductor version compared: config.yaml's devel_version for 'bioc', release_version for 'bioc-release'"),
  repo: z.enum(BIOC_REPOS).nullable().describe('The repository asked for; null when all four were compared'),
  counts: z
    .object({
      registry_packages: z.number().int().describe('Entries in the propagation index'),
      bioconductor_packages: z.number().int().describe('Packages in the compared repositories'),
      in_both: z.number().int().describe('same_version + version_differs'),
      same_version: z.number().int(),
      version_differs: z.number().int(),
      only_bioconductor: z.number().int(),
      only_registry: z
        .number()
        .int()
        .describe('Index entries in none of the four repositories; the same whichever repo is asked for'),
    })
    .describe('Over the compared repositories (repo, or all four)'),
  version_differs_by_reason: z
    .object({
      registry_newer: z.number().int(),
      seeded_behind: z.number().int(),
      gated_behind: z.number().int(),
      incomparable: z.number().int(),
    })
    .describe('counts.version_differs split by reason'),
  by_repo: z.array(RepoCountsSchema).describe('One row per repository, always all four, in the order bioc, data-experiment, workflows, books'),
  category: z.enum(REPO_DIFF_CATEGORIES).describe('The list items is a page of'),
  items: z.array(RepoDiffItemSchema).describe('This page, sorted by package name (case-insensitive), then repository'),
  offset: z.number().int().nonnegative().describe('Position of the first item in the whole list'),
  total: z.number().int().nonnegative().describe('Length of the whole list for this category and repo'),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as cursor, with the same universe, repo and category, for the next page; null on the last page'),
});
type PkgRepoDiffData = z.infer<typeof PkgRepoDiffDataSchema>;
```

Input:

```ts
input: z.object({
  universe: z
    .enum(UNIVERSES)
    .default('bioc')
    .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
  repo: z
    .enum(BIOC_REPOS)
    .optional()
    .describe("One bioconductor.org repository; omit to compare all four. 'bioc' is software"),
  category: z
    .enum(REPO_DIFF_CATEGORIES)
    .default('version_differs')
    .describe('Which list to page through; the counts cover every category whichever is chosen'),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/, 'cursor must be the next_cursor of a previous pkg_repo_diff call')
    .optional()
    .describe('next_cursor from the previous call (same universe, repo and category), for the next page'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Maximum packages in this page (1–50); fewer are returned if the page would pass the size limit'),
}),
```

No `.transform()`, no `.pipe()`: the input accepts its own output, as `validateRegistry`
requires. REST's `queryToInput` already coerces `limit` (integer) from the query string.

#### The diff (pure)

```ts
export interface RepoDiff {
  registryPackages: number;
  byRepo: RepoCounts[]; // BIOC_REPOS order
  lists: Record<RepoDiffCategory, RepoDiffItem[]>; // each sorted with compareItems
}

/** Compare the index with one parsed PACKAGES per repository, given in BIOC_REPOS order. */
export function diffRepos(
  packages: Record<string, unknown>,
  files: readonly { repo: BiocRepo; versions: ReadonlyMap<string, string> }[],
  indexUrl: string,
): RepoDiff;
```

Behaviour:

1. Index entries are read with a narrow schema, not `RegistryEntrySchema` (which parses every
   artifact):
   ```ts
   const DiffEntrySchema = z.object({ version: z.string(), origin: z.string().optional() });
   ```
   For each key of `packages` (`Object.keys`), `safeParse`; a failure throws
   `CapabilityError('upstream_error', \`Bioconductor propagation registry entry for ${name} has an unexpected shape\`, { upstream: 'registry', url: indexUrl })`,
   the same message `registryEntry` uses. `origin` absent → `'r-universe'` (registry docs: "read
   as r-universe"), as `pkg_status` does.
2. For each file, in order, for each `[name, bioconductorVersion]` of `versions`:
   - not `Object.hasOwn(packages, name)` → `only_bioconductor` item
     `{ package: name, repo, registry_version: null, bioconductor_version, origin: null, reason: null }`;
   - same version string → counted as `same_version`, no item;
   - otherwise → `version_differs` item with `registry_version`, `bioconductor_version`, `origin`,
     and `reason`:
     - `cmp = compareRVersions(registryVersion, bioconductorVersion)` (import from `./status`);
     - `cmp === 1` → `'registry_newer'`;
     - `cmp === -1` and `origin === 'bioconductor'` → `'seeded_behind'`;
     - `cmp === -1` otherwise → `'gated_behind'`;
     - `cmp === 0` or `null` → `'incomparable'`.
   - Each file gives one `RepoCounts` row. A package listed in two repositories is counted, and
     listed, once per repository.
3. Every index key that is in none of the files' Maps → `only_registry` item
   `{ package: name, repo: null, registry_version, bioconductor_version: null, origin, reason: null }`.
4. Sort each list with
   ```ts
   function compareItems(a: RepoDiffItem, b: RepoDiffItem): number
   ```
   by `package.toLowerCase()` in code-unit order, then `package` in code-unit order, then the
   index of `repo` in `BIOC_REPOS` (null last). Never `localeCompare`: the order must not depend
   on the runtime's locale.

#### Loading, with a memo

```ts
/** The diff for one universe, plus what was compared; memoized per propagation-index load and PACKAGES fetch. */
export async function loadRepoDiff(
  deps: Deps,
  universe: Universe,
): Promise<{ diff: RepoDiff; bioconductorVersion: string; sources: Source[] }>;
```

1. In parallel: `getPropagationIndex(deps, universe)` and
   `getBiocConfig(deps).then(...)`, where the `.then` picks
   `bioconductorVersion = universe === 'bioc' ? config.devel_version : config.release_version`
   and fetches `Promise.all(BIOC_REPOS.map((repo) => getPackagesFile(deps, bioconductorVersion, repo)))`.
2. Memo key: `[bioconductorVersion, ...responses.map((r) => \`${r.url} ${r.fetchedAt}\`)].join('\n')`.
   Store it in
   ```ts
   const repoDiffs = new WeakMap<Record<string, unknown>, { key: string; diff: RepoDiff }>();
   ```
   keyed by `index.packages`. That object is the one the registry memo shares for one load
   (`getPropagationIndex` returns `{ ...shared, response }`, so `packages` keeps its identity) and
   is dropped when that memo expires, so the diff lives exactly as long as the parsed index. A
   cached PACKAGES response keeps its `fetchedAt` (both caches store it), so the key changes only
   when a PACKAGES file is refetched. On a hit with the same key, reuse `diff`. Otherwise parse
   each body with `parsePackagesFile(response.body, response.url)`, call `diffRepos`, and store
   `{ key, diff }`, replacing any previous value.
3. `sources`, in this order: `sourceFor(index.response)`, `sourceFor(configResponse)`, then
   `sourceFor(response)` for each PACKAGES response in `BIOC_REPOS` order. Six in all.

The diff holds only the disagreeing packages (tens to about a hundred items) and counts, not the
PACKAGES bodies.

#### The handler

```ts
export const pkgRepoDiff = defineCapability({
  module: 'pkg',
  name: 'pkg_repo_diff',
  title: 'Registry vs bioconductor.org repositories',
  description: /* below */,
  input: /* above */,
  data: PkgRepoDiffDataSchema,
  async handler({ universe, repo, category, cursor, limit }, deps) { /* below */ },
});
```

Description (exact text):

```
"How far the registry's propagation index agrees with bioconductor.org's own repositories, for one " +
  "universe ('bioc' devel, default; 'bioc-release' release) against the Bioconductor version config.yaml " +
  'maps it to: how many packages are in both at the same version, at a different version, only on ' +
  'bioconductor.org, or only in the registry, per repository (bioc software, data-experiment, workflows, books; ' +
  'the registry carries no annotation packages). Says why versions differ where the index shows it (registry ' +
  'newer, seeded entry behind, gated entry behind) and lists one category at a time with both versions, paged ' +
  "with cursor. For one package's propagation and build state, and why it is behind, use pkg_status; for the " +
  'release and devel version numbers use pkg_release_info.'
```

Handler steps:

1. `const { diff, bioconductorVersion, sources } = await loadRepoDiff(deps, universe)`.
2. `rows = repo === undefined ? diff.byRepo : diff.byRepo.filter((r) => r.repo === repo)`.
   `inRepo = (item) => repo === undefined || item.repo === repo`.
   `versionDiffers = diff.lists.version_differs.filter(inRepo)`,
   `onlyBioconductor = diff.lists.only_bioconductor.filter(inRepo)`,
   `onlyRegistry = diff.lists.only_registry` (never filtered).
3. `counts`: `registry_packages = diff.registryPackages`; `bioconductor_packages`,
   `same_version`, `version_differs`, `only_bioconductor` are sums over `rows`;
   `in_both = same_version + version_differs`; `only_registry = onlyRegistry.length`.
   `version_differs_by_reason`: counts of each reason in `versionDiffers` (all four keys, zero
   when absent).
4. `list` = the filtered list for `category`; `total = list.length`;
   `offset = cursor === undefined ? 0 : Number(cursor)`. If `offset > total` or
   (`offset === total` and `offset > 0`) throw
   `CapabilityError('invalid_input', \`cursor ${cursor} is past the end of the ${category} list (${total} packages); start again without cursor\`)`.
5. Page: `items = list.slice(offset, offset + limit)`;
   `next_cursor = offset + items.length < total ? String(offset + items.length) : null`. Build
   the envelope `{ data, summary, sources }`. While `envelopeBytes(envelope) > MAX_RESULT_BYTES`
   and `items.length > 1`, drop the last item and rebuild `next_cursor`, `summary` and the
   envelope. (`invokeCapability`'s `assertEnvelopeSize` still runs afterwards; with one item it
   cannot fail on real data.) Import `envelopeBytes` and `MAX_RESULT_BYTES` from
   `src/envelope.ts`, as `docs_read` does.
6. Return the envelope.

Summary (exact form; numbers as plain digits, no thousands separators):

```
{universe} (Bioconductor {v} {devel|release}) against bioconductor.org {v}, {scope}: {same_version} of
{bioconductor_packages} packages at the same version; {version_differs} differ (registry newer: {registry_newer},
seeded behind: {seeded_behind}, gated behind: {gated_behind}[, not comparable: {incomparable}]); {only_bioconductor}
only on bioconductor.org; {only_registry} only in the registry.[ Software (bioc): {same} of {n} at the same
version.] {page}
```

The template is one line; it is wrapped here for reading. Single spaces separate the sentences.

- `devel` for `bioc`, `release` for `bioc-release`.
- `{scope}`: `all four repositories` when `repo` is omitted, else `repository {repo}`.
- `[, not comparable: {incomparable}]` only when that count is above 0.
- `[ Software (bioc): …]` only when `repo` is omitted, from the `bioc` row of `by_repo`.
- `{page}`: `No {category} packages.` when `total === 0`; else
  `Showing {category} {offset + 1}–{offset + items.length} of {total}` followed by
  `; call again with cursor "{next_cursor}" for more.` or `.` on the last page. (The dash is
  U+2013, as `docs_read` uses.)

Example (bioc fixtures below, defaults):
`bioc (Bioconductor 3.24 devel) against bioconductor.org 3.24, all four repositories: 8 of 16 packages at the same version; 4 differ (registry newer: 2, seeded behind: 1, gated behind: 1); 4 only on bioconductor.org; 2 only in the registry. Software (bioc): 6 of 10 at the same version. Showing version_differs 1–4 of 4.`

### `src/core/pkg/index.ts` and `status.ts`

- `capabilities: [pkgStatus, pkgCheckOutput, pkgBuildEnvironment, pkgReleaseInfo, pkgDownloads, pkgRepoDiff]`.
  `upstreams` is unchanged (registry and bioconductor.org are already listed).
- Module description becomes:
  `'Package build and propagation state (Bioconductor registry, r-universe), check output and build ' +
  'environments of r-universe jobs, release versions and download stats (bioconductor.org), and how the ' +
  "registry's index compares with bioconductor.org's repositories."`
- `pkg_status`'s description: after `'versions use pkg_release_info. '` insert
  `"For how the whole index compares with bioconductor.org's repositories use pkg_repo_diff. "`.

### README.md

- Tool table, after the `pkg_downloads` row:
  `` | `pkg` | `pkg_repo_diff` | How many packages does the registry serve at the same version as bioconductor.org, and which differ? | ``
- Example questions, after the `pkg_downloads` one:
  `- "Which release packages does the registry serve at a different version from bioconductor.org, and why?" (\`pkg_repo_diff\`)`

### MCP tool and REST route

Nothing to write in the transports: `pkgModule.capabilities` drives both.

- MCP: tool `pkg_repo_diff` on `/mcp` and on any toolset containing `pkg` (`/mcp/pkg`,
  `/mcp/pkg+docs`, …), with the input and output schemas above. `content` is built by
  `envelopeTextBlocks`.
- REST: `GET /api/v1/pkg/repo_diff`, query parameters `universe`, `repo`, `category`, `cursor`,
  `limit`; body is the same envelope. Example:
  `GET /api/v1/pkg/repo_diff?universe=bioc-release&repo=bioc&category=only_bioconductor&limit=10`.
  Listed in `/api/openapi.json` with `operationId: 'pkg_repo_diff'`.

### Upstream calls

| Call | Example URL | Cache TTL | Fixture |
|---|---|---|---|
| Propagation index (memoized, shared with `pkg_status`) | `https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` | 300 s | `registry/prop/bioc/index.json` (extended), `registry/prop/bioc-release/index.json` (unchanged) |
| config.yaml | `https://bioconductor.org/config.yaml` | 3600 s | `bioconductor/config.yaml` (unchanged: devel 3.24, release 3.23) |
| Software PACKAGES | `https://bioconductor.org/packages/3.24/bioc/src/contrib/PACKAGES` | 3600 s | `bioconductor/packages/3.24/bioc/src/contrib/PACKAGES` |
| Experiment data PACKAGES | `https://bioconductor.org/packages/3.24/data/experiment/src/contrib/PACKAGES` | 3600 s | `bioconductor/packages/3.24/data/experiment/src/contrib/PACKAGES` |
| Workflows PACKAGES | `https://bioconductor.org/packages/3.24/workflows/src/contrib/PACKAGES` | 3600 s | `bioconductor/packages/3.24/workflows/src/contrib/PACKAGES` |
| Books PACKAGES | `https://bioconductor.org/packages/3.24/books/src/contrib/PACKAGES` | 3600 s | `bioconductor/packages/3.24/books/src/contrib/PACKAGES` |

The same four PACKAGES paths under `3.23/` for `bioc-release`. Six upstream requests per uncached
call; every one is cacheable.

### Fixtures

All fixture content is verbatim upstream bytes. The index fixture keeps its existing nine entries
byte for byte and gains five entries copied whole from today's index. Each PACKAGES fixture keeps
whole stanzas, in file order, for the listed packages only.

Record (from the worktree root; scripts live outside the fixture tree):

```sh
B=https://bioc-registry.seandavi.workers.dev
F=test/fixtures/registry/prop/bioc/index.json
curl -sf $B/data/prop/bioc/index.json -o /tmp/bioc-index.json
jq -s '.[0] * (.[1] | {anndataR, progeny, TimerQuant, methylationArrayAnalysis, OMA})' $F /tmp/bioc-index.json > /tmp/index.new
mv /tmp/index.new $F
git diff --stat $F   # additions only: the five new entries after edge

cat > /tmp/keep.awk <<'EOF'
BEGIN { RS = ""; n = split(keep, k, " "); for (i = 1; i <= n; i++) want[k[i]] = 1; first = 1 }
{
  split($0, lines, "\n"); name = lines[1]; sub(/^Package: /, "", name)
  if (name in want) { printf "%s%s\n", (first ? "" : "\n"), $0; first = 0 }
}
EOF
keep() { # keep <version> <repo path> <packages…>
  local v=$1 r=$2; shift 2
  local d=test/fixtures/bioconductor/packages/$v/$r/src/contrib
  mkdir -p $d
  curl -sf https://bioconductor.org/packages/$v/$r/src/contrib/PACKAGES | awk -v keep="$*" -f /tmp/keep.awk > $d/PACKAGES
  curl -sfI https://bioconductor.org/packages/$v/$r/src/contrib/PACKAGES | grep -i '^last-modified'
}
keep 3.24 bioc anndataR biomaRt Chromatograms ClustIRR edge edgeR lipidr RMassBank SEMPLR trackViewer
keep 3.24 data/experiment BeadArrayUseCases Fletcher2013a
keep 3.24 workflows BP4RNAseq methylationArrayAnalysis
keep 3.24 books csawBook OMA
keep 3.23 bioc edgeR motifbreakR
keep 3.23 data/experiment ChIPXpressData
keep 3.23 workflows BP4RNAseq
keep 3.23 books csawBook
```

Expected content (2026-10-22). The implementer checks it with
`grep -h '^Package\|^Version' test/fixtures/bioconductor/packages/*/*/src/contrib/PACKAGES test/fixtures/bioconductor/packages/*/*/*/src/contrib/PACKAGES`.
If live data has moved, the package for that row is replaced by another that meets the row's
criterion, and the tests' expected values are updated to match:

| Fixture | Package | Registry fixture | bioconductor.org | Category / reason (criterion) |
|---|---|---|---|---|
| 3.24 bioc | trackViewer, ClustIRR, edge, edgeR, RMassBank, SEMPLR | existing entries | same versions | same_version |
| 3.24 bioc | anndataR | 1.3.3, r-universe (new) | 1.3.2 | version_differs / registry_newer |
| 3.24 bioc | biomaRt | 2.69.0, bioconductor (existing) | 2.69.3 | version_differs / seeded_behind |
| 3.24 bioc | Chromatograms | 1.3.3, r-universe (existing) | 1.3.4 | version_differs / gated_behind |
| 3.24 bioc | lipidr | absent | 2.27.0 | only_bioconductor |
| 3.24 data/experiment | Fletcher2013a | 1.49.0, bioc-build (existing) | 1.49.0 | same_version |
| 3.24 data/experiment | BeadArrayUseCases | absent | 1.51.0 | only_bioconductor |
| 3.24 workflows | methylationArrayAnalysis | 1.37.1, bioc-build (new) | 1.37.0 | version_differs / registry_newer |
| 3.24 workflows | BP4RNAseq | absent | 1.23.0 | only_bioconductor |
| 3.24 books | OMA | 1.1.8, r-universe (new) | 1.1.8 | same_version |
| 3.24 books | csawBook | absent | 1.21.0 | only_bioconductor |
| (none) | progeny | 1.35.0, origin absent → r-universe (new) | in no repo | only_registry |
| (none) | TimerQuant | 1.43.0, bioc-build (new) | in no repo | only_registry |
| 3.23 bioc | edgeR | 4.10.7 (release fixture) | 4.10.7 | same_version |
| 3.23 bioc | motifbreakR | absent | 2.26.1 | only_bioconductor |
| 3.23 data/experiment, workflows, books | ChIPXpressData 1.50.0, BP4RNAseq 1.22.0, csawBook 1.20.0 | absent | | only_bioconductor |

The new index entries do not change any existing close-match expectation: none of anndataR,
progeny, TimerQuant, methylationArrayAnalysis or OMA is within edit distance 2 of `edgr` or
`biomart`, or starts with either.

`test/support/bioconductor-routes.ts`:

```ts
export function packagesUrl(version: string, repoPath: string): string {
  return `https://bioconductor.org/packages/${version}/${repoPath}/src/contrib/PACKAGES`;
}
```

and in `bioconductorRoutes`, one route per fixture file above:
`[packagesUrl(v, r)]: { file: \`bioconductor/packages/${v}/${r}/src/contrib/PACKAGES\`, headers: { 'content-type': 'text/plain; charset=utf-8', 'last-modified': <recorded> } }`.
On 2026-10-22 the recorded `last-modified` values were: 3.24 bioc `Thu, 22 Oct 2026 17:01:01 GMT`,
data/experiment `Thu, 22 Oct 2026 21:31:29 GMT`, workflows `Tue, 13 Oct 2026 21:27:41 GMT`, books
`Mon, 19 Oct 2026 19:25:22 GMT`; 3.23 bioc `Thu, 22 Oct 2026 17:01:01 GMT`, data/experiment
`Tue, 15 Sep 2026 20:30:23 GMT`, workflows `Sat, 01 Aug 2026 15:30:49 GMT`, books
`Sat, 01 Aug 2026 15:30:37 GMT`. Use the values `keep` prints.

## Acceptance criteria

- [ ] `pkg_repo_diff` is listed by `/mcp`, `/mcp/pkg` and `GET /api/v1/about` (pkg tools in the
      order `pkg_status, pkg_check_output, pkg_build_environment, pkg_release_info, pkg_downloads, pkg_repo_diff`),
      and `GET /api/v1/pkg/repo_diff` is in `/api/openapi.json`. `validateRegistry(modules)` passes.
- [ ] With the fixtures and default input (`universe` bioc), `data` has `bioconductor_version`
      `'3.24'`, `repo` null, `counts` `{ registry_packages: 14, bioconductor_packages: 16, in_both: 12, same_version: 8, version_differs: 4, only_bioconductor: 4, only_registry: 2 }`,
      `version_differs_by_reason` `{ registry_newer: 2, seeded_behind: 1, gated_behind: 1, incomparable: 0 }`,
      and `by_repo` equal to
      `[{ repo: 'bioc', bioconductor_packages: 10, same_version: 6, version_differs: 3, only_bioconductor: 1 }, { repo: 'data-experiment', bioconductor_packages: 2, same_version: 1, version_differs: 0, only_bioconductor: 1 }, { repo: 'workflows', bioconductor_packages: 2, same_version: 0, version_differs: 1, only_bioconductor: 1 }, { repo: 'books', bioconductor_packages: 2, same_version: 1, version_differs: 0, only_bioconductor: 1 }]`.
- [ ] Default `items` are, in order, anndataR (bioc, 1.3.3 / 1.3.2, r-universe, registry_newer),
      biomaRt (bioc, 2.69.0 / 2.69.3, bioconductor, seeded_behind), Chromatograms (bioc, 1.3.3 /
      1.3.4, r-universe, gated_behind), methylationArrayAnalysis (workflows, 1.37.1 / 1.37.0,
      bioc-build, registry_newer); `offset` 0, `total` 4, `next_cursor` null; the summary equals
      the example above.
- [ ] `category: 'only_bioconductor'` gives BeadArrayUseCases, BP4RNAseq, csawBook, lipidr (that
      order, case-insensitive), each with `registry_version`, `origin` and `reason` null.
      `category: 'only_registry'` gives progeny (`origin` `'r-universe'`) and TimerQuant
      (`'bioc-build'`), each with `repo` and `bioconductor_version` null.
- [ ] `repo: 'bioc'` gives `counts` `{ registry_packages: 14, bioconductor_packages: 10, in_both: 9, same_version: 6, version_differs: 3, only_bioconductor: 1, only_registry: 2 }`,
      `by_repo` still four rows, `version_differs` items without methylationArrayAnalysis, and a
      summary containing `repository bioc` and no `Software (bioc):` sentence.
- [ ] Paging: `limit: 2` gives anndataR, biomaRt and `next_cursor` `'2'`; then `cursor: '2'`
      gives Chromatograms, methylationArrayAnalysis and `next_cursor` null; `cursor: '4'` (total
      4) and `cursor: '5'` are `invalid_input`; `category: 'only_registry', repo: 'books'`
      returns the same two only_registry items; a category with no items (`only_registry` on
      bioc-release) returns `items: []`, `total: 0` and a summary ending `No only_registry packages.`
- [ ] `universe: 'bioc-release'` fetches only `3.23` PACKAGES URLs and the bioc-release index;
      `counts` `{ registry_packages: 1, bioconductor_packages: 5, in_both: 1, same_version: 1, version_differs: 0, only_bioconductor: 4, only_registry: 0 }`;
      summary starts `bioc-release (Bioconductor 3.23 release) against bioconductor.org 3.23`.
- [ ] `sources` has six entries in the order index, config.yaml, bioc, data/experiment,
      workflows, books PACKAGES; each PACKAGES `as_of` is its recorded `last-modified` as ISO 8601
      (e.g. `2026-10-22T17:01:01.000Z`); the index's is the fetch time.
- [ ] A second call with the same deps makes no new upstream request (`fetch.calls` unchanged)
      and `loadRepoDiff` returns the identical `diff` object (`toBe`). After the clock moves 301 s
      (index TTL), `diff` is a new object with equal content.
- [ ] Synthetic: 50 items whose names are 40 characters and versions 15 characters, `limit: 50`:
      the envelope is at most 8192 bytes, `items.length` < 50, and `next_cursor` is
      `String(items.length)`.
- [ ] `diffRepos` classifies `'1.0'` vs `'1-0'` (cmp 0) and `'1.0a'` vs `'1.0'` (cmp null) as
      `incomparable`; an index entry without `version` throws `upstream_error` naming the package
      and the index URL; a package in two repositories appears once per repository; an index
      key `__proto__` (from `JSON.parse`) is handled as an ordinary name.
- [ ] `parsePackagesFile`: the recorded 3.24 software fixture gives exactly its ten packages in
      file order; continuation lines are ignored; `\r\n` bodies parse the same; an empty body
      gives an empty Map; each of these throws `upstream_error` with the URL: a stanza without
      `Version`, two `Package` lines in one stanza, the same package in two stanzas, a version
      `1.0.0a`, an invalid package name, a continuation line before any field, a line with no
      colon.
- [ ] `getPackagesFile` maps a 404 to `upstream_error` (message names the repository path and
      version), and `packagesPath('3.24', 'data-experiment')` is
      `'packages/3.24/data/experiment/src/contrib/PACKAGES'`; a config version `'3.24/../x'` or
      `'devel'` is `upstream_error` and no PACKAGES URL is fetched.
- [ ] MCP `callTool('pkg_repo_diff', {})` `structuredContent` deep-equals the REST body for
      `GET /api/v1/pkg/repo_diff`; `content[0].text` is the summary.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass. No test hits the network.

## Test plan

All tests in Node with `fixtureFetch({ ...pkgRoutes, ...bioconductorRoutes })`,
`createMemoryCache(now)`, a fixed `now` (`2026-10-22T12:00:00Z`), and `env: {}`.

- `test/upstreams/bioconductor.test.ts`: `packagesPath` (each repo, bad versions);
  `parsePackagesFile` (fixture, CRLF, empty, each violation); `getPackagesFile` (200 from fixture,
  404 route → `upstream_error`).
- `test/core/pkg/repo-diff.test.ts`:
  - `diffRepos` on small inline inputs: each reason, `incomparable`, `origin` default,
    duplicate-across-repos, `__proto__` key, bad entry, sort order (`BP4RNAseq` after
    `BeadArrayUseCases`; a repo tie-break).
  - A scale case built in the test (3,000 index entries, 2,500 stanzas across the four repos,
    generated, not committed) checks the counts add up (`same + differs + only_bioconductor` per
    row equals the stanza count; `in_both` distinct names + `only_registry` equals
    `registry_packages`). No timing assertion.
  - The handler through `invokeCapability` on the fixtures: every acceptance criterion above
    from the default call, `repo`, `category`, paging, release, sources, and the memo
    (`loadRepoDiff` twice; clock advanced 301 s).
  - The size cut: `invokeCapability(pkgRepoDiff, { limit: 50 }, deps)` with a `fixtureFetch`
    whose index, config.yaml and four PACKAGES routes are inline bodies built in the test
    (`{ status: 200, body }` routes): 50 software packages with valid 40-character names, each
    at a 15-character version in PACKAGES (e.g. `1.2.34567890123`) and a different one in the
    index, and empty data/experiment, workflows and books bodies.
- `test/transports/pkg.test.ts`: tool lists and `about.modules[pkg].tools` include
  `pkg_repo_diff`; REST and MCP give the same envelope; `GET /api/v1/pkg/repo_diff?cursor=x` is
  400 `invalid_input`.
- Existing tests stay green with the extended index fixture (`pkg_status`, close matches,
  registry adapter).

## Risks

- **Paging over live data.** The cursor is an offset into a list that can change between calls
  (index TTL 5 min, PACKAGES 1 h), so a page can skip or repeat a package. The lists are short
  (tens), so most callers get them in one page. Accepted; a digest-bound cursor would be the fix
  if it matters.
- **Multiple isolates.** The memo is per isolate, like the index memo. A cold isolate pays about
  10 ms of CPU for the diff on top of the index parse that `pkg_status` already pays.
- **Body size headroom.** The devel software PACKAGES (971 KB) is under half of the 2 MiB
  `maxBytes`. If Bioconductor roughly doubles, the tool fails with `upstream_error` until
  `bioconductorUpstream.maxBytes` is raised; the message says so.
- **Release transitions.** Around a release, config.yaml can name a version whose PACKAGES do
  not exist yet, or the universes can lag the version change; the 404 becomes an
  `upstream_error` naming the URL, and `pkg_release_info` shows the disagreement.
- **"Reason" is inferred.** `gated_behind` says the entry is not seeded, not which gate rule
  rejected the newer version; `registry_newer` does not distinguish r-universe from bioc-build
  except through `origin`. The description sends the caller to `pkg_status` for one package.
- **Annotation is excluded by measurement.** If the registry starts carrying annotation
  packages, they would show as `only_registry`; adding `'data-annotation'` to `BIOC_REPOS` is
  the fix.
- **Fixture drift.** The new index entries and PACKAGES stanzas are recorded on one day; the
  existing index entries on another. The tests assert what the fixtures hold, and the selection
  table gives the criterion for each package so a re-recording can replace one.
