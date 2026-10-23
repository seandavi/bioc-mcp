import * as z from 'zod';
import type { PropagationIndex } from '../../upstreams/registry';

export const HARD_DEPENDENCY_FIELDS = ['Depends', 'Imports', 'LinkingTo'] as const;
export type HardDependencyField = (typeof HARD_DEPENDENCY_FIELDS)[number];

/** R itself and the base-priority packages of R 4.6; never on CRAN, always installed. */
export const BASE_R_PACKAGES: ReadonlySet<string> = new Set([
  'R',
  'base',
  'compiler',
  'datasets',
  'graphics',
  'grDevices',
  'grid',
  'methods',
  'parallel',
  'splines',
  'stats',
  'stats4',
  'tcltk',
  'tools',
  'utils',
]);

/** Package names in one DESCRIPTION dependency field, in order, de-duplicated. */
export function parseDependencyField(value: string): string[] {
  const names = new Set<string>();
  for (const part of value.split(',')) {
    const name = /^[A-Za-z][A-Za-z0-9.]*/.exec(part.trim())?.[0];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

export interface DependencyGraph {
  /** Index entry → its hard dependencies (field order, then DESCRIPTION order), self-references dropped. */
  dependencies: ReadonlyMap<string, readonly { name: string; field: HardDependencyField }[]>;
  /** Any dependency name (in the index or not) → index entries naming it → the fields that name it. */
  dependents: ReadonlyMap<string, ReadonlyMap<string, readonly HardDependencyField[]>>;
  /** Index entries whose dependencies are unknown (no usable `desc`), sorted by code unit. */
  depsUnknown: readonly string[];
}

const EntryDepsSchema = z.object({
  desc: z.object({
    Depends: z.string().optional(),
    Imports: z.string().optional(),
    LinkingTo: z.string().optional(),
  }),
});

const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// getPropagationIndex returns the same `packages` object for every call within one memo period,
// so each index version is parsed once per isolate. registryEntry() is not used: it throws on any
// unexpected entry shape, and one bad entry must not fail the call.
const graphs = new WeakMap<Record<string, unknown>, DependencyGraph>();

/** Built once per parsed index (memoized on index.packages). */
export function dependencyGraph(index: PropagationIndex): DependencyGraph {
  const memo = graphs.get(index.packages);
  if (memo) return memo;

  const dependencies = new Map<string, { name: string; field: HardDependencyField }[]>();
  const dependents = new Map<string, Map<string, HardDependencyField[]>>();
  const depsUnknown: string[] = [];
  for (const name of Object.keys(index.packages)) {
    const parsed = EntryDepsSchema.safeParse(index.packages[name]);
    if (!parsed.success) {
      depsUnknown.push(name);
      continue;
    }
    const list: { name: string; field: HardDependencyField }[] = [];
    for (const field of HARD_DEPENDENCY_FIELDS) {
      const value = parsed.data.desc[field];
      if (value === undefined) continue;
      for (const dependency of parseDependencyField(value)) {
        if (dependency === name) continue;
        list.push({ name: dependency, field });
        let byEntry = dependents.get(dependency);
        if (!byEntry) {
          byEntry = new Map();
          dependents.set(dependency, byEntry);
        }
        const fields = byEntry.get(name);
        if (fields) fields.push(field);
        else byEntry.set(name, [field]);
      }
    }
    dependencies.set(name, list);
  }
  const graph: DependencyGraph = { dependencies, dependents, depsUnknown: depsUnknown.sort(codeUnitOrder) };
  graphs.set(index.packages, graph);
  return graph;
}

export interface ReverseDependency {
  name: string;
  depth: number;
}

/**
 * Index entries that depend on `name`, at their shortest depth (1 = names it directly), up to
 * maxDepth levels (undefined = all). Sorted by depth, then name in code-unit order. `name` itself
 * is never included, even through a cycle.
 */
export function reverseDependencies(graph: DependencyGraph, name: string, maxDepth?: number): ReverseDependency[] {
  const seen = new Set<string>([name]);
  const found: ReverseDependency[] = [];
  let level = [name];
  for (let depth = 1; (maxDepth === undefined || depth <= maxDepth) && level.length > 0; depth++) {
    const next: string[] = [];
    for (const current of level) {
      for (const dependent of graph.dependents.get(current)?.keys() ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        next.push(dependent);
      }
    }
    next.sort(codeUnitOrder);
    for (const dependent of next) found.push({ name: dependent, depth });
    level = next;
  }
  return found;
}
