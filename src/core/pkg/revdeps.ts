import * as z from 'zod';
import { CapabilityError } from '../../errors';
import { sourceFor } from '../../upstreams/http';
import { getPropagationIndex, UNIVERSES } from '../../upstreams/registry';
import { defineCapability } from '../capability';
import { dependencyGraph, reverseDependencies, type HardDependencyField } from './dependency-graph';
import { CursorSchema, packagesPhrase, parseCursor, takePage } from './paging';
import { closeMatches, PackageNameSchema } from './package-name';

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
    .describe(
      'Whether the package itself is in the propagation index; a name outside it can still have dependents waiting on it',
    ),
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
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as cursor, with the same package, universe and depth, for the next page; null on the last page'),
  deps_unknown: z
    .array(z.string())
    .describe(
      'Index packages with no recorded DESCRIPTION fields (first 20, sorted): their dependencies are unknown, so they are never counted',
    ),
  deps_unknown_count: z.number().int(),
});
type PkgRevdepsData = z.infer<typeof PkgRevdepsDataSchema>;

const REVDEPS_PAGE_BYTES = 4000;
const DEPS_UNKNOWN_LISTED = 20;

function countField(
  direct: ReadonlyMap<string, readonly HardDependencyField[]> | undefined,
  field: HardDependencyField,
): number {
  let count = 0;
  for (const fields of direct?.values() ?? []) if (fields.includes(field)) count++;
  return count;
}

function summarize(data: PkgRevdepsData): string {
  const { package: name, universe, counts, max_depth, offset, next_cursor } = data;
  const total = counts.total;
  const shown = data.dependents.reduce((sum, group) => sum + group.names.length, 0);
  let summary =
    total > 0
      ? `${name} (${universe}): ${packagesPhrase(total)} in the propagation index ${total === 1 ? 'depends' : 'depend'} on it through Depends, Imports or LinkingTo (${counts.direct} directly${max_depth === null ? '' : `; levels searched: ${max_depth}`}).`
      : `${name} (${universe}): no package in the propagation index depends on it through Depends, Imports or LinkingTo.`;
  if (!data.in_index) summary += ` ${name} itself is not in the index.`;
  if (next_cursor !== null) {
    summary += ` Listed: ${offset + 1}–${offset + shown} of ${total}; call again with cursor "${next_cursor}" for the rest.`;
  } else if (offset > 0) {
    summary += ` Listed: ${offset + 1}–${total} of ${total}.`;
  }
  if (data.deps_unknown_count > 0) {
    summary += ` Not counted: ${packagesPhrase(data.deps_unknown_count)} in the index without recorded dependencies (deps_unknown).`;
  }
  return summary;
}

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
  data: PkgRevdepsDataSchema,
  async handler({ package: name, universe, depth, cursor }, deps) {
    const index = await getPropagationIndex(deps, universe);
    const graph = dependencyGraph(index);
    const inIndex = Object.hasOwn(index.packages, name);
    const direct = graph.dependents.get(name);
    if (!inIndex && direct === undefined) {
      const matches = closeMatches(name, Object.keys(index.packages));
      const otherUniverse =
        universe === 'bioc'
          ? " To check release, call again with universe 'bioc-release'."
          : " To check devel, call again with universe 'bioc'.";
      throw new CapabilityError(
        'not_found',
        `No ${universe} propagation entry named "${name}", and no package in the ${universe} index depends on it. Package names are case-sensitive.` +
          (matches.length > 0 ? ` Did you mean: ${matches.join(', ')}?` : '') +
          otherUniverse,
      );
    }

    const all = reverseDependencies(graph, name, depth);
    const offset = parseCursor(cursor, all.length);
    const { page, nextCursor } = takePage(
      all.map((d) => d.name),
      offset,
      REVDEPS_PAGE_BYTES,
    );

    const byDepth: { depth: number; count: number }[] = [];
    for (const { depth: level } of all) {
      const last = byDepth.at(-1);
      if (last?.depth === level) last.count++;
      else byDepth.push({ depth: level, count: 1 });
    }
    const groups: { depth: number; names: string[] }[] = [];
    page.forEach((pageName, i) => {
      const level = all[offset + i]!.depth;
      const last = groups.at(-1);
      if (last?.depth === level) last.names.push(pageName);
      else groups.push({ depth: level, names: [pageName] });
    });

    const data: PkgRevdepsData = {
      package: name,
      universe,
      in_index: inIndex,
      max_depth: depth ?? null,
      counts: {
        direct: direct?.size ?? 0,
        direct_by_field: {
          depends: countField(direct, 'Depends'),
          imports: countField(direct, 'Imports'),
          linking_to: countField(direct, 'LinkingTo'),
        },
        total: all.length,
        by_depth: byDepth,
      },
      dependents: groups,
      offset,
      next_cursor: nextCursor,
      deps_unknown: graph.depsUnknown.slice(0, DEPS_UNKNOWN_LISTED),
      deps_unknown_count: graph.depsUnknown.length,
    };
    return { data, summary: summarize(data), sources: [sourceFor(index.response)] };
  },
});
