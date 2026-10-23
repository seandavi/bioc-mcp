# Spec #8: `pkg_release_info` and `pkg_downloads`

Issue: [seandavi/bioc-mcp#8](https://github.com/seandavi/bioc-mcp/issues/8).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
(tools table, "Caching", gap 4). Conventions: [AGENTS.md](../../AGENTS.md). Builds on the scaffold
([spec #2](2-scaffold.md), [spec #15](15-scaffold-followups.md)) and the `pkg` module
([spec #6](6-pkg-status.md)).

Every upstream shape below was checked on 2026-10-22 against the live endpoints:
`https://bioconductor.org/config.yaml`, `https://bioconductor.org/api/v1/manifest/index.json`, and
`https://bioconductor.org/packages/stats/…` for the packages named under [Fixtures](#fixtures).
Notes marked **Verified** record behaviour the implementer must account for.

## Goal

Two more `pkg` capabilities, both thin adapters over bioconductor.org:

- **`pkg_release_info()`**: the current release and devel versions, the R version each is built
  for, the release date when config.yaml has one, and the published package manifests. It reads
  config.yaml and the manifest index, and flags any disagreement between them.
- **`pkg_downloads(package, year?)`**: one package's monthly distinct IPs and downloads for one
  calendar year, as bioconductor.org publishes them at `/packages/stats/`. It also returns the
  yearly totals, the date the stats were computed (`data_as_of`, from the stats page), and which
  category the package is in. It tries `bioc`, then `data-annotation`, `data-experiment` and
  `workflows`. `year` defaults to the current year. If the stats page does not list that year yet
  (early January), it falls back to the latest year that has stats, and says so.

## Non-goals

- Reading the manifest TSVs themselves (`3.23/bioc.tsv.gz`). The result links to them and does
  not fetch them.
- Splitting downloads into people and automated clients, per-version or per-country counts, or
  any number bioc-traffic computes that bioconductor.org does not publish. The result points to
  bioc-traffic's comparison page.
- The all-years file (`{pkg}_stats.tab`), the category ranking pages (`/packages/stats/bioc/`),
  and the `data_table` JavaScript in the package page.
- Close-match suggestions for unknown packages in `pkg_downloads`. No index of stats names is
  cheap to get; the 404 message says names are case-sensitive.
- The MCP `ttlMs` hint, pagination, or any change to `src/upstreams/http.ts`,
  `src/upstreams/cache.ts`, `src/envelope.ts` or the transports.
- Filing the bioc-traffic `DATA_AS_OF` gap (proposal gap 4). This spec reads the date from the
  HTML page, as the issue asks.

## Design

### Files

```
package.json, package-lock.json      move yaml from devDependencies to dependencies (same range ^2.9.1)
src/upstreams/bioconductor.ts        NEW  bioconductorUpstream, getBiocConfig(), getManifestIndex(),
                                          STATS_CATEGORIES, StatsCategory, MONTHS, Month,
                                          findStatsPage(), getStatsTab(), statsTabPath(), parseDataAsOf(),
                                          parseStatsYears(), parseStatsTab(), isoDate() (shared Date.UTC
                                          round-trip used by parseDataAsOf and parseReleaseDate), and
                                          their schemas/types
src/core/pkg/release-info.ts         NEW  pkgReleaseInfo, PkgReleaseInfoDataSchema, parseReleaseDate()
src/core/pkg/downloads.ts            NEW  pkgDownloads, PkgDownloadsDataSchema, STATS_DEFINITION
src/core/pkg/index.ts                upstreams += bioconductorUpstream; capabilities = [pkgStatus,
                                          pkgReleaseInfo, pkgDownloads]; new description
src/core/pkg/status.ts               description: last sentence cross-references the new tools
test/support/bioconductor-routes.ts  NEW  fixture URL → FixtureRoute map and URL helpers; readBiocFixture(), NOT_FOUND
test/upstreams/bioconductor.test.ts  NEW
test/core/pkg/release-info.test.ts   NEW
test/core/pkg/downloads.test.ts      NEW
test/transports/pkg.test.ts          tools lists, REST/MCP equality for the new tools, about upstreams
test/fixtures/bioconductor/…         NEW (verbatim), see Fixtures
```

Import zod as `import * as z from 'zod'` and YAML as `import { parse as parseYaml } from 'yaml'`.
Build every upstream path with `pathSegment()` for each value derived from input (the package name
and the `.tab` file name), and fetch only through `fetchUpstream` / `fetchUpstreamJson`.

**Why `yaml` moves to dependencies.** It is already in the lockfile (used by
`scripts/docs-index/config.ts`), it is pure JS with no dependencies, and Wrangler bundles its
browser build. **Verified:** a throwaway Worker importing `parse` from `yaml` bundled with
`wrangler deploy --dry-run` to 207 KiB, 45 KiB gzip, with no `node:` imports. The current bundle is
1,404 KiB, 253 KiB gzip. A hand-written line parser for six keys would avoid the bytes, but it
would break silently on any YAML feature the file starts to use. Run
`npm install --save yaml@^2.9.1` so the lockfile records the move.

### `src/upstreams/bioconductor.ts`

```ts
export const BIOCONDUCTOR_BASE_URL = 'https://bioconductor.org/';

export const bioconductorUpstream: Upstream = {
  id: 'bioconductor',
  name: 'bioconductor.org',
  baseUrl: BIOCONDUCTOR_BASE_URL,
  ttlSeconds: 3600, // proposal: stats 1 h, config.yaml and manifests 1 h
  description:
    'bioconductor.org: config.yaml (release and devel versions), the published manifest index, ' +
    'and package download stats (/packages/stats).',
};
```

One upstream object for all three resources: they share a host and a TTL, and `bioc://about` lists
one source per host. Default timeout (10 s): the largest body is a stats page of about 115 KB.

#### config.yaml

```ts
export const BiocConfigSchema = z.object({
  release_version: z.string(),
  devel_version: z.string(),
  r_version_associated_with_release: z.string(),
  r_version_associated_with_devel: z.string(),
  release_dates: z.record(z.string(), z.string()).optional(),
});
export type BiocConfig = z.infer<typeof BiocConfigSchema>;

/** GET config.yaml, parsed with the YAML failsafe schema (every scalar a string). */
export async function getBiocConfig(deps: Deps): Promise<{ response: UpstreamResponse; config: BiocConfig }>;
```

Behaviour:

1. `response = await fetchUpstream(deps, bioconductorUpstream, 'config.yaml')`.
2. `parseYaml(response.body, { schema: 'failsafe', logLevel: 'error' })`. A thrown error becomes
   `CapabilityError('upstream_error', 'bioconductor.org returned a config.yaml that is not valid YAML', { upstream: 'bioconductor', url: response.url })`.
   `logLevel: 'error'` throws on errors and does not log warnings. (`'silent'` would swallow
   errors. **Verified** in `yaml/dist/public-api.js`, v2.9.1.)
3. `BiocConfigSchema.safeParse(doc)` fails →
   `CapabilityError('upstream_error', 'bioconductor.org config.yaml lacks the release and devel version keys', …)`.
   Unknown keys are stripped.

**Why failsafe.** In YAML's core schema an unquoted `release_version: 3.30` parses to the number
`3.3` and loses its trailing zero. Failsafe keeps every scalar as a string. **Verified:**
`parse('a: 3.30', { schema: 'failsafe' })` gives `{ a: '3.30' }`. The live file parses whole under
failsafe in about 1.8 ms (Node), so no parse memo is needed.

**Verified (2026-10-22):** 12,861 bytes, `content-type: application/x-yaml`,
`last-modified: Sat, 01 Aug 2026 15:44:12 GMT`. `release_version: "3.23"`, `devel_version: "3.24"`,
both `r_version_associated_with_*: "4.6.0"`. `release_dates` has 49 entries in `M/D/YYYY` with
inconsistent zero-padding (`"1.0": "1/5/2001"`, `"3.23": "04/29/2026"`) and no entry for devel
`3.24`. The file also lists mirror contacts with e-mail addresses; the schema strips them and no
output includes them.

#### Manifest index

```ts
export const ManifestIndexSchema = z.object({
  generated: z.string(), // ISO 8601, e.g. '2026-10-22T17:45:18Z'
  versions: z.object({ release: z.string(), devel: z.string() }),
  build: z.string().optional(),
  manifest_prefix: z.string().optional(),
  manifests: z.array(
    z.object({ path: z.string(), objects: z.number().int(), without_hash: z.number().int() }),
  ),
  symlinks: z.record(z.string(), z.string()).optional(),
});
export type ManifestIndex = z.infer<typeof ManifestIndexSchema>;

/** GET api/v1/manifest/index.json. */
export async function getManifestIndex(deps: Deps): Promise<{ response: UpstreamResponse; index: ManifestIndex }>;
```

`fetchUpstreamJson(deps, bioconductorUpstream, 'api/v1/manifest/index.json')`, then `safeParse`.
On failure, throw `CapabilityError('upstream_error', 'bioconductor.org returned a manifest index with an unexpected shape', …)`.

**Verified (2026-10-22):** 14,393 bytes, `last-modified` equal to `generated`. The keys are
`build, format, generated, manifest_prefix, manifests, symlinks, versions`.
`manifest_prefix: "/api/v1/manifest"`. Ten manifests (`3.23/` and `3.24/` × `bioc`,
`data-annotation`, `data-experiment`, `workflows`, `books`). Each `path` resolves under the
prefix: `https://bioconductor.org/api/v1/manifest/3.23/bioc.tsv.gz` is 200, `application/gzip`.
`symlinks` has 202 entries, including `"packages/release": "3.23"` and `"packages/devel": "3.24"`.
`format.notes` says: "Do not pin the numeric version -- read versions.release and
versions.devel from this file on every run."

#### Download stats

```ts
export const STATS_CATEGORIES = ['bioc', 'data-annotation', 'data-experiment', 'workflows'] as const;
export type StatsCategory = (typeof STATS_CATEGORIES)[number];

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export type Month = (typeof MONTHS)[number];

export interface StatsPage {
  response: UpstreamResponse;
  category: StatsCategory;
  url: string; // https://bioconductor.org/packages/stats/{category}/{name}/
  dataAsOf: string | null; // 'YYYY-MM-DD'
  years: number[]; // ascending, unique
}

/** GET packages/stats/{category}/{name}/ for each category in STATS_CATEGORIES order; the first 200 wins. */
export async function findStatsPage(deps: Deps, name: string): Promise<StatsPage | undefined>;
```

`findStatsPage` behaviour:

- For each `category` **in order, one at a time** (most packages are `bioc`, so most calls make
  one request): `fetchUpstream(deps, bioconductorUpstream, \`packages/stats/${category}/${pathSegment(name)}/\`)`.
- A `CapabilityError` with `code === 'not_found'` moves on to the next category. Any other error
  propagates. No partial results.
- On 200, return `{ response, category, url: response.url, dataAsOf: parseDataAsOf(response.body), years: parseStatsYears(response.body, name) }`.
- All four 404 → `undefined`.

```ts
/** 'Data as of Thu. 22 Oct 2026' → '2026-10-22'; null if absent or not a real date. */
export function parseDataAsOf(html: string): string | null;
```

Regex: `/Data as of\s+(?:[A-Za-z]{3}\.?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/`. The month is
looked up case-sensitively in `MONTHS`. Build `YYYY-MM-DD` with zero padding. Return `null` if the
month is unknown or the day is not valid for that month (a round-trip through `Date.UTC` changes
it). **Verified:** the package page has `<i>Data as of Thu. 22 Oct 2026</i>`. The top-level
`/packages/stats/` has `<I>Data as of Thu. 22 Oct 2026.</I>`, which the same regex reads.

```ts
/** Years whose {name}_{year}_stats.tab the page links to, ascending and unique. */
export function parseStatsYears(html: string, name: string): number[];
```

Use `/href="([^"/]+)_(\d{4})_stats\.tab"/g` and keep the matches whose group 1 `=== name`. Compare
names instead of building a regex from `name`, because names contain `.`. **Verified:** the edgeR
page links `edgeR_2026_stats.tab` … `edgeR_2009_stats.tab` (18 years) and `edgeR_stats.tab`, which
the regex does not match. The page says "years with no downloads are omitted".

```ts
export interface StatsCounts { distinct_ips: number; downloads: number }
export interface StatsTab {
  response: UpstreamResponse;
  months: ({ month: Month } & StatsCounts)[]; // all 12, calendar order
  total: StatsCounts; // the 'all' row
}

/** GET packages/stats/{category}/{name}/{name}_{year}_stats.tab; undefined on 404. */
export async function getStatsTab(deps: Deps, category: StatsCategory, name: string, year: number): Promise<StatsTab | undefined>;

/** Parse a .tab body; throws upstream_error (with `url`) on any deviation from the format below. */
export function parseStatsTab(body: string, year: number, url: string): Omit<StatsTab, 'response'>;
```

```ts
/** 'packages/stats/{category}/{name}/{name}_{year}_stats.tab', each derived segment through pathSegment(). */
export function statsTabPath(category: StatsCategory, name: string, year: number): string;
```

It returns
`\`packages/stats/${category}/${pathSegment(name)}/${pathSegment(\`${name}_${year}_stats.tab\`)}\``.
`getStatsTab` fetches `statsTabPath(category, name, year)`. `not_found` returns `undefined`, and
every other error propagates.

`parseStatsTab` rules (strict; any violation →
`CapabilityError('upstream_error', \`bioconductor.org returned a stats file in an unexpected format (${url})\`, { upstream: 'bioconductor', url })`):

1. `lines = body.split(/\r?\n/).filter((line) => line !== '')`.
2. `lines[0] === 'Year\tMonth\tNb_of_distinct_IPs\tNb_of_downloads'`.
3. Every other line splits on `'\t'` into exactly four fields. Field 1 `=== String(year)`. Field 2
   is in `MONTHS` or is `'all'`. Fields 3 and 4 match `/^\d+$/` and become `Number`s.
4. Exactly 13 data lines: each month once and `all` once. `months` is returned in `MONTHS`
   order, whatever the file's order.

**Verified:** `edgeR_2026_stats.tab` is 306 bytes, `text/plain; charset=utf-8`, with
`last-modified: Thu, 22 Oct 2026 09:48:50 GMT` and no trailing newline. It has 13 data rows, and
`Nov` and `Dec` are `0 0` placeholders. The `all` row's downloads (723,176) equal the sum of the
months. Its distinct IPs (235,261) are fewer than the sum of the monthly figures, because each IP
counts once per year. A package added mid-year (`igblastr` 2025) has real `0 0` rows before its
first month. `edgeR_2009` has the same 13-row shape.

**404s look alike.** An unknown package, a package in another category
(`bioc/org.Hs.eg.db/org.Hs.eg.db_2026_stats.tab`), and a year with no stats (`edgeR_2008`, and
`edgeR_2027`) all return the same 11,685-byte HTML 404. That is why the page is fetched first: it
tells "no such package here" apart from "no stats that year". **Verified:** the package page URL
with a trailing slash returns 200 directly (no redirect) for `bioc/edgeR/`, `data-annotation/org.Hs.eg.db/`,
`data-experiment/airway/` and `workflows/rnaseqGene/`. Without the slash it is a 308.

### `src/core/pkg/release-info.ts`

#### Input

`z.object({})`. REST: `GET /api/v1/pkg/release_info`.

#### Data (output) schema

```ts
const VersionInfoSchema = z.object({
  version: z.string().describe('Bioconductor version, e.g. "3.23"'),
  r_version: z.string().describe("R version associated with it in config.yaml, e.g. '4.6.0'"),
  release_date: z
    .string()
    .nullable()
    .describe("Release date (YYYY-MM-DD) from config.yaml release_dates; null when absent (devel usually has none)"),
});

export const PkgReleaseInfoDataSchema = z.object({
  release: VersionInfoSchema.describe('The current release, from config.yaml'),
  devel: VersionInfoSchema.describe('The current devel version, from config.yaml'),
  manifest: z.object({
    generated: z.string().describe('When the manifest index was generated, ISO 8601'),
    release: z.string().describe('versions.release in the manifest index'),
    devel: z.string().describe('versions.devel in the manifest index'),
    serving_symlinks: z
      .object({ release: z.string().nullable(), devel: z.string().nullable() })
      .describe("Targets of the site's packages/release and packages/devel symlinks, from the manifest index; null if not listed"),
    build: z
      .string()
      .nullable()
      .describe('Identifier of the manifest build that produced the index (a commit-run id); null if the index gives none'),
    manifests: z
      .array(
        z.object({
          path: z.string().describe("e.g. '3.23/bioc.tsv.gz'"),
          url: z.string().nullable().describe('Download URL (not fetched by this server); null if the path is not in the expected form'),
          objects: z.number().int().describe('Objects listed in the manifest'),
          without_hash: z.number().int().describe('Objects with no usable MD5'),
        }),
      )
      .describe('Published manifests, in index order'),
  }),
  agree: z
    .boolean()
    .describe(
      'true when config.yaml, the manifest index versions and its packages/release and packages/devel symlinks all name the same release and devel versions (see disagreements; a symlink missing from the index is not checked)',
    ),
  disagreements: z.array(z.string()).describe('Each mismatch found, in plain words; empty when agree is true'),
});
```

#### Shaping rules

- **`parseReleaseDate(value: string | undefined): string | null`** (exported). It must match
  `/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/` (month/day/year). Return `YYYY-MM-DD`, zero-padded, or
  `null` if the value is absent, does not match, or is not a real date (round-trip through
  `Date.UTC`). `'04/29/2026'` → `'2026-04-29'`, `'1/5/2001'` → `'2001-01-05'`,
  `'13/01/2026'` → `null`.
- `release = { version: config.release_version, r_version: config.r_version_associated_with_release, release_date: parseReleaseDate(config.release_dates?.[config.release_version]) }`.
  Use `Object.hasOwn` before indexing `release_dates`, as `registryEntry` does. `devel` is
  built the same way.
- Manifest URLs: `MANIFEST_BASE_URL = 'https://bioconductor.org/api/v1/manifest/'`,
  `MANIFEST_PATH = /^\d+\.\d+\/[a-z][a-z-]*\.tsv\.gz$/`.
  `url = index.manifest_prefix === '/api/v1/manifest' && MANIFEST_PATH.test(path) ? new URL(path, MANIFEST_BASE_URL).href : null`.
  Upstream strings are never fetched, and a URL is built from them only after these checks.
- `serving_symlinks = { release: index.symlinks?.['packages/release'] ?? null, devel: index.symlinks?.['packages/devel'] ?? null }`
  (read with `Object.hasOwn`). `build = index.build ?? null`.
- **disagreements**, each check in this order, with this exact text:
  1. `config.release_version !== index.versions.release` →
     `` `config.yaml says release ${a}; the manifest index says ${b}.` ``
  2. The same for devel: `` `config.yaml says devel ${a}; the manifest index says ${b}.` ``
  3. `serving_symlinks.release !== null && serving_symlinks.release !== index.versions.release` →
     `` `The packages/release symlink points to ${s}; the manifest index says release ${b}.` ``
  4. The same for devel and `packages/devel`.
- `agree = disagreements.length === 0`.

Checks 3 and 4 compare fields of the same response. They are kept because the symlink is what
the site serves, and a release-day flip shows up there first. A disagreement is data, not an
error: the call still succeeds.

#### Handler

```ts
async handler(_input, deps) {
  const [{ response: configResponse, config }, { response: manifestResponse, index }] = await Promise.all([
    getBiocConfig(deps),
    getManifestIndex(deps),
  ]);
  // shape release, devel, manifest, disagreements as above
  return {
    data,
    summary,
    sources: [sourceFor(configResponse), sourceFor(manifestResponse, index.generated)],
  };
}
```

`config.yaml`'s `as_of` is its `Last-Modified`, or the fetch time. The manifest's is `generated`,
its own data timestamp. Either upstream failing fails the whole call.

#### Summary

`` `Bioconductor ${release.version} is the current release (R ${release.r_version}${release.release_date ? `, released ${release.release_date}` : ''}); ${devel.version} is devel (R ${devel.r_version}).` ``
followed by `' '` and either
`` `config.yaml and the manifest index (generated ${generated}) agree.` `` or
`` `The sources disagree: ${disagreements.join(' ')}` ``.

#### Capability

```ts
export const pkgReleaseInfo = defineCapability({
  module: 'pkg',
  name: 'pkg_release_info',
  title: 'Bioconductor release and devel versions',
  description:
    'Which Bioconductor versions are current: the release and devel version numbers, the R version each ' +
    'is associated with, the release date, and the published package manifests (one per repository and ' +
    "version, with object counts and download URLs). Reads bioconductor.org's config.yaml and the manifest " +
    'index and flags any disagreement between them (expected briefly around a release). Takes no input. ' +
    "For one package's build or propagation state use pkg_status; for download counts use pkg_downloads.",
  input: z.object({}),
  data: PkgReleaseInfoDataSchema,
  handler,
});
```

### `src/core/pkg/downloads.ts`

#### Input

```ts
input: z.object({
  package: PackageNameSchema,
  year: z
    .number()
    .int()
    .min(2009)
    .max(2100)
    .optional()
    .describe('Calendar year (stats start in 2009); default: the current year, or the latest year with stats if it has none yet'),
}),
```

REST: `GET /api/v1/pkg/downloads?package=edgeR&year=2025`. `queryToInput` already coerces
`integer` query values with `Number`. `year=abc` becomes `NaN` and `year=2025.5` is not an integer;
both fail the schema with 400 `invalid_input`. **Verified:** a throwaway `defineCapability` with
this input (and one with `z.object({})`) passed `validateRegistry`. Through `queryToInput` plus
`safeParse`, `year=2025` passed, and `abc`, `2025.5`, `2008` and `2101` failed.

#### Data (output) schema

```ts
const CountsSchema = z.object({
  distinct_ips: z.number().int().describe('Distinct client IP addresses'),
  downloads: z.number().int().describe('Package downloads'),
});

export const PkgDownloadsDataSchema = z.object({
  package: z.string(),
  category: z
    .enum(STATS_CATEGORIES)
    .describe("Stats category: 'bioc' (software), 'data-annotation', 'data-experiment' or 'workflows'"),
  year: z.number().int().describe('The year these figures are for'),
  year_requested: z.number().int().nullable().describe('The year asked for; null when it was defaulted'),
  data_as_of: z.string().nullable().describe('Date bioconductor.org computed these stats (YYYY-MM-DD); null if the stats page does not say'),
  months: z
    .array(CountsSchema.extend({ month: z.enum(MONTHS) }))
    .describe('Calendar months in order; months after data_as_of are omitted (the file holds 0 placeholders for them)'),
  partial_month: z.enum(MONTHS).nullable().describe('The month containing data_as_of, whose counts cover only part of it; null for a finished year'),
  total: CountsSchema.describe(
    "The file's yearly 'all' row. distinct_ips counts each IP once per year, so it is less than the sum of the monthly distinct_ips",
  ),
  years_available: z.array(z.number().int()).describe('Years with stats for this package, ascending'),
  note: z.string().nullable().describe('Set when the year was defaulted to an earlier one'),
  definition: z.string().describe('What the numbers count, and where they are documented'),
  stats_page_url: z.string().describe("bioconductor.org's stats page for this package"),
});
```

```ts
export const STATS_DEFINITION =
  "Bioconductor's published /packages/stats figures (https://bioconductor.org/packages/stats/): per calendar " +
  'month, package downloads and distinct client IP addresses from bioconductor.org. They do not separate ' +
  'people from automated clients. bioc-traffic recomputes them from the access logs on the same definition ' +
  'and documents where they differ: https://github.com/seandavi/bioc-traffic/blob/main/docs/published-comparison.md';
```

#### Handler

```ts
async handler({ package: name, year: requested }, deps) {
  const page = await findStatsPage(deps, name);
  if (!page) {
    throw new CapabilityError(
      'not_found',
      `No download stats for "${name}" in any Bioconductor category (${STATS_CATEGORIES.join(', ')}). ` +
        'Package names are case-sensitive.',
    );
  }
  // choose the year (below), then:
  const tab = await getStatsTab(deps, page.category, name, year);
  if (!tab) {
    throw new CapabilityError(
      'upstream_error',
      `bioconductor.org lists ${year} stats for ${name} but has no stats file for it`,
      { upstream: 'bioconductor', url: new URL(statsTabPath(page.category, name, year), BIOCONDUCTOR_BASE_URL).href },
    );
  }
  // shape (below)
  return {
    data,
    summary,
    sources: [sourceFor(page.response, page.dataAsOf ?? undefined), sourceFor(tab.response, page.dataAsOf ?? undefined)],
  };
}
```

**Choosing the year.** Let `current = deps.now().getUTCFullYear()` and `years = page.years`.

- `years` is empty → `not_found`:
  `` `${name} (${page.category}) has no yearly download stats on bioconductor.org.` ``
- `requested` set and not in `years` → `not_found`, without fetching a `.tab`:
  `` `${name} (${page.category}) has no download stats for ${requested}; years with stats: ${yearRanges(years)}.` ``
  (ascending runs joined by ', ', each run with an en dash, e.g. `2009, 2011–2026`; see Spec #44). Otherwise `year = requested`, `note = null`.
- `requested` unset and `current` in `years` → `year = current`, `note = null`.
- `requested` unset and `current` not in `years` → `year` is the largest element of `years` below
  `current`. `note` is
  `` `bioconductor.org has no ${current} download stats for ${name} yet; showing ${year}, the latest year with stats.` ``
  This is the January case: a year's file appears only after that year has downloads in a stats
  run. If no element of `years` is below `current` (every listed year is in the future, which
  should not happen), `year = years.at(-1)` with the same note.

**Shaping.**

- `asOfYear` and `asOfMonthIndex` (0-based) come from `page.dataAsOf` when it is set.
- If `page.dataAsOf !== null && year === asOfYear`, `months` is the `.tab`'s months with index
  `<= asOfMonthIndex`, and `partial_month = MONTHS[asOfMonthIndex]`. Otherwise `months` is all 12
  and `partial_month` is `null`.
- `total = tab.total`. `years_available = page.years`. `year_requested = requested ?? null`.
  `data_as_of = page.dataAsOf`. `definition = STATS_DEFINITION`. `stats_page_url = page.url`.

**Sources.** The stats page, then the `.tab`. Both get `as_of = data_as_of` when the page states
it, because the page and the file come from the same stats run. Otherwise each falls back to its
own `Last-Modified`, then the fetch time. Category pages that returned 404 are not listed. They
supplied no data, and a 404 result is an error, not an envelope.

#### Summary

`` `${name} (${category}) in ${year}: ${total.downloads} downloads from ${total.distinct_ips} distinct IPs` ``
\+ (partial_month ? `` ` through ${data_as_of}` `` : '') + `'.'`
\+ (note ? `` ` ${note}` `` : '')
\+ `' Figures follow bioconductor.org\'s published /packages/stats definition.'`

Numbers are written with `String(n)`, with no locale grouping, so the output is deterministic.

#### Capability

```ts
export const pkgDownloads = defineCapability({
  module: 'pkg',
  name: 'pkg_downloads',
  title: 'Package download stats',
  description:
    'Monthly download counts for one Bioconductor package in one calendar year, as bioconductor.org publishes ' +
    'them at /packages/stats: distinct IPs and downloads per month and for the year, with the date the stats ' +
    'were computed (data_as_of). Finds the package among software (bioc), annotation, experiment-data and ' +
    'workflow packages. year defaults to the current year, or the latest year with stats when the current ' +
    'year has none yet (early January). Package names are case-sensitive. Does not separate people from ' +
    'automated clients or give per-version or per-country counts. For build or propagation state use ' +
    'pkg_status; for release versions use pkg_release_info.',
  input,
  data: PkgDownloadsDataSchema,
  handler,
});
```

### `src/core/pkg/index.ts` and `status.ts`

```ts
export const pkgModule: Module = {
  name: 'pkg',
  description:
    'Package build and propagation state (Bioconductor registry, r-universe), release versions and ' +
    'download stats (bioconductor.org).',
  upstreams: [registryUpstream, rUniverseUpstreams.bioc, rUniverseUpstreams['bioc-release'], bioconductorUpstream],
  capabilities: [pkgStatus, pkgReleaseInfo, pkgDownloads],
};
```

In `pkgStatus.description`, replace the last sentence `'Does not read check logs, download
counts or release schedules.'` with
`'Does not read check logs. For download counts use pkg_downloads; for release and devel versions use pkg_release_info.'`.
Spec #6 left these cross-references to this issue.

### Transports

No changes. The scaffold derives them:

- **MCP:** tools `pkg_status`, `pkg_release_info`, `pkg_downloads` (registry order) on `/mcp`
  and `/mcp/pkg`. `structuredContent` is the envelope.
- **REST:** `GET /api/v1/pkg/release_info` and `GET /api/v1/pkg/downloads?package=…&year=…`,
  with the same envelope.
- `bioc://about` and `GET /api/v1/about` list upstream `bioconductor` with `ttl_seconds: 3600`
  and `used_by: ['pkg']`.

### Upstream calls

| Call | Example URL | Cache | `as_of` |
|---|---|---|---|
| config.yaml | `https://bioconductor.org/config.yaml` (12.9 KB) | 3600 s | `Last-Modified` |
| Manifest index | `https://bioconductor.org/api/v1/manifest/index.json` (14.4 KB) | 3600 s | `generated` |
| Stats page | `https://bioconductor.org/packages/stats/bioc/edgeR/` (115 KB), then `data-annotation/`, `data-experiment/`, `workflows/` on 404 | 3600 s (404s are not cached) | `data_as_of`, else `Last-Modified` |
| Stats file | `https://bioconductor.org/packages/stats/bioc/edgeR/edgeR_2026_stats.tab` (306 B) | 3600 s | `data_as_of`, else `Last-Modified` |

Links returned but never fetched: `https://bioconductor.org/api/v1/manifest/{path}`, the stats
page URL, and the two URLs in `STATS_DEFINITION`.

### Fixtures

All recorded verbatim. The paths mirror the URL under `test/fixtures/bioconductor/`:

```bash
B=https://bioconductor.org
F=test/fixtures/bioconductor
mkdir -p $F/api/v1/manifest $F/packages/stats/bioc/edgeR $F/packages/stats/workflows/rnaseqGene
curl -sf $B/config.yaml > $F/config.yaml
curl -sf $B/api/v1/manifest/index.json > $F/api/v1/manifest/index.json
curl -sf $B/packages/stats/bioc/edgeR/ > $F/packages/stats/bioc/edgeR/index.html
for y in 2025 2026; do
  curl -sf $B/packages/stats/bioc/edgeR/edgeR_${y}_stats.tab > $F/packages/stats/bioc/edgeR/edgeR_${y}_stats.tab
done
curl -sf $B/packages/stats/workflows/rnaseqGene/ > $F/packages/stats/workflows/rnaseqGene/index.html
curl -sf $B/packages/stats/workflows/rnaseqGene/rnaseqGene_2026_stats.tab \
  > $F/packages/stats/workflows/rnaseqGene/rnaseqGene_2026_stats.tab
```

About 215 KB in total, mostly the two HTML pages. They stay verbatim so the regexes are tested
against real markup.

`test/support/bioconductor-routes.ts` exports:

- `CONFIG_URL`, `MANIFEST_URL`, `statsPageUrl(category, name)`, and
  `statsTabUrl(category, name, year)`.
- `readBiocFixture(path)` (reads a file under test/fixtures/bioconductor/) and `NOT_FOUND` (the
  inline 404 route below).
- `bioconductorRoutes: Record<string, FixtureRoute>`:
  - config.yaml, with header `'last-modified': 'Sat, 01 Aug 2026 15:44:12 GMT'` (the value
    observed on 2026-10-22; use the live value when recording).
  - The manifest index.
  - The edgeR page and its 2025 and 2026 files. The 2026 file has header
    `'last-modified': 'Thu, 22 Oct 2026 09:48:50 GMT'`.
  - `bioc`, `data-annotation` and `data-experiment` pages for `rnaseqGene` as inline 404s,
    then its `workflows` page and 2026 file.
  - All four category pages for `edgr` as inline 404s.

  An inline 404 is `{ status: 404, body: 'Not Found', headers: { 'content-type': 'text/html' } }`.
  The adapter never reads a 404 body.

Scenarios, with the state observed on 2026-10-22. Tests assert against the recorded files. If a
package no longer fits its scenario when recorded, substitute one that does and say so in the PR.

| Scenario | Input (test clock) | Observed 2026-10-22 / expected |
|---|---|---|
| Release info, sources agree | `{}` | release 3.23 (R 4.6.0, 2026-04-29), devel 3.24 (R 4.6.0, date null); 10 manifests; agree true |
| Release info, versions disagree | manifest fixture with `versions.release` set to `'3.22'`, inline | agree false; disagreements `['config.yaml says release 3.23; the manifest index says 3.22.', 'The packages/release symlink points to 3.23; the manifest index says release 3.22.']` |
| Release info, symlink only | manifest fixture with `symlinks['packages/devel']` set to `'3.23'`, inline | disagreements `['The packages/devel symlink points to 3.23; the manifest index says devel 3.24.']` |
| Downloads, default year | `edgeR` (2026-10-22T12:00Z) | bioc; year 2026; months Jan–Oct; partial_month Oct; total 723176 / 235261; years 2009–2026 |
| Downloads, explicit past year | `edgeR`, 2025 | 12 months, partial_month null, year_requested 2025 |
| Downloads, other category | `rnaseqGene` | workflows; three 404 pages fetched first, in category order |
| Downloads, unknown package | `edgr` | `not_found`; four page requests, no `.tab` request |
| Downloads, year without stats | `edgeR`, 2027 (2026-10-22T12:00Z) | `not_found`: `edgeR (bioc) has no download stats for 2027; years with stats: 2009–2026.`; no `.tab` request |
| Downloads, January | `edgeR` (2027-01-05T12:00Z) | year 2026, year_requested null, note set; no 2027 `.tab` request; months Jan–Oct (data_as_of 2026-10-22) |

## Acceptance criteria

- [ ] `pkg_release_info` and `pkg_downloads` are registered in module `pkg`, after
      `pkg_status`. `validateRegistry(modules)` passes on the production list.
- [ ] `/mcp/pkg` lists exactly `['pkg_status', 'pkg_release_info', 'pkg_downloads']`. `/mcp`
      also lists `meta_ping`.
- [ ] `GET /api/v1/pkg/release_info` and `GET /api/v1/pkg/downloads?package=edgeR` return 200,
      and each body deep-equals the MCP `structuredContent` for the same input.
- [ ] `/api/v1/about` lists upstream `bioconductor` (`base_url: 'https://bioconductor.org/'`,
      `ttl_seconds: 3600`, `used_by: ['pkg']`).
- [ ] `yaml` is in `dependencies`, not `devDependencies`, and `package-lock.json` matches.
- [ ] Release info, agree scenario: the exact `release`, `devel`, `agree: true` and
      `disagreements: []` above. `manifest.manifests[0]` has `path: '3.23/bioc.tsv.gz'`,
      `url: 'https://bioconductor.org/api/v1/manifest/3.23/bioc.tsv.gz'`, and the fixture's
      `objects` and `without_hash` (30037 and 0 on 2026-10-22).
      `serving_symlinks` is `{ release: '3.23', devel: '3.24' }`. The sources are config.yaml
      (`as_of` = its route's `Last-Modified`, `'2026-08-01T15:44:12.000Z'`), then the manifest
      (`as_of` = the fixture's `generated`).
- [ ] Release info, both disagreement scenarios: the exact `disagreements` arrays above,
      `agree: false`, and the summary contains `The sources disagree:`.
- [ ] Release info errors: invalid YAML, config.yaml without `release_version`, a manifest that
      is not the schema's shape, and a 500 from either upstream each give `upstream_error`. No
      partial result.
- [ ] Downloads, one fixture test per scenario row, asserting `category`, `year`,
      `year_requested`, `months` (length and first and last entries), `partial_month`, `total`,
      `years_available`, `note`, `sources`, and the exact `fetch.calls`.
- [ ] The **404 package** (`edgr`): REST 404 `not_found`. The message names all four categories
      and says names are case-sensitive. MCP returns `isError` with text starting `not_found:`.
- [ ] The **January case**: with the clock at 2027-01-05, `year === 2026`, `year_requested ===
      null`, and `note` matches the template exactly. No URL containing `_2027_` is requested.
- [ ] Invalid input gives REST 400 `invalid_input` with `fetch.calls` empty, for each of:
      `package=a'b`, `package=x`, `year=2008` (below the 2009 minimum), `year=2101`,
      `year=2025.5` and `year=abc`.
- [ ] `parseDataAsOf`, `parseStatsYears`, `parseStatsTab`, `parseReleaseDate`: unit tests per the
      Test plan.
- [ ] Every envelope from the fixture scenarios is under 8,192 bytes (`envelopeBytes`). The PR
      reports the largest.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass. The PR reports the bundle size
      before and after the `yaml` move.

## Test plan

All tests run in Node with `fixtureFetch` and `createMemoryCache`. No network.

- `test/upstreams/bioconductor.test.ts`:
  - `parseDataAsOf`: the edgeR fixture gives `'2026-10-22'`. `'<I>Data as of Thu. 22 Oct 2026.</I>'`
    gives `'2026-10-22'`, and `'Data as of 5 Jan 2027'` gives `'2027-01-05'`. `'Data as of Thu. 31 Feb 2026'`,
    `'Data as of 22 Okt 2026'` and a page without the phrase give `null`.
  - `parseStatsYears`: the edgeR fixture gives 2009…2026 (18 values, ascending). Links for another
    name (`'edgeR2_2020_stats.tab'`) and `edgeR_stats.tab` are ignored. A name with dots
    (`'org.Hs.eg.db'`) matches only itself (`'orgXHsXegXdb_2020_stats.tab'` is ignored).
  - `parseStatsTab`: the 2026 fixture gives 12 months in order and `total` 723176 / 235261. A
    shuffled row order still comes back in calendar order. Each of these gives `upstream_error`:
    a wrong header, a missing month, a duplicate month, a wrong year, a non-numeric count, a
    five-field row, and a missing `all` row. `\r\n` line endings parse.
  - `findStatsPage`: `edgeR` is found in `bioc` with one request. `rnaseqGene` takes four
    requests in category order. `edgr` gives `undefined` after four requests. A 500 on the `bioc`
    page gives `upstream_error` and no further requests.
  - `getStatsTab`: 404 gives `undefined`, and 500 gives `upstream_error`.
  - `getBiocConfig`: the fixture parses to the four strings plus `release_dates['3.23'] ===
    '04/29/2026'`. An unquoted `release_version: 3.30` body gives `'3.30'`. Invalid YAML and a
    missing key give `upstream_error`.
  - `getManifestIndex`: the fixture parses, and an array body gives `upstream_error`.
- `test/core/pkg/release-info.test.ts`: `parseReleaseDate` (the examples above, plus
  `undefined` → null and `'2/30/2026'` → null), and the three release-info scenarios through
  `invokeCapability`. A manifest with `manifest_prefix: '/other'` gives `url: null` for every
  manifest. A manifest path `'../x.tsv.gz'` gives `url: null`. The summary is checked exactly for
  the agree scenario.
- `test/core/pkg/downloads.test.ts`: every downloads scenario through `invokeCapability` with
  `deps = { fetch: fixtureFetch({ ...bioconductorRoutes, ...extra }), cache: createMemoryCache(now), now, env: {} }`.
  Also:
  - A page without "Data as of": inline route copying the edgeR page with the phrase removed.
    `data_as_of` is null, there are 12 months, `partial_month` is null, and the source `as_of`
    is the 2026 file's `Last-Modified`.
  - A page that lists 2026 but whose `.tab` is 404 gives `upstream_error`.
  - The summary is checked exactly for the default-year scenario.
  - Caching: a second identical call within 3600 s makes no new requests.
- `test/transports/pkg.test.ts` (extend): routes `{ ...pkgRoutes, ...bioconductorRoutes }`. Covers
  the tools lists, REST vs MCP equality for both new tools, the downloads REST 400 and 404 bodies,
  the MCP `not_found:` text for `edgr`, and the about upstreams.

## Risks

- **HTML scraping for the as-of date and the year list.** If the stats page markup changes,
  `data_as_of` becomes `null`, which is degraded but still correct: sources fall back to
  `Last-Modified`, and all 12 months are returned, including the `0` placeholders for future
  months. If the `.tab` links disappear, `years` is empty and every call is `not_found`. That is
  a visible failure. bioc-traffic publishing `DATA_AS_OF` (proposal gap 4) and a JSON year list
  would remove both scrapes.
- **Four requests for an unknown package, uncached.** `fetchUpstream` caches only 200s, so each
  unknown name costs four 404 requests to bioconductor.org. Rate limiting on `/mcp` bounds it.
- **Page weight.** The edgeR page is 115 KB, read only for a date and a year list, and cached for
  1 h. Acceptable at this scale. A per-package JSON from bioc-traffic would cut it to bytes.
- **Partial current month.** `partial_month` marks it, but the counts for that month are not
  comparable to full months. The field description and summary ("through {date}") say so. The
  tool does not extrapolate.
- **Release-day windows.** config.yaml and the manifest index change at different times around a
  release, so `agree: false` is expected for a while. The description says so, so an agent does
  not report an outage.
- **`release_dates` format.** It is free-form `M/D/YYYY` with inconsistent padding. Anything else
  gives `release_date: null` rather than a wrong date.
- **Bundle size.** `yaml` adds about 45 KiB gzip, against the Workers limit of 3 MiB gzip on the
  free plan. The PR reports the measured figure.
- **Fixture drift.** Live stats change daily and config.yaml changes at each release. The tests
  pin the recorded files, and the scenario table gives the criteria for re-recording.
- **Upstream strings in output.** Versions, dates, manifest paths and symlink targets are
  returned as data. URLs are built only from manifest paths that pass `MANIFEST_PATH`. Mirror
  contacts in config.yaml are stripped by the schema.
