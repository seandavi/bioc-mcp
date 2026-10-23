import * as z from 'zod';
import { getBiocDataPackagesFile } from '../../upstreams/bioconductor';
import { getCranPackagesFile } from '../../upstreams/cran';
import { sourceFor } from '../../upstreams/http';
import { getPropagationIndex, UNIVERSES } from '../../upstreams/registry';
import { defineCapability } from '../capability';
import {
  BASE_R_PACKAGES,
  dependencyGraph,
  HARD_DEPENDENCY_FIELDS,
  type HardDependencyField,
} from './dependency-graph';
import { CursorSchema, packagesPhrase, parseCursor, takePage } from './paging';

const CHECKED_SOURCES = [
  'registry_index',
  'base_r',
  'cran',
  'bioc_data_annotation',
  'bioc_data_experiment',
] as const;

export const PkgMissingDepsDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  packages_checked: z.number().int().describe('Index packages whose dependencies are known and were checked'),
  checked_against: z
    .array(
      z.object({
        source: z.enum(CHECKED_SOURCES),
        packages: z.number().int().describe('Package names it supplied'),
      }),
    )
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
        origin: z
          .string()
          .describe("Index entry origin: 'r-universe', 'bioc-build' or 'bioconductor' (seeded)"),
        missing: z
          .array(z.object({ name: z.string(), field: z.enum(HARD_DEPENDENCY_FIELDS) }))
          .describe('Missing hard dependencies, at most 10, each once, under the first field that names it'),
        missing_count: z.number().int(),
      }),
    )
    .describe('This page of affected packages, by name (code-unit order)'),
  offset: z.number().int().describe("0-based position of this page's first package in the full list"),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as cursor, with the same universe, for the next page; null on the last page'),
  deps_unknown: z
    .array(z.string())
    .describe('Index packages with no recorded DESCRIPTION fields (first 20, sorted): not checked'),
  deps_unknown_count: z.number().int(),
  not_checked: z.array(z.string()).describe('What this check does not cover'),
});
type PkgMissingDepsData = z.infer<typeof PkgMissingDepsDataSchema>;

export const MISSING_DEPS_NOT_CHECKED = [
  'Version requirements: a dependency counts as present at any version (limma (>= 3.60) is satisfied by any limma).',
  'Suggests, Enhances and SystemRequirements.',
  "CRAN is matched by name against its current src/contrib/PACKAGES (best-effort): not platform binaries, OS_type, or whether CRAN's package of that name is the one meant.",
  "bioconductor.org's software, workflows and books repositories: a dependency found only there counts as missing, because it cannot be installed from the registry.",
  "Dependencies of dependencies: each package's own fields are checked. Use pkg_revdeps on a missing dependency for everything downstream of it.",
  'Index packages without recorded DESCRIPTION fields (deps_unknown).',
] as const;

const MISSING_DEPS_PAGE_BYTES = 3000;
const MISSING_LISTED_PER_PACKAGE = 10;
const DEPENDENCIES_LISTED = 20;
const DEPS_UNKNOWN_LISTED = 20;
const TOP_DEPENDENCIES_IN_SUMMARY = 5;

type AffectedPackage = PkgMissingDepsData['packages'][number];

const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function summarize(data: PkgMissingDepsData): string {
  const { universe, packages_checked: checked, counts, offset, next_cursor } = data;
  const shown = data.packages.length;
  let summary =
    counts.packages > 0
      ? `${counts.packages} of ${checked} packages in the ${universe} propagation index have a hard dependency (Depends, Imports or LinkingTo) that is in none of: the index, base R, CRAN, Bioconductor annotation or experiment data. Most needed: ${data.dependencies
          .slice(0, TOP_DEPENDENCIES_IN_SUMMARY)
          .map((d) => `${d.name} (${d.needed_by})`)
          .join(', ')}.`
      : `None of the ${checked} packages in the ${universe} propagation index has a hard dependency (Depends, Imports or LinkingTo) missing from the index, base R, CRAN and Bioconductor annotation and experiment data.`;
  summary += ' CRAN is matched by name only (best-effort); see not_checked.';
  if (next_cursor !== null) {
    summary += ` Listed: ${offset + 1}–${offset + shown} of ${counts.packages}; call again with cursor "${next_cursor}" for the rest.`;
  } else if (offset > 0) {
    summary += ` Listed: ${offset + 1}–${counts.packages} of ${counts.packages}.`;
  }
  if (data.deps_unknown_count > 0) {
    summary += ` Not counted: ${packagesPhrase(data.deps_unknown_count)} in the index without recorded dependencies (deps_unknown).`;
  }
  return summary;
}

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
    "one missing dependency use pkg_revdeps on it; for one package's build state use pkg_status.",
  input: z.object({
    universe: z
      .enum(UNIVERSES)
      .default('bioc')
      .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
    cursor: CursorSchema,
  }),
  data: PkgMissingDepsDataSchema,
  async handler({ universe, cursor }, deps) {
    const [index, cran, annotation, experiment] = await Promise.all([
      getPropagationIndex(deps, universe),
      getCranPackagesFile(deps),
      getBiocDataPackagesFile(deps, universe, 'data/annotation'),
      getBiocDataPackagesFile(deps, universe, 'data/experiment'),
    ]);
    const graph = dependencyGraph(index);
    const found = (name: string) =>
      Object.hasOwn(index.packages, name) ||
      BASE_R_PACKAGES.has(name) ||
      cran.versions.has(name) ||
      annotation.versions.has(name) ||
      experiment.versions.has(name);

    const affected: AffectedPackage[] = [];
    const neededBy = new Map<string, number>();
    for (const name of [...graph.dependencies.keys()].sort(codeUnitOrder)) {
      const missing = new Map<string, HardDependencyField>();
      for (const dependency of graph.dependencies.get(name)!) {
        if (!found(dependency.name) && !missing.has(dependency.name)) missing.set(dependency.name, dependency.field);
      }
      if (missing.size === 0) continue;
      for (const missingName of missing.keys()) neededBy.set(missingName, (neededBy.get(missingName) ?? 0) + 1);
      const entry = index.packages[name] as { version?: unknown; origin?: unknown };
      affected.push({
        package: name,
        version: typeof entry.version === 'string' ? entry.version : null,
        origin: typeof entry.origin === 'string' ? entry.origin : 'r-universe',
        missing: [...missing]
          .slice(0, MISSING_LISTED_PER_PACKAGE)
          .map(([missingName, field]) => ({ name: missingName, field })),
        missing_count: missing.size,
      });
    }

    const offset = parseCursor(cursor, affected.length);
    const { page, nextCursor } = takePage(affected, offset, MISSING_DEPS_PAGE_BYTES);
    const dependencies = [...neededBy]
      .map(([name, needed_by]) => ({ name, needed_by }))
      .sort((a, b) => b.needed_by - a.needed_by || codeUnitOrder(a.name, b.name));

    const data: PkgMissingDepsData = {
      universe,
      packages_checked: graph.dependencies.size,
      checked_against: [
        { source: 'registry_index', packages: Object.keys(index.packages).length },
        { source: 'base_r', packages: BASE_R_PACKAGES.size },
        { source: 'cran', packages: cran.versions.size },
        { source: 'bioc_data_annotation', packages: annotation.versions.size },
        { source: 'bioc_data_experiment', packages: experiment.versions.size },
      ],
      counts: { packages: affected.length, dependencies: dependencies.length },
      dependencies: dependencies.slice(0, DEPENDENCIES_LISTED),
      packages: page,
      offset,
      next_cursor: nextCursor,
      deps_unknown: graph.depsUnknown.slice(0, DEPS_UNKNOWN_LISTED),
      deps_unknown_count: graph.depsUnknown.length,
      not_checked: [...MISSING_DEPS_NOT_CHECKED],
    };
    return {
      data,
      summary: summarize(data),
      sources: [
        sourceFor(index.response),
        sourceFor(cran.response),
        sourceFor(annotation.response),
        sourceFor(experiment.response),
      ],
    };
  },
});
