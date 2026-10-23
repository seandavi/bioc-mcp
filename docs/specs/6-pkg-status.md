# Spec #6: `pkg_status`, propagation and upstream build state

Issue: [seandavi/bioc-mcp#6](https://github.com/seandavi/bioc-mcp/issues/6).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md). Builds on the scaffold ([spec #2](2-scaffold.md),
[spec #15](15-scaffold-followups.md)).

Every upstream shape below was checked on 2026-10-22 against the live endpoints:
`https://bioc-registry.seandavi.workers.dev/data/prop/{bioc,bioc-release}/index.json`, the
registry's latest `bioc` observation (2,954 records), `https://bioc.r-universe.dev/api/packages/*`
for the packages named under [Fixtures](#fixtures), and the registry's
[`docs/api.md`](https://github.com/seandavi/bioc-registry/blob/main/docs/api.md). Notes marked
**Verified** record behaviour the implementer must account for. No new npm package is needed.

## Goal

The first `pkg` capability. Given a package and a universe, answer in one call:

- **Propagated?** The registry's propagation-index entry: version, sha256, when it was written,
  BiocCheck verdict, an artifacts summary, origin (passed the gate, or seeded from Bioconductor),
  and the source commit.
- **Upstream state.** r-universe's record: version, build status, commit, per-config check
  verdicts with GitHub Actions job ids and URLs, BiocCheck counts, and the newer commit that
  failed (`_failure`), if any.
- **Behind?** Whether r-universe's version is newer than the propagated one, and the reasons
  visible in the upstream data.
- **History.** A ready-to-run SQL query for the registry's `/sql` console plus its URL. The server
  does not execute it.

Unknown packages fail with `not_found` and close matches from the index. Package names are
validated before any fetch.

## Non-goals

- `pkg_check_output`, `pkg_build_environment` (#7), `pkg_release_info`, `pkg_downloads` (#8) and
  the `triage-failing-package` prompt (#10). The `pkg_status` description names no tool that does
  not exist yet. Those issues add their cross-references to it.
- Executing SQL, or reading the registry's observations or parquet history.
- Calling the registry's `POST /gate`. `fetchUpstream` is GET-only, and v0 tools are thin
  adapters over GET endpoints. The "behind" reasons come only from r-universe's record.
- Reading the body of an r-universe 404 (see [Risks](#risks)).
- The MCP `ttlMs` result hint, pagination, or any change to `src/upstreams/http.ts`,
  `src/upstreams/cache.ts`, `src/envelope.ts` or the transports.
- Filing the registry gap issue (#13). The PR reports the parse measurement (see
  [Acceptance](#acceptance-criteria)).

## Design

### Files

```
src/upstreams/registry.ts        NEW  UNIVERSES, Universe, registryUpstream, getPropagationIndex(),
                                      RegistryEntrySchema, RegistryEntry
src/upstreams/r-universe.ts      NEW  rUniverseUpstreams, getUniversePackage(),
                                      RUniversePackageSchema, RUniversePackage
src/core/pkg/package-name.ts     NEW  PackageNameSchema, closeMatches()
src/core/pkg/status.ts           NEW  pkgStatus capability, PkgStatusDataSchema, compareRVersions(),
                                      historySql(), and the private shaping helpers
src/core/pkg/index.ts            NEW  pkgModule
src/core/registry.ts             modules = [metaModule, pkgModule]
test/support/pkg-routes.ts       NEW  fixture URL → FixtureRoute map shared by the pkg tests
test/upstreams/registry.test.ts  NEW
test/upstreams/r-universe.test.ts NEW
test/core/pkg/package-name.test.ts NEW
test/core/pkg/status.test.ts     NEW
test/transports/pkg.test.ts      NEW  REST and MCP over pkgModule
test/fixtures/registry/prop/bioc/index.json          NEW (trimmed, see Fixtures)
test/fixtures/registry/prop/bioc-release/index.json  NEW (trimmed)
test/fixtures/r-universe/bioc/<Package>.json         NEW (verbatim), one per package below
test/fixtures/r-universe/bioc-release/edgeR.json     NEW (verbatim)
```

Import zod as `import * as z from 'zod'`. Build every upstream path with `pathSegment()` for each
caller-supplied value (`universe`, `package`), and fetch only through `fetchUpstream` /
`fetchUpstreamJson`.

### `src/upstreams/registry.ts`

```ts
export const UNIVERSES = ['bioc', 'bioc-release'] as const;
export type Universe = (typeof UNIVERSES)[number];

export const REGISTRY_BASE_URL = 'https://bioc-registry.seandavi.workers.dev/';

export const registryUpstream: Upstream = {
  id: 'registry',
  name: 'Bioconductor propagation registry',
  baseUrl: REGISTRY_BASE_URL,
  ttlSeconds: 300,
  timeoutMs: 15_000, // the index is ~8 MB
  description:
    'bioc-registry: the propagation index (which package versions passed the gate or were seeded) ' +
    'and build observations, for the bioc (devel) and bioc-release universes.',
};
```

The `id` is `registry` and the `baseUrl` is the registry root, so #7 (`/checks`, `/builds`) reuses
this same object. `validateRegistry` rejects two different declarations of one id.

**Entry schema.** Validate only the one sliced entry, never all 2,894. Unknown keys (`desc`,
the rest of `meta`) are stripped by `z.object`:

```ts
const ArtifactSchema = z.object({
  os: z.string(),
  r: z.string(), // '' for os 'src'
  arch: z.string().optional(),
  distro: z.string().optional(),
});

export const RegistryEntrySchema = z.object({
  version: z.string(),
  sha256: z.string(),
  ts: z.string(),
  bioccheck: z.string().nullish(), // absent on 895/2,894; null on seeded entries
  artifacts: z.array(ArtifactSchema),
  archs: z.array(z.string()).optional(), // absent on 1,837/2,894 (older entries)
  origin: z.string().optional(), // absent → 'r-universe' (registry docs: "read as r-universe")
  meta: z
    .object({
      commit: z.object({ id: z.string(), time: z.number() }).optional(), // time: epoch seconds
      git_url: z.string().optional(),
    })
    .optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
```

**Verified (bioc index, 2026-10-22):** 2,894 entries, 8,028,774 bytes. `origin` is absent on
1,960, `r-universe` on 788, `bioconductor` on 119, `bioc-build` on 27. `bioccheck` values include
`ERROR`, `WARNING`, `NOTE`, `FAILURE`, `FAIL`, `OK`, lowercase `error`/`warning`/`ok`, and `null`.
`meta.commit` is missing on one entry. Seeded commit ids are 7 characters, the rest are 40. The
response has `cache-control: no-store` and **no `Last-Modified`**, so `as_of` for this source is
the fetch time.

**Index reader with a per-isolate parse memo.**

```ts
export interface PropagationIndex {
  response: UpstreamResponseMeta; // for sourceFor(); the ~8 MB body is dropped once parsed
  packages: Record<string, unknown>; // parsed index.json; entries unvalidated
}

/** GET data/prop/{universe}/index.json, parsed once per cache TTL per isolate. */
export async function getPropagationIndex(deps: Deps, universe: Universe): Promise<PropagationIndex>;
```

Behaviour:

1. `path = \`data/prop/${pathSegment(universe)}/index.json\``, `url = new URL(path, REGISTRY_BASE_URL).href`.
2. Memo: `const parsedIndexes = new WeakMap<UpstreamCache, Map<string, MemoEntry>>()` at module
   scope (Since #52 this memo, its load deadline and `withinMs` live in `SharedLoads` in
   src/upstreams/shared-load.ts; `getPropagationIndex` calls `propagationIndexes.get`), keyed by `deps.cache` then `url`, where `MemoEntry = { load: Promise<PropagationIndex>;
   expiresAt: number;
   loadDeadline: number | undefined }`. The memo lives exactly as long as the cache it sits in front of, so each
   test app (fresh `createMemoryCache`) gets a fresh memo and the Worker (one cache per isolate)
   parses at most once per TTL. It memoizes the **in-flight Promise**, not the resolved value:
   the entry is stored before anything is awaited, so concurrent callers
   on a cold or expired entry await the same load instead of each reading the 8 MB body from the
   cache and parsing it. While the load is in flight the entry is bounded:
   `loadDeadline = expiresAt = now + LOAD_DEADLINE_MS`, where `LOAD_DEADLINE_MS =
   registryUpstream.timeoutMs + 5000` (the allowance covers the cache read and the parse, which
   `fetchUpstream`'s timeout does not). When the load resolves, `expiresAt` becomes
   `Date.parse(response.fetchedAt) + registryUpstream.ttlSeconds * 1000` and `loadDeadline` is
   cleared. If a live entry exists (`deps.now().getTime() < expiresAt`), await its `load` and
   return it with `response.fromCache = true`. Neither `deps.cache` nor `deps.fetch` is called by such a caller.
   If the load rejects, delete the entry (errors are not cached); callers already awaiting it see
   the same rejection. Replacing an expired entry drops the old parsed index at once.

   **No caller waits on a load without a deadline.** The load runs on request A's I/O, which the
   runtime cancels when A's client disconnects and which can stall in `cache.match` or
   `hit.text()` outside `fetchUpstream`'s timeout; a promise shared through a module-level memo
   would then never settle for requests B, C and so on. So the owner and every joiner race the
   load against their own timer (the owner for `LOAD_DEADLINE_MS`, a joiner for the time left to
   `loadDeadline`) and fail with `upstream_timeout`; an in-flight entry past its `loadDeadline`
   is replaced by the next caller, which starts a fresh load.
3. The load is `fetchUpstreamJson(deps, registryUpstream, path)`. If the JSON is not a plain object
   (`typeof json !== 'object' || json === null || Array.isArray(json)`), throw
   `CapabilityError('upstream_error', 'Bioconductor propagation registry returned an index that is not a JSON object', { upstream: 'registry', url })`.
4. A `not_found` from the registry (the index file is missing) is rethrown as
   `CapabilityError('upstream_error', \`Bioconductor propagation registry has no propagation index for ${universe}\`, …)`
   so it is never mistaken for "package not found".
5. The load resolves to `{ response: <response without body>, packages: json }`, which the memo keeps and the first caller returns.

**Why the memo:** a cold `JSON.parse` of the 8 MB index took 11–18 ms in Node 26 on an Apple
M-series laptop (five runs) and retained about 13 MB of heap. Without the memo, every call would
read 8 MB out of the Cache API and parse it again. The figure in the Worker is unmeasured until
deploy (#11). See [Risks](#risks).

```ts
/** packages[name] validated with RegistryEntrySchema; undefined when absent. */
export function registryEntry(index: PropagationIndex, name: string): RegistryEntry | undefined;
```

Use `Object.hasOwn(index.packages, name)` (not `in`; `name` could be `constructor`, which the
package regex allows). A failed `safeParse` throws
`CapabilityError('upstream_error', \`Bioconductor propagation registry entry for ${name} has an unexpected shape\`, { upstream: 'registry', url })`.

### `src/upstreams/r-universe.ts`

```ts
export const rUniverseUpstreams: Record<Universe, Upstream> = {
  bioc: {
    id: 'r-universe-bioc',
    name: 'r-universe (bioc)',
    baseUrl: 'https://bioc.r-universe.dev/api/',
    ttlSeconds: 300,
    description: 'r-universe builds and checks of Bioconductor devel (bioc.r-universe.dev).',
  },
  'bioc-release': {
    id: 'r-universe-bioc-release',
    name: 'r-universe (bioc-release)',
    baseUrl: 'https://bioc-release.r-universe.dev/api/',
    ttlSeconds: 300,
    description: 'r-universe builds and checks of Bioconductor release (bioc-release.r-universe.dev).',
  },
};
```

```ts
const RUniverseCommitSchema = z.object({ id: z.string(), time: z.number(), message: z.string().optional() });
const RUniverseJobSchema = z.object({
  job: z.number().int(),
  config: z.string(),
  r: z.string().nullish(),
  check: z.string().nullish(),
});
export const RUniversePackageSchema = z.object({
  Package: z.string(),
  Version: z.string(),
  _status: z.string(),
  _commit: RUniverseCommitSchema,
  _created: z.string().nullish(),
  _buildurl: z.string(),
  _bioccheck: z.object({ error: z.number(), warning: z.number(), note: z.number() }).nullish(),
  _jobs: z.array(RUniverseJobSchema).nullish(),
  _failure: z
    .object({
      version: z.string(),
      commit: RUniverseCommitSchema,
      buildurl: z.string(),
      date: z.string(),
      job: RUniverseJobSchema.nullish(),
    })
    .nullish(),
});
export type RUniversePackage = z.infer<typeof RUniversePackageSchema>;

export type UniversePackageResult =
  | { found: true; response: UpstreamResponse; record: RUniversePackage }
  | { found: false; source: Source }; // what was asked, as_of = deps.now()

/** GET {universe}.r-universe.dev/api/packages/{name}. A 404 is { found: false }, not an error. */
export async function getUniversePackage(deps: Deps, universe: Universe, name: string): Promise<UniversePackageResult>;
```

Behaviour:

- `fetchUpstreamJson(deps, rUniverseUpstreams[universe], \`packages/${pathSegment(name)}\`)`.
- Catch `CapabilityError` with `code === 'not_found'`. Return
  `{ found: false, source: { url: error.details.url, as_of: deps.now().toISOString() } }`. Every
  other error propagates, so an r-universe outage fails the whole call. No partial results.
- `RUniversePackageSchema.safeParse(json)` fails →
  `CapabilityError('upstream_error', \`${upstream.name} returned an unexpected record for ${name}\`, { upstream: upstream.id, url })`.
- `record.Package !== name` → the same `upstream_error`. **Verified:** the API is case-sensitive
  (`/api/packages/trackviewer` is 404), so this never fires on correct input.

**Verified:** a record is 8–55 KB of JSON with about 70 keys; only the fields above are read. Every
record in the latest observation has `_buildurl` (a `https://github.com/r-universe/<universe>/actions/runs/<id>`
URL), `_commit` with `id, time, message`, and `_jobs` items with `job, config, r, check, time, artifact`.
Observed `check` values: `OK`, `NOTE`, `WARNING`, `ERROR`, `FAIL`, `FAILURE`. At most 16 jobs.
`_failure` is `null` or has `{version, commit, buildurl, date, job}`, where `job` is one job object.
The response carries `Last-Modified`, so `sourceFor(response)` gives a real as-of time. A 404 is
`text/plain` and comes in two forms: `Package X not found in bioc`, and
`Package X failed to build: <run url>` (a build that failed outright, with no successful record).
`fetchUpstream` does not expose 404 bodies, so the adapter treats both as "no record".

### `src/core/pkg/package-name.ts`

```ts
/** R package name: starts with a letter, letters/digits/'.', at least two characters, no trailing '.'. */
export const PackageNameSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/, 'Not a valid R package name')
  .describe('Package name, case-sensitive, e.g. "edgeR"');

/** Up to `limit` names from `candidates` close to `name`, best first. */
export function closeMatches(name: string, candidates: Iterable<string>, limit = 5): string[];
```

`closeMatches` algorithm (exact, so tests can pin it):

1. `q = name.toLowerCase()`.
2. For each candidate `c` with `lc = c.toLowerCase()`: `d = levenshtein(q, lc)` (insert, delete,
   substitute, each cost 1; a private two-row DP helper in this file), and
   `prefix = q.length >= 3 && lc.startsWith(q)`.
3. Keep `c` if `c !== name && (d <= 2 || prefix)`.
4. Sort by `d` ascending, then by `c` with plain `<` comparison (code-unit order, not
   `localeCompare`). Return the first `limit`.

**Verified:** every name in both the index and the observation matches the regex. The regex
admits no quote, slash or whitespace, which makes `historySql` safe to interpolate.

### `src/core/pkg/status.ts`

#### Input

```ts
input: z.object({
  package: PackageNameSchema,
  universe: z
    .enum(UNIVERSES)
    .default('bioc')
    .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
}),
```

**Verified:** `validateRegistry` accepts this schema (REST-carriable, idempotent). A throwaway
`defineCapability` + `validateRegistry` + `queryToInput` run against the scaffold passed.

#### Data (output) schema

```ts
const CommitSchema = z.object({
  id: z.string().describe('Git commit SHA; seeded entries carry a 7-character short SHA'),
  time: z.string().describe('Commit time, ISO 8601'),
});

const JobSchema = z.object({
  config: z.string().describe("Build config, e.g. 'source', 'linux-release-x86_64', 'bioc-checks'"),
  r: z.string().nullable().describe('R version the job ran'),
  check: z
    .string()
    .nullable()
    .describe('R CMD check verdict as r-universe reports it (OK, NOTE, WARNING, ERROR, FAIL, FAILURE), or null'),
  job: z.number().int().describe('GitHub Actions job id; the key for the registry check and build logs'),
  url: z.string().nullable().describe('GitHub Actions job page; null if the build URL is not a GitHub Actions run'),
});

export const PkgStatusDataSchema = z.object({
  package: z.string(),
  universe: z.enum(UNIVERSES),
  propagated: z
    .object({
      version: z.string(),
      sha256: z.string().describe('Source tarball sha256'),
      propagated_at: z.string().describe("When this index entry was written (the entry's ts), ISO 8601"),
      origin: z
        .string()
        .describe(
          "'r-universe' passed the gate from an r-universe build; 'bioc-build' passed the gate from bioc-build CI; " +
            "'bioconductor' was seeded from Bioconductor's release build and never passed the gate",
        ),
      passed_gate: z.boolean().nullable().describe('false for seeded entries; null for an origin this server does not know'),
      bioccheck: z.string().nullable().describe('BiocCheck verdict recorded at propagation (advisory, never gating)'),
      archs: z.array(z.string()).nullable().describe('Platform families that passed the gate; null on older entries'),
      source_commit: CommitSchema.nullable(),
      git_url: z.string().nullable().describe('Repository the package was built from (a read-only mirror)'),
      artifacts: z
        .array(
          z.object({
            os: z.string().describe("'src', 'linux', 'mac', 'win' or 'wasm'"),
            r: z.string().nullable().describe('R version of a binary; null for the source tarball'),
            arch: z.string().nullable(),
            distro: z.string().nullable(),
          }),
        )
        .describe('Propagated artifacts, in index order'),
    })
    .nullable()
    .describe('The propagation-index entry; null when the package is not in the index'),
  upstream: z
    .object({
      version: z.string(),
      status: z.string().describe("r-universe build status, e.g. 'success' or 'failure'"),
      commit: CommitSchema.extend({
        message: z.string().describe('First line of the commit message, at most 120 characters'),
      }),
      built_at: z.string().nullable().describe("r-universe's _created, ISO 8601"),
      build_url: z.string().describe('GitHub Actions run that built this version'),
      bioccheck: z
        .object({ error: z.number(), warning: z.number(), note: z.number() })
        .nullable()
        .describe('BiocCheck counts'),
      jobs: z.array(JobSchema).describe('Per-config check results, in r-universe order'),
      newer_commit_failed: z
        .object({
          version: z.string(),
          commit: CommitSchema.extend({ message: z.string() }),
          failed_at: z.string(),
          build_url: z.string(),
          job: JobSchema.nullable(),
        })
        .nullable()
        .describe("r-universe's _failure: a newer commit whose build failed, so this version is still served"),
    })
    .nullable()
    .describe('The r-universe record; null when r-universe has no current build'),
  behind: z
    .boolean()
    .nullable()
    .describe('true if the r-universe version is newer than the propagated one; null if either is missing or unparseable'),
  behind_reasons: z.array(z.string()).describe('Why it is behind or not propagated, as far as the upstream data shows'),
  history_sql: z.object({
    query: z.string().describe("DuckDB SQL over the registry's jobs view: this package's check history"),
    console_url: z.string().describe('Paste the query into this page; this server does not run it'),
  }),
});
```

#### Shaping rules

- `epochToIso(seconds) = new Date(seconds * 1000).toISOString()`. **Verified:**
  `1790710331 → 2026-09-29T19:32:11.000Z`.
- `firstLine(message) = (message ?? '').split('\n')[0].trim().slice(0, 120)`.
- **propagated** (from `RegistryEntry`): `origin = entry.origin ?? 'r-universe'`.
  `passed_gate`: `true` for `r-universe` and `bioc-build`, `false` for `bioconductor`, `null`
  otherwise. `bioccheck = entry.bioccheck ?? null`, `archs = entry.archs ?? null`,
  `source_commit = entry.meta?.commit ? { id, time: epochToIso(time) } : null`,
  `git_url = entry.meta?.git_url ?? null`. Artifacts map `{ os, r: r === '' ? null : r, arch: arch ?? null, distro: distro ?? null }`.
  Drop `file` and `sha256`.
- **upstream** (from `RUniversePackage`): `jobs = (record._jobs ?? []).map(toJob(record._buildurl))`.
  `toJob(buildUrl)(j)` gives `{ config, r: j.r ?? null, check: j.check ?? null, job, url }`, with
  `url = GHA_RUN.test(buildUrl) ? \`${buildUrl}/job/${j.job}\` : null` and
  `GHA_RUN = /^https:\/\/github\.com\/r-universe\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/`.
  The URLs are built, never fetched. `newer_commit_failed` uses `_failure.buildurl` for its job
  URL. `bioccheck = record._bioccheck ?? null`, `built_at = record._created ?? null`.
- **`compareRVersions(a, b): -1 | 0 | 1 | null`** (exported). Each argument must match
  `/^\d+([.-]\d+)*$/`, else `null`. Split on `/[.-]/` and compare numerically, component by
  component; a missing component counts as lower (`1.2 < 1.2.0`, as R's `package_version` does).
- **behind**: `null` if `propagated` or `upstream` is null, or if
  `cmp = compareRVersions(upstream.version, propagated.version)` is `null`. Otherwise `cmp === 1`.
- **`failingChecks(jobs)`**: jobs with `config !== 'bioc-checks'` (BiocCheck is advisory) and
  `/^(error|fail|failure)$/i.test(check ?? '')`, formatted `\`${config} (${check})\``, in job order.
- **behind_reasons**: `[]` unless `upstream !== null && (behind === true || propagated === null)`.
  Otherwise, in this order:
  1. `propagated === null` → `` `No entry in the ${universe} propagation index.` ``
  2. `propagated.origin === 'bioconductor'` → `'The propagated entry was seeded from Bioconductor\'s release build and never passed the gate; it stays at its seeded version until a newer version passes the gate.'`
  3. `upstream.status !== 'success'` → `` `r-universe's build of ${upstream.version} has status "${upstream.status}".` ``
  4. `failingChecks` non-empty → `` `R CMD check fails on ${first five joined by ', '}${n > 5 ? ` and ${n - 5} more` : ''}.` ``
  5. If neither 3 nor 4 applied → `'r-universe shows no failing build or check for this version, so the gate rejected it on another rule (platform families, dependencies, manifest) or has not evaluated it yet; the registry\'s POST /gate gives the rule-by-rule decision.'`
- **`historySql(universe, name)`** (exported) returns exactly:

  ```
  SELECT obs_ts, config, r, "check", time, job
  FROM jobs
  WHERE universe = '<universe>' AND package = '<name>'
  ORDER BY obs_ts DESC, config
  LIMIT 200
  ```

  with lines joined by `'\n'` and `console_url = 'https://bioc-registry.seandavi.workers.dev/sql'`.
  **Verified:** the columns exist in the registry's `jobs` parquet (checked with the DuckDB CLI
  against the 2026-10-22 parquet). `jobs` is the view `/sql` defines over them. `/sql` takes no
  query parameter, so the URL cannot carry the query.

#### Handler

```ts
async handler({ package: name, universe }, deps) {
  const [index, universePackage] = await Promise.all([
    getPropagationIndex(deps, universe),
    getUniversePackage(deps, universe, name),
  ]);
  const entry = registryEntry(index, name);
  if (!entry && !universePackage.found) {
    const matches = closeMatches(name, Object.keys(index.packages));
    throw new CapabilityError(
      'not_found',
      `No ${universe} propagation entry and no r-universe build for "${name}". Package names are case-sensitive.` +
        (matches.length > 0 ? ` Did you mean: ${matches.join(', ')}?` : ''),
    );
  }
  // shape propagated, upstream, behind, behind_reasons, history_sql as above
  return {
    data,
    summary,
    sources: [
      sourceFor(index.response),
      universePackage.found ? sourceFor(universePackage.response) : universePackage.source,
    ],
  };
}
```

"Unknown package" means unknown to both the index and r-universe. A package r-universe builds but
the index has never held is not unknown: the result has `propagated: null` and says why it has
not propagated. **Verified:** 61 packages in the latest `bioc` observation are not in the index
(e.g. `BiocSet`), and 1 index entry has no r-universe record (`Fletcher2013a`).

#### Summary (the MCP text content)

Join the applicable sentences with `' '`:

1. Propagation:
   - entry present: `` `${name} (${universe}) is propagated at ${version} (${originLabel}, ${propagated_at.slice(0, 10)}).` ``,
     where `originLabel` is `passed the gate via r-universe`, `passed the gate via bioc-build`,
     `seeded from Bioconductor, never gated`, or `` `origin ${origin}` ``.
   - absent: `` `${name} is not in the ${universe} propagation index.` ``
2. Upstream:
   - found: `` `r-universe builds ${version}: status ${status}` `` + (failing checks:
     `` `, failing ${first three}${n > 3 ? ` and ${n - 3} more` : ''}` ``) + `'.'`
   - not found: `` `r-universe has no current build of ${name} in ${universe}.` ``
3. `behind === true`: `` `Upstream ${upstream.version} is newer than propagated ${propagated.version}.` ``
4. `newer_commit_failed`: `` `A newer commit (${version}) failed` `` + (job ? `` ` on ${job.config} (${job.check ?? 'no verdict'})` `` : '') + `'.'`

#### Capability

```ts
export const pkgStatus = defineCapability({
  module: 'pkg',
  name: 'pkg_status',
  title: 'Package propagation and build status',
  description:
    'Is a Bioconductor package propagated to the registry, at which version and commit, and what is its ' +
    'upstream r-universe build state: overall status, per-config R CMD check verdicts with GitHub Actions ' +
    'job ids, BiocCheck counts, and whether a newer commit failed. Says whether r-universe is ahead of the ' +
    "propagated version and why, and returns a SQL query for the package's check history to run in the " +
    "registry's /sql console (not executed). universe 'bioc' is devel (default), 'bioc-release' is release. " +
    'Package names are case-sensitive. Does not read check logs, download counts or release schedules.',
  input,
  data: PkgStatusDataSchema,
  handler,
});
```

### `src/core/pkg/index.ts`

```ts
export const pkgModule: Module = {
  name: 'pkg',
  description: 'Package build and propagation state from the Bioconductor registry and r-universe.',
  upstreams: [registryUpstream, rUniverseUpstreams.bioc, rUniverseUpstreams['bioc-release']],
  capabilities: [pkgStatus],
};
```

`src/core/registry.ts`: `export const modules: readonly Module[] = [metaModule, pkgModule];`.

### Transports

No changes. The scaffold derives them:

- **MCP:** tool `pkg_status` on `/mcp` and `/mcp/pkg`. `structuredContent` is the envelope.
- **REST:** `GET /api/v1/pkg/status?package=edgeR&universe=bioc`. The body is the same envelope.
  `universe` is optional.
- `bioc://about` and `GET /api/v1/about` list module `pkg` and the three upstreams.

### Upstream calls

| Call | Example URL | Cache | `as_of` |
|---|---|---|---|
| Propagation index | `https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` (~8 MB, 2,894 packages; `bioc-release` ~7.8 MB) | 300 s + parse memo | fetch time (no `Last-Modified`) |
| r-universe package | `https://bioc.r-universe.dev/api/packages/trackViewer`, `https://bioc-release.r-universe.dev/api/packages/edgeR` | 300 s | `Last-Modified` |

Links returned but never fetched: `https://github.com/r-universe/bioc/actions/runs/<run>/job/<job>`
and `https://bioc-registry.seandavi.workers.dev/sql`.

### Fixtures

The r-universe records are committed verbatim. The index fixtures are the real index trimmed to
the listed keys, each entry unchanged (the full index is 8 MB). Record with:

```bash
B=https://bioc-registry.seandavi.workers.dev
mkdir -p test/fixtures/registry/prop/bioc test/fixtures/registry/prop/bioc-release \
         test/fixtures/r-universe/bioc test/fixtures/r-universe/bioc-release
curl -sf $B/data/prop/bioc/index.json |
  jq '{trackViewer, Chromatograms, RMassBank, biomaRt, ClustIRR, SEMPLR, Fletcher2013a, edgeR, edge}' \
  > test/fixtures/registry/prop/bioc/index.json
curl -sf $B/data/prop/bioc-release/index.json | jq '{edgeR}' > test/fixtures/registry/prop/bioc-release/index.json
for p in trackViewer Chromatograms RMassBank biomaRt ClustIRR SEMPLR BiocSet; do
  curl -sf https://bioc.r-universe.dev/api/packages/$p > test/fixtures/r-universe/bioc/$p.json
done
curl -sf https://bioc-release.r-universe.dev/api/packages/edgeR > test/fixtures/r-universe/bioc-release/edgeR.json
```

Test 404s use inline routes (`{ status: 404, body: 'Error: Package edgr not found in bioc' }`)
because the adapter never reads the body.

Scenarios and the state observed on 2026-10-22. Tests assert against the recorded files. If a
package no longer fits its scenario when recorded, substitute one that does (criterion column)
and say so in the PR.

| Scenario | Package (universe) | Criterion | Observed 2026-10-22 |
|---|---|---|---|
| Propagated and passing | `trackViewer` (bioc) | index version = r-universe version, `_status` success, `_failure` null, origin `r-universe` | 1.49.3 both; 10 jobs, only `bioc-checks` WARNING; behind false |
| Upstream newer and failing | `Chromatograms` (bioc) | r-universe version > index version, `_status` failure | 1.3.3 propagated; 1.3.4 failure, `source (ERROR)`; behind true |
| Newer commit failed, not behind | `RMassBank` (bioc) | `_failure` set, versions equal, origin absent | 3.23.0 both, success; `_failure` 3.23.1 on `source` ERROR; no `archs` in entry → null; origin → `r-universe` |
| Seeded only, upstream failing | `biomaRt` (bioc) | origin `bioconductor`, r-universe version newer, status failure | 2.69.0 seeded (7-char commit, `bioccheck` null, `archs` []); 2.69.5 failure |
| Seeded, upstream success but checks failing | `ClustIRR` (bioc) | origin `bioconductor`, r-universe newer, status success, non-source configs ERROR | 1.11.0 seeded; 1.11.6 success, 13 configs ERROR; reasons: seeded + "fails on … and 8 more" |
| Never propagated | `BiocSet` (bioc) | in r-universe, not in index | 1.27.0 failure; propagated null, behind null |
| Propagated, no upstream record | `Fletcher2013a` (bioc) | in index, r-universe 404 | upstream null, behind null, r-universe source with `as_of` = test clock |
| Largest result | `SEMPLR` (bioc) | the most artifacts (27) plus 16 jobs in the index | 1.1.2 both |
| Release universe | `edgeR` (bioc-release) | any package in both bioc-release sources | 4.10.7 both, success |
| Unknown package | `edgr` (bioc) | not in index, r-universe 404 | `not_found`; "Did you mean: edge, edgeR?" |
| Wrong case | `biomart` (bioc) | lowercase of an index name, r-universe 404 | `not_found`; "Did you mean: biomaRt?" |

`test/support/pkg-routes.ts` exports `pkgRoutes: Record<string, FixtureRoute>` mapping each URL
above to its file or inline 404, and constants `BIOC_INDEX_URL`, `RELEASE_INDEX_URL`,
`ruUrl(universe, name)`. Give the `trackViewer` route the header
`'last-modified': 'Thu, 22 Oct 2026 12:19:43 GMT'` so a test can pin `as_of`.

## Acceptance criteria

- [ ] `pkg_status` is registered in module `pkg`. `validateRegistry(modules)` passes on the
      production list `[metaModule, pkgModule]`.
- [ ] `/mcp/pkg` lists exactly `['pkg_status']`, and `/mcp` lists `meta_ping` and `pkg_status`.
- [ ] `GET /api/v1/pkg/status?package=trackViewer` returns 200, and its body deep-equals the MCP
      `structuredContent` for the same input.
- [ ] Fixture tests, one per scenario row above, assert `propagated`, `upstream`, `behind`,
      `behind_reasons`, `sources` and key summary substrings.
- [ ] Propagated and passing (`trackViewer`): `behind === false`, `behind_reasons` is `[]`,
      `propagated.origin === 'r-universe'`, `passed_gate === true`, and 10 jobs with
      `url === \`${build_url}/job/${job}\``.
- [ ] Upstream newer and failing (`Chromatograms`): `behind === true` and the reasons include the
      status and `source (ERROR)`.
- [ ] Seeded only (`biomaRt`): `origin === 'bioconductor'`, `passed_gate === false`,
      `bioccheck === null`, and the seeded reason comes first.
- [ ] Unknown package (`edgr`): REST 404 `not_found` whose message contains `Did you mean: edge, edgeR?`.
      MCP returns `isError` with text starting `not_found:`. Both upstreams were requested.
- [ ] An invalid name (`a'b`, `1abc`, `x`, `edgeR.`) gives REST 400 `invalid_input`, and
      `fetch.calls` is empty.
- [ ] `universe=cran` gives REST 400. `universe=bioc-release` fetches only the bioc-release URLs.
- [ ] Every success returns two sources, registry first: the index URL with `as_of` = fetch time,
      then the r-universe URL (`as_of` = Last-Modified when present, else the test clock).
- [ ] The `SEMPLR` envelope is under 8,192 bytes (`envelopeBytes`). The PR reports the figure.
- [ ] Parse memo: two calls within 300 s request the index once and call `cache.get` for its URL
      once. After advancing the clock 301 s it is fetched again. Two concurrent calls (cold, and
      after expiry) also request the index once; a failed load is not cached.
- [ ] Registry errors: index JSON that is an array gives `upstream_error`, a registry 404 gives
      `upstream_error` (not `not_found`), and an entry with the wrong shape gives `upstream_error`.
- [ ] r-universe errors: a 500 gives `upstream_error` (no partial result), a record whose
      `Package` differs gives `upstream_error`, and a 404 gives `upstream: null`.
- [ ] `npm test` and `npm run typecheck` pass. `npm run build` succeeds.
- [ ] The PR body reports the cold-parse time and heap for the full 8 MB index, measured in Node
      with a throwaway script (not committed), and states that the in-Worker CPU is measured
      after deploy (#11). If it exceeds 10 ms, the PR comments on #13.

## Test plan

All tests run in Node with `fixtureFetch` and `createMemoryCache`. No network.

- `test/core/pkg/package-name.test.ts`: the `PackageNameSchema` accept/reject table (`edgeR`,
  `RTCGA.RPPA`, `BSgenome.Hsapiens.UCSC.hg38` accepted; `x`, `1abc`, `edgeR.`, `a'b`, `a/b`,
  `a b`, 101 chars rejected). `closeMatches`: `edgr` gives `['edge', 'edgeR']`, `biomart` gives
  `['biomaRt']`, `trackview` gives `['trackViewer']` (prefix), `zzzzzz` gives `[]`, the exact name
  is excluded, `limit` is honoured, and ties are ordered by code unit.
- `test/core/pkg/status.test.ts`:
  - `compareRVersions`: `1.49.3` vs `1.49.3` → 0, `1.3.4` vs `1.3.3` → 1, `1.10.0` vs `1.9.9`
    → 1, `1.2` vs `1.2.0` → -1, `1.2-3` vs `1.2.2` → 1, `abc` → null.
  - `historySql('bioc', 'edgeR')` equals the exact text above.
  - One test per scenario through `invokeCapability(pkgStatus, input, deps)` with
    `deps = { fetch: fixtureFetch(pkgRoutes), cache: createMemoryCache(now), now, env: {} }`.
  - The `behind_reasons` cap: `ClustIRR` lists five configs and then `and 8 more`.
- `test/upstreams/registry.test.ts`: the memo (a counting wrapper around `createMemoryCache`'s
  `get`, plus `fetch.calls`), concurrent calls sharing one load, a failed load not cached, a load that never settles (the owner and joiners get `upstream_timeout`; past the deadline the next caller loads afresh), memo isolation between two caches, array JSON, registry 404, an
  invalid entry, and `registryEntry` with `constructor` returning `undefined`.
- `test/upstreams/r-universe.test.ts`: found, 404 → `{ found: false, source }`, 500 →
  `upstream_error`, `Package` mismatch, and a schema mismatch.
- `test/transports/pkg.test.ts`: uses `makeTestApp({ routes: pkgRoutes, extraModules: [pkgModule] })`
  (the example module stays, which is harmless). Covers tools/list on `/mcp/pkg`, REST vs MCP
  equality, the REST 400 and 404 bodies, the MCP `not_found:` text, and `/api/v1/about` listing
  `registry`, `r-universe-bioc` and `r-universe-bioc-release` under `used_by: ['pkg']`.

## Risks

- **Worker CPU on a cold parse.** The Node measurement is 11–18 ms. Workers' free plan allows
  10 ms of CPU per request, so a cold isolate on the free plan may exceed it. The memo bounds this
  to one parse per isolate per 5 min (concurrent callers share it), but does not remove it. The fix belongs upstream: a
  per-package registry route (gap 1, #13). Reported in the PR, not solved here.
- **Memory.** The parsed index holds about 13 MB per universe per isolate (about 26 MB when both
  universes are warm), against 128 MB. That is acceptable. A slimmer memo (only the fields
  `RegistryEntrySchema` reads) is the next step if #7/#8 add more large indexes. The memo keeps
  only the parsed index and the response's metadata; the ~8 MB body is dropped after
  `JSON.parse` (#43). Keeping it measured about 8 MB more per universe in Node 26.
- **8 KB margin.** The worst case in the 2026-10-22 data (`SEMPLR`) is estimated at about 6.4 KB
  with long reasons and summary. A package with more configs or artifacts could approach the
  limit. The envelope guard fails loudly (`result_too_large`) rather than truncating.
- **r-universe 404 is ambiguous.** "Not found" and "failed to build outright" look the same to the
  adapter, because `fetchUpstream` discards 404 bodies. The summary wording ("no current build")
  is true for both. Distinguishing them would need a change to `http.ts`, which is out of scope.
- **"Behind" reasons are inferred.** The real decision lives in the registry's gate. The
  fallback reason says so and points to `POST /gate`. A future registry route exposing the last
  gate decision per package would replace the inference.
- **Fixture drift.** Live state changes daily. The scenario table gives selection criteria so a
  re-recording can substitute packages without changing the code.
- **Upstream-provided strings in output.** Commit messages, URLs and verdicts are passed through
  as data, never fetched or executed. The only URLs this server builds from them are matched
  against `GHA_RUN` first.
