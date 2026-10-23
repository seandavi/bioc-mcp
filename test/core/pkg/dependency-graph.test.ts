import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  BASE_R_PACKAGES,
  dependencyGraph,
  parseDependencyField,
  reverseDependencies,
} from '../../../src/core/pkg/dependency-graph';
import type { PropagationIndex } from '../../../src/upstreams/registry';

const fixtureIndex = (): PropagationIndex =>
  indexOf(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'registry', 'prop', 'bioc', 'index-deps.json'), 'utf8')));

function indexOf(packages: Record<string, unknown>): PropagationIndex {
  return {
    packages,
    response: { url: 'https://example.test/index.json', contentType: null, lastModified: null, fetchedAt: '2026-10-22T12:00:00.000Z', fromCache: false },
  };
}

const entry = (desc: Record<string, unknown>) => ({ version: '1.0.0', desc });

describe('parseDependencyField', () => {
  test.each([
    ['R (>= 3.5.0)', ['R']],
    ['Biobase, BiocGenerics (>= 0.59.5),\n    cytolib', ['Biobase', 'BiocGenerics', 'cytolib']],
    ['jsonlite, methods, jsonlite', ['jsonlite', 'methods']],
    ['', []],
    [', ,x(>=1)', ['x']],
  ])('%j', (value, names) => {
    expect(parseDependencyField(value)).toEqual(names);
  });
});

test('BASE_R_PACKAGES has the 15 base names', () => {
  expect(BASE_R_PACKAGES.size).toBe(15);
});

describe('dependencyGraph on the fixture', () => {
  const index = fixtureIndex();
  const graph = dependencyGraph(index);

  test('depsUnknown is easier', () => {
    expect(graph.depsUnknown).toEqual(['easier']);
    expect(graph.dependencies.has('easier')).toBe(false);
  });

  test('dependents records the fields that name a package', () => {
    expect(graph.dependents.get('flowWorkspace')!.get('CytoML')).toEqual(['Imports', 'LinkingTo']);
  });

  test('dependencies of RegEnrich include BiocSet in Depends', () => {
    expect(graph.dependencies.get('RegEnrich')).toContainEqual({ name: 'BiocSet', field: 'Depends' });
  });

  test('two calls on the same index return the same object', () => {
    expect(dependencyGraph(index)).toBe(graph);
  });
});

describe('dependencyGraph on synthetic indexes', () => {
  test('a self-dependency is dropped', () => {
    const graph = dependencyGraph(indexOf({ A: entry({ Imports: 'A, B' }) }));
    expect(graph.dependencies.get('A')).toEqual([{ name: 'B', field: 'Imports' }]);
    expect(graph.dependents.get('A')).toBeUndefined();
  });

  test('a cycle terminates and never lists the package itself', () => {
    const graph = dependencyGraph(indexOf({ A: entry({ Imports: 'B' }), B: entry({ Imports: 'A' }) }));
    expect(reverseDependencies(graph, 'A')).toEqual([{ name: 'B', depth: 1 }]);
  });

  test('an entry with desc.Imports: 42 goes to depsUnknown and the others are still built', () => {
    const graph = dependencyGraph(
      indexOf({ Bad: entry({ Imports: 42 }), NoDesc: { version: '1' }, Good: entry({ Imports: 'Bad' }), Str: 'x' }),
    );
    expect(graph.depsUnknown).toEqual(['Bad', 'NoDesc', 'Str']);
    expect(graph.dependencies.get('Good')).toEqual([{ name: 'Bad', field: 'Imports' }]);
    expect(reverseDependencies(graph, 'Bad')).toEqual([{ name: 'Good', depth: 1 }]);
  });

  test('constructor and __proto__ are ordinary names', () => {
    const packages = JSON.parse(
      '{"constructor":{"desc":{"Imports":"toString, valueOf"}},"__proto__":{"desc":{"Depends":"constructor"}},"Other":{"desc":{"Imports":"constructor"}}}',
    ) as Record<string, unknown>;
    const graph = dependencyGraph(indexOf(packages));
    expect(graph.dependencies.get('constructor')).toEqual([
      { name: 'toString', field: 'Imports' },
      { name: 'valueOf', field: 'Imports' },
    ]);
    expect(graph.dependencies.get('__proto__')).toEqual([{ name: 'constructor', field: 'Depends' }]);
    expect(reverseDependencies(graph, 'constructor')).toEqual([
      { name: 'Other', depth: 1 },
      { name: '__proto__', depth: 1 },
    ]);
    expect(reverseDependencies(graph, 'hasOwnProperty')).toEqual([]);
  });

  test('a diamond lists D once, at depth 2', () => {
    const graph = dependencyGraph(
      indexOf({ B: entry({ Imports: 'A' }), C: entry({ Imports: 'A' }), D: entry({ Imports: 'B, C' }) }),
    );
    expect(reverseDependencies(graph, 'A')).toEqual([
      { name: 'B', depth: 1 },
      { name: 'C', depth: 1 },
      { name: 'D', depth: 2 },
    ]);
  });

  test('maxDepth 1 stops at direct dependents', () => {
    const graph = dependencyGraph(indexOf({ B: entry({ Imports: 'A' }), D: entry({ Imports: 'B' }) }));
    expect(reverseDependencies(graph, 'A', 1)).toEqual([{ name: 'B', depth: 1 }]);
  });

  test('order is by code unit: Zeta before alpha', () => {
    const graph = dependencyGraph(indexOf({ alpha: entry({ Imports: 'A' }), Zeta: entry({ Imports: 'A' }) }));
    expect(reverseDependencies(graph, 'A').map((d) => d.name)).toEqual(['Zeta', 'alpha']);
    expect(dependencyGraph(indexOf({ alpha: { x: 1 }, Zeta: { x: 1 } })).depsUnknown).toEqual(['Zeta', 'alpha']);
  });

  test('a package that names a dependency in two fields lists both, in field order', () => {
    const graph = dependencyGraph(indexOf({ C: entry({ LinkingTo: 'A', Depends: 'A, R (>= 4)' }) }));
    expect(graph.dependents.get('A')!.get('C')).toEqual(['Depends', 'LinkingTo']);
    expect(graph.dependencies.get('C')).toEqual([
      { name: 'A', field: 'Depends' },
      { name: 'R', field: 'Depends' },
      { name: 'A', field: 'LinkingTo' },
    ]);
  });
});
