import * as z from 'zod';
import { CapabilityError } from '../../errors';
import {
  BBS_BUILDS,
  BBS_REPORTS,
  bbsPackagePath,
  bbsStageUrl,
  getBbsBuildStatus,
  getBbsNodeInfo,
  getBbsPackageInfo,
  getBbsPropagationStatus,
  type BbsBuild,
  type BbsBuildStatus,
  type BbsReport,
} from '../../upstreams/bbs';
import { BIOCONDUCTOR_BASE_URL } from '../../upstreams/bioconductor';
import { sourceFor } from '../../upstreams/http';
import { getPropagationIndex, registryEntry, UNIVERSES } from '../../upstreams/registry';
import { defineCapability } from '../capability';
import type { Deps } from '../deps';
import { closeMatches, PackageNameSchema } from './package-name';
import { compareRVersions, ORIGIN_PASSED_GATE, originLabel } from './status';

export const BIOCBUILDDB_BUILD_SUMMARY_URL =
  'https://bioc-builddb-mirror.s3.amazonaws.com/parquet/build_summary.parquet';

export const PLATFORM_FAMILIES = ['linux', 'mac', 'win'] as const; // the registry's archs vocabulary
export type PlatformFamily = (typeof PLATFORM_FAMILIES)[number];

type NodeVerdict = 'ok' | 'failed' | 'incomplete';

/** /^Linux/ → 'linux', /^(macOS|Mac OS X)/ → 'mac', /^Windows/ → 'win', anything else (or null) → null. */
export function osFamily(os: string | null): PlatformFamily | null {
  if (os === null) return null;
  if (/^Linux/.test(os)) return 'linux';
  if (/^(macOS|Mac OS X)/.test(os)) return 'mac';
  if (/^Windows/.test(os)) return 'win';
  return null;
}

/** 'failed' if any stage is ERROR or TIMEOUT; else 'ok' if every stage is OK or WARNINGS; else 'incomplete'. */
export function nodeVerdict(stages: readonly { status: string }[]): NodeVerdict {
  if (stages.some((s) => s.status === 'ERROR' || s.status === 'TIMEOUT')) return 'failed';
  return stages.every((s) => s.status === 'OK' || s.status === 'WARNINGS') ? 'ok' : 'incomplete';
}

/** null for no nodes; 'failed' if any node failed; else 'incomplete' if any is; else 'ok'. */
export function familyVerdict(verdicts: readonly NodeVerdict[]): NodeVerdict | null {
  if (verdicts.length === 0) return null;
  if (verdicts.includes('failed')) return 'failed';
  return verdicts.includes('incomplete') ? 'incomplete' : 'ok';
}

/** The history query; `name` must be a valid package name (PackageNameSchema.parse), so it holds no quote. */
export function legacyHistorySql(name: string): string {
  PackageNameSchema.parse(name);
  return [
    'SELECT startedat, node, stage, version, status',
    `FROM '${BIOCBUILDDB_BUILD_SUMMARY_URL}'`,
    `WHERE package = '${name}'`,
    'ORDER BY startedat DESC, node, stage',
    'LIMIT 200',
  ].join('\n');
}

const NodeVerdictSchema = z.enum(['ok', 'failed', 'incomplete']);
const FamilySchema = z.enum(PLATFORM_FAMILIES);

const BbsStageSchema = z.object({
  stage: z
    .string()
    .describe(
      "'install' (R CMD INSTALL), 'buildsrc' (R CMD build), 'checksrc' (R CMD check) or 'buildbin' (binary build, Mac and Windows nodes)",
    ),
  status: z
    .string()
    .describe(
      'BBS verdict as the report gives it: OK, WARNINGS, ERROR, TIMEOUT, skipped (an earlier stage failed) or NA (no result)',
    ),
  url: z.string().nullable().describe("The stage's log page on the BBS report; null when status is OK or skipped"),
});

const BbsNodeSchema = z.object({
  node: z.string().describe("BBS build machine, e.g. 'nebbiolo2'"),
  os: z
    .string()
    .nullable()
    .describe("Operating system as the report names it; null if the machine's NodeInfo page did not say"),
  arch: z.string().nullable(),
  family: FamilySchema.nullable().describe(
    "Platform family, comparable with the registry's archs; null if the OS is unknown",
  ),
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
      report: z
        .enum(['devel', 'release'])
        .describe("The BBS report read: 'devel' for universe bioc, 'release' for bioc-release"),
      build: z
        .enum(BBS_BUILDS)
        .describe('The BBS build that lists the package (software, experiment data, workflows, books)'),
      version: z.string().nullable().describe("Version BBS built; null if the report's info.dcf is missing"),
      commit: z
        .object({
          id: z.string().describe('Short git SHA BBS built'),
          time: z.string().nullable().describe('Commit time, ISO 8601 with offset'),
          branch: z.string().nullable().describe("e.g. 'devel', 'RELEASE_3_23'"),
        })
        .nullable(),
      report_url: z.string().describe("The package's page on the BBS report"),
      as_of: z
        .string()
        .describe("When this BBS report was published (BUILD_STATUS_DB.txt's Last-Modified), ISO 8601"),
      nodes: z.array(BbsNodeSchema).describe('One per build machine, in report order'),
      propagation: z
        .array(
          z.object({
            target: z.string().describe("'source' or a binary target such as 'mac.binary.big-sur-x86_64'"),
            status: z
              .string()
              .describe('YES (propagated by this report), NO (blocked) or UNNEEDED (same version already published)'),
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
          'Worst verdict of those machines (failed over incomplete over ok); null when BBS has no machine of this family',
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
    query: z
      .string()
      .describe(
        "DuckDB SQL over BiocBuildDB's archive of BBS results (devel and release, all builds, since 2021-10; " +
          "no runs from 2026-06-13 to 2026-10-22): this package's stage history. version tells devel from release",
      ),
    parquet_url: z
      .string()
      .describe('The public parquet file the query reads over HTTPS; run it in DuckDB. This server does not run it'),
  }),
});
type PkgLegacyStatusData = z.infer<typeof PkgLegacyStatusDataSchema>;
type Legacy = NonNullable<PkgLegacyStatusData['legacy']>;
type Registry = NonNullable<PkgLegacyStatusData['registry']>;
type Comparison = PkgLegacyStatusData['comparison'][number];

/** The first build of the report whose BUILD_STATUS_DB lists `name`, reading the builds one at a time. */
async function findBbsBuild(
  deps: Deps,
  report: BbsReport,
  name: string,
): Promise<{ build?: BbsBuild; status?: BbsBuildStatus; searched: BbsBuildStatus[] }> {
  const searched: BbsBuildStatus[] = [];
  for (const build of BBS_BUILDS) {
    const status = await getBbsBuildStatus(deps, report, build);
    searched.push(status);
    if (status.packages.has(name)) return { build, status, searched };
  }
  return { searched };
}

/** The stages that explain a node's verdict, e.g. ' (checksrc WARNINGS)'; '' when none qualifies. */
function listedStages(node: Legacy['nodes'][number]): string {
  const explains = (status: string) => {
    if (node.verdict === 'ok') return status === 'WARNINGS';
    if (node.verdict === 'failed') return status === 'ERROR' || status === 'TIMEOUT';
    return status !== 'OK' && status !== 'WARNINGS';
  };
  const stages = node.stages.filter((s) => explains(s.status));
  return stages.length > 0 ? ` (${stages.map((s) => `${s.stage} ${s.status}`).join(', ')})` : '';
}

function summarize(
  name: string,
  universe: PkgLegacyStatusData['universe'],
  report: BbsReport,
  data: PkgLegacyStatusData,
): string {
  const { legacy, registry, comparison } = data;
  const sentences: string[] = [];
  if (legacy) {
    const nodes = legacy.nodes
      .map((n) => `${n.node}${n.family ? ` (${n.family})` : ''} ${n.verdict}${listedStages(n)}`)
      .join('; ');
    sentences.push(
      `${name} ${legacy.version ?? '(version unknown)'} in the legacy build system's ${report} ${legacy.build} report ` +
        `(${legacy.as_of.slice(0, 10)}): ${nodes}.`,
    );
    sentences.push(
      legacy.propagation.length > 0
        ? `BBS propagation: ${legacy.propagation
            .map((p) => `${p.target} ${p.status}${p.reason ? ` (${p.reason})` : ''}`)
            .join('; ')}.`
        : 'BBS recorded no propagation for it.',
    );
  } else {
    sentences.push(
      `${name} is in none of the legacy build system's ${report} reports (bioc, data-experiment, workflows, books).`,
    );
  }
  if (registry) {
    const archs = registry.archs && registry.archs.length > 0 ? `; families ${registry.archs.join(', ')}` : '';
    sentences.push(`The registry propagated ${registry.version} (${originLabel(registry.origin)}${archs}).`);
  } else {
    sentences.push(`${name} is not in the ${universe} propagation index.`);
  }
  const disagreements = comparison.filter(
    (c) => (c.bbs_verdict === 'ok' && c.registry_passed === false) || (c.bbs_verdict === 'failed' && c.registry_passed === true),
  );
  if (disagreements.length > 0) {
    const items = disagreements
      .map((c) => `${c.family} (BBS ${c.bbs_verdict}, registry ${c.registry_passed ? 'passed' : 'not passed'})`)
      .join(', ');
    sentences.push(`BBS and the registry disagree on ${items}.`);
  }
  if (data.same_version === false && legacy?.version && registry) {
    sentences.push(`BBS built ${legacy.version}; the registry propagated ${registry.version}.`);
  }
  return sentences.join(' ');
}

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
  async handler({ package: name, universe }, deps) {
    const report = BBS_REPORTS[universe];
    const [index, found] = await Promise.all([getPropagationIndex(deps, universe), findBbsBuild(deps, report, name)]);
    const entry = registryEntry(index, name);

    if (found.build === undefined && !entry) {
      const candidates = new Set<string>(Object.keys(index.packages));
      for (const searched of found.searched) for (const known of searched.packages.keys()) candidates.add(known);
      const matches = closeMatches(name, candidates);
      const otherUniverse =
        universe === 'bioc'
          ? " To check release, call again with universe 'bioc-release'."
          : " To check devel, call again with universe 'bioc'.";
      throw new CapabilityError(
        'not_found',
        `No ${report} BBS report (bioc, data-experiment, workflows, books) and no ${universe} propagation entry lists "${name}". ` +
          'Package names are case-sensitive.' +
          (matches.length > 0 ? ` Did you mean: ${matches.join(', ')}?` : '') +
          otherUniverse,
      );
    }

    let legacy: Legacy | null = null;
    const sources = [];
    if (found.build !== undefined && found.status !== undefined) {
      const { build, status } = found;
      const lines = status.packages.get(name)!;
      const nodeNames = [...new Set(lines.map((l) => l.node))];
      const [propagationStatus, info, nodeInfos] = await Promise.all([
        getBbsPropagationStatus(deps, report, build),
        getBbsPackageInfo(deps, report, build, name),
        Promise.all(nodeNames.map((node) => getBbsNodeInfo(deps, report, build, node))),
      ]);
      legacy = {
        report,
        build,
        version: info?.version ?? null,
        commit: info?.commit ?? null,
        report_url: new URL(bbsPackagePath(report, build, name), BIOCONDUCTOR_BASE_URL).href,
        as_of: sourceFor(status.response).as_of,
        nodes: nodeNames.map((node, i) => {
          const spec = nodeInfos[i]?.spec;
          const stages = lines
            .filter((l) => l.node === node)
            .map((l) => ({
              stage: l.stage,
              status: l.status,
              url: l.status === 'OK' || l.status === 'skipped' ? null : bbsStageUrl(report, build, name, node, l.stage),
            }));
          return {
            node,
            os: spec?.os ?? null,
            arch: spec?.arch ?? null,
            family: osFamily(spec?.os ?? null),
            verdict: nodeVerdict(stages),
            stages,
          };
        }),
        propagation: (propagationStatus.packages.get(name) ?? []).map((p) => ({
          target: p.target,
          status: p.status,
          reason: p.reason,
        })),
      };
      sources.push(status.response, propagationStatus.response);
      if (info) sources.push(info.response);
      for (const nodeInfo of nodeInfos) if (nodeInfo) sources.push(nodeInfo.response);
    } else {
      for (const searched of found.searched) sources.push(searched.response);
    }
    sources.push(index.response);

    let registry: Registry | null = null;
    if (entry) {
      const origin = entry.origin ?? 'r-universe';
      registry = {
        version: entry.version,
        origin,
        passed_gate: ORIGIN_PASSED_GATE[origin] ?? null,
        archs: entry.archs ?? null,
        propagated_at: entry.ts,
      };
    }

    const comparison: Comparison[] = [];
    for (const family of PLATFORM_FAMILIES) {
      const nodes = legacy?.nodes.filter((n) => n.family === family) ?? [];
      const registryPassed =
        registry?.archs && registry.passed_gate !== false ? registry.archs.includes(family) : null;
      if (nodes.length === 0 && registryPassed !== true) continue;
      comparison.push({
        family,
        bbs_nodes: nodes.map((n) => n.node),
        bbs_verdict: familyVerdict(nodes.map((n) => n.verdict)),
        registry_passed: registryPassed,
      });
    }

    const cmp = legacy?.version && registry ? compareRVersions(legacy.version, registry.version) : null;
    const data: PkgLegacyStatusData = {
      package: name,
      universe,
      legacy,
      registry,
      comparison,
      same_version: cmp === null ? null : cmp === 0,
      history_sql: { query: legacyHistorySql(name), parquet_url: BIOCBUILDDB_BUILD_SUMMARY_URL },
    };
    return { data, summary: summarize(name, universe, report, data), sources: sources.map((s) => sourceFor(s)) };
  },
});
