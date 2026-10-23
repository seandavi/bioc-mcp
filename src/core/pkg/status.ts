import * as z from 'zod';
import { CapabilityError } from '../../errors';
import { sourceFor } from '../../upstreams/http';
import { getUniversePackage, type RUniversePackage } from '../../upstreams/r-universe';
import {
  getPropagationIndex,
  registryEntry,
  REGISTRY_BASE_URL,
  UNIVERSES,
  type RegistryEntry,
  type Universe,
} from '../../upstreams/registry';
import { defineCapability } from '../capability';
import { closeMatches, PackageNameSchema } from './package-name';

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
        'pkg_build_environment return the same page as job_url, in the short form …/runs/<job>',
    ),
});
type Job = z.infer<typeof JobSchema>;

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
type PkgStatusData = z.infer<typeof PkgStatusDataSchema>;
type Propagated = NonNullable<PkgStatusData['propagated']>;
type UpstreamState = NonNullable<PkgStatusData['upstream']>;

const GHA_RUN = /^https:\/\/github\.com\/r-universe\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/;
const VERSION_FORMAT = /^\d+([.-]\d+)*$/;
const FAILING_CHECK = /^(error|fail|failure)$/i;

function epochToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function firstLine(message: string | undefined): string {
  return (message ?? '').split('\n')[0]!.trim().slice(0, 120);
}

/** Compare R package versions component by component; null if either is not a version. */
export function compareRVersions(a: string, b: string): -1 | 0 | 1 | null {
  if (!VERSION_FORMAT.test(a) || !VERSION_FORMAT.test(b)) return null;
  const left = a.split(/[.-]/).map(Number);
  const right = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** The check-history query for /sql. `name` must be a valid package name, so it holds no quote; parse enforces it. */
export function historySql(universe: Universe, name: string): string {
  PackageNameSchema.parse(name);
  return [
    'SELECT obs_ts, config, r, "check", time, job',
    'FROM jobs',
    `WHERE universe = '${universe}' AND package = '${name}'`,
    'ORDER BY obs_ts DESC, config',
    'LIMIT 200',
  ].join('\n');
}

const ORIGIN_PASSED_GATE: Record<string, boolean> = { 'r-universe': true, 'bioc-build': true, bioconductor: false };

function shapePropagated(entry: RegistryEntry): Propagated {
  const origin = entry.origin ?? 'r-universe';
  const commit = entry.meta?.commit;
  return {
    version: entry.version,
    sha256: entry.sha256,
    propagated_at: entry.ts,
    origin,
    passed_gate: ORIGIN_PASSED_GATE[origin] ?? null,
    bioccheck: entry.bioccheck ?? null,
    archs: entry.archs ?? null,
    source_commit: commit ? { id: commit.id, time: epochToIso(commit.time) } : null,
    git_url: entry.meta?.git_url ?? null,
    artifacts: entry.artifacts.map((a) => ({
      os: a.os,
      r: a.r === '' ? null : a.r,
      arch: a.arch ?? null,
      distro: a.distro ?? null,
    })),
  };
}

function toJob(buildUrl: string, j: NonNullable<RUniversePackage['_jobs']>[number]): Job {
  return {
    config: j.config,
    r: j.r ?? null,
    check: j.check ?? null,
    job: String(j.job),
    url: GHA_RUN.test(buildUrl) ? `${buildUrl}/job/${j.job}` : null,
  };
}

function shapeUpstream(record: RUniversePackage): UpstreamState {
  const failure = record._failure;
  return {
    version: record.Version,
    status: record._status,
    commit: {
      id: record._commit.id,
      time: epochToIso(record._commit.time),
      message: firstLine(record._commit.message),
    },
    built_at: record._created ?? null,
    build_url: record._buildurl,
    bioccheck: record._bioccheck ?? null,
    jobs: (record._jobs ?? []).map((j) => toJob(record._buildurl, j)),
    newer_commit_failed: failure
      ? {
          version: failure.version,
          commit: {
            id: failure.commit.id,
            time: epochToIso(failure.commit.time),
            message: firstLine(failure.commit.message),
          },
          failed_at: failure.date,
          build_url: failure.buildurl,
          job: failure.job ? toJob(failure.buildurl, failure.job) : null,
        }
      : null,
  };
}

/** Jobs whose R CMD check failed; BiocCheck (config 'bioc-checks') is advisory and never counted. */
function failingChecks(jobs: Job[]): string[] {
  return jobs
    .filter((j) => j.config !== 'bioc-checks' && FAILING_CHECK.test(j.check ?? ''))
    .map((j) => `${j.config} (${j.check})`);
}

function listWithMore(items: string[], shown: number): string {
  const rest = items.length - shown;
  return items.slice(0, shown).join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

function behindReasons(
  universe: Universe,
  propagated: Propagated | null,
  upstream: UpstreamState | null,
  behind: boolean | null,
): string[] {
  if (upstream === null || !(behind === true || propagated === null)) return [];
  const reasons: string[] = [];
  if (propagated === null) {
    reasons.push(`No entry in the ${universe} propagation index.`);
  } else if (propagated.origin === 'bioconductor') {
    reasons.push(
      "The propagated entry was seeded from Bioconductor's release build and never passed the gate; " +
        'it stays at its seeded version until a newer version passes the gate.',
    );
  }
  const failing = failingChecks(upstream.jobs);
  if (upstream.status !== 'success') {
    reasons.push(`r-universe's build of ${upstream.version} has status "${upstream.status}".`);
  }
  if (failing.length > 0) reasons.push(`R CMD check fails on ${listWithMore(failing, 5)}.`);
  if (upstream.status === 'success' && failing.length === 0) {
    reasons.push(
      'r-universe shows no failing build or check for this version, so the gate rejected it on another rule ' +
        '(platform families, dependencies, manifest) or has not evaluated it yet; ' +
        `POST ${new URL('gate', REGISTRY_BASE_URL).href} ` +
        '(https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#post-gate) gives the rule-by-rule decision.',
    );
  }
  return reasons;
}

function originLabel(origin: string): string {
  switch (origin) {
    case 'r-universe':
      return 'passed the gate via r-universe';
    case 'bioc-build':
      return 'passed the gate via bioc-build';
    case 'bioconductor':
      return 'seeded from Bioconductor, never gated';
    default:
      return `origin ${origin}`;
  }
}

function summarize(name: string, data: PkgStatusData): string {
  const { universe, propagated, upstream, behind } = data;
  const sentences: string[] = [];
  sentences.push(
    propagated
      ? `${name} (${universe}) is propagated at ${propagated.version} (${originLabel(propagated.origin)}, ${propagated.propagated_at.slice(0, 10)}).`
      : `${name} is not in the ${universe} propagation index.`,
  );
  if (upstream) {
    const failing = failingChecks(upstream.jobs);
    sentences.push(
      `r-universe builds ${upstream.version}: status ${upstream.status}` +
        (failing.length > 0 ? `, failing ${listWithMore(failing, 3)}` : '') +
        '.',
    );
  } else {
    sentences.push(`r-universe has no current build of ${name} in ${universe}.`);
  }
  if (behind === true && upstream && propagated) {
    sentences.push(`Upstream ${upstream.version} is newer than propagated ${propagated.version}.`);
    if (upstream.status === 'success' && failingChecks(upstream.jobs).length === 0) {
      sentences.push(
        `r-universe shows no failure for ${upstream.version}, so the gate's reason is not visible here; see behind_reasons.`,
      );
    }
  }
  const failed = upstream?.newer_commit_failed;
  if (failed) {
    sentences.push(
      `A newer commit (${failed.version}) failed` +
        (failed.job ? ` on ${failed.job.config} (${failed.job.check ?? 'no verdict'})` : '') +
        '.',
    );
  }
  return sentences.join(' ');
}

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
    'Package names are case-sensitive. For why a job failed, pass its job id to pkg_check_output; for what it ' +
    'ran with, to pkg_build_environment. For download counts use pkg_downloads; for release and devel ' +
    'versions use pkg_release_info.',
  input: z.object({
    package: PackageNameSchema,
    universe: z
      .enum(UNIVERSES)
      .default('bioc')
      .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
  }),
  data: PkgStatusDataSchema,
  async handler({ package: name, universe }, deps) {
    const [index, universePackage] = await Promise.all([
      getPropagationIndex(deps, universe),
      getUniversePackage(deps, universe, name),
    ]);
    const entry = registryEntry(index, name);
    if (!entry && !universePackage.found) {
      const matches = closeMatches(name, Object.keys(index.packages));
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
    }

    const propagated = entry ? shapePropagated(entry) : null;
    const upstream = universePackage.found ? shapeUpstream(universePackage.record) : null;
    const cmp = propagated && upstream ? compareRVersions(upstream.version, propagated.version) : null;
    const behind = cmp === null ? null : cmp === 1;
    const data: PkgStatusData = {
      package: name,
      universe,
      propagated,
      upstream,
      behind,
      behind_reasons: behindReasons(universe, propagated, upstream, behind),
      history_sql: { query: historySql(universe, name), console_url: new URL('sql', REGISTRY_BASE_URL).href },
    };
    return {
      data,
      summary: summarize(name, data),
      sources: [
        sourceFor(index.response),
        universePackage.found ? sourceFor(universePackage.response) : universePackage.source,
      ],
    };
  },
});
