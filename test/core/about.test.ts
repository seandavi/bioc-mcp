import { describe, expect, test } from 'vitest';
import { AboutSchema, buildAbout } from '../../src/core/about';
import { metaModule } from '../../src/core/meta';
import type { Module } from '../../src/core/registry';
import { VERSION } from '../../src/version';
import { exampleModule } from '../support/example-module';

const NOW = new Date('2026-10-22T00:00:00Z');

describe('buildAbout', () => {
  test('parses with AboutSchema and describes every module in order', () => {
    const about = AboutSchema.parse(buildAbout([metaModule, exampleModule], NOW));
    expect(about.version).toBe(VERSION);
    expect(about.modules).toEqual([
      { name: 'meta', description: metaModule.description, mcp_path: '/mcp/meta', tools: ['meta_ping'] },
      { name: 'example', description: exampleModule.description, mcp_path: '/mcp/example', tools: ['example_item'] },
    ]);
    expect(about.upstreams).toEqual([
      {
        id: 'example',
        name: 'Example upstream',
        base_url: 'https://upstream.test/',
        ttl_seconds: 300,
        description: 'Synthetic upstream used only in tests.',
        used_by: ['example'],
      },
    ]);
    expect(about.datasets).toEqual([]);
  });

  test('lists the datasets modules declare, in module order, with their module name', () => {
    const commit = {
      repo: 'seandavi/data',
      ref: 'main',
      sha: 'a'.repeat(40),
      url: `https://github.com/seandavi/data/commit/${'a'.repeat(40)}`,
      head_sha: 'b'.repeat(40),
      head_committed_at: '2026-10-21T00:00:00Z',
    };
    const inputs = [{ url: 'https://data.test/a.json', as_of: '2026-10-22T00:00:00Z', commit, possibly_stale: 'behind' }];
    const first: Module = {
      ...exampleModule,
      name: 'first',
      datasets: () => [
        { id: 'one', description: 'One.', built_at: '2026-10-22T00:00:00Z', build_commit: 'abc', age_days: 0, possibly_stale: ['behind'], inputs },
        { id: 'two', description: 'Two.', built_at: '2026-10-21T00:00:00Z', build_commit: null, age_days: 1, possibly_stale: [], inputs: [] },
      ],
    };
    const second: Module = {
      ...exampleModule,
      name: 'second',
      datasets: () => [
        { id: 'three', description: 'Three.', built_at: '2026-10-20T00:00:00Z', build_commit: null, age_days: 2, possibly_stale: [], inputs: [] },
      ],
    };
    const about = AboutSchema.parse(buildAbout([metaModule, first, second], NOW));
    expect(about.datasets).toEqual([
      { id: 'one', module: 'first', description: 'One.', built_at: '2026-10-22T00:00:00Z', build_commit: 'abc', age_days: 0, possibly_stale: ['behind'], inputs },
      { id: 'two', module: 'first', description: 'Two.', built_at: '2026-10-21T00:00:00Z', build_commit: null, age_days: 1, possibly_stale: [], inputs: [] },
      { id: 'three', module: 'second', description: 'Three.', built_at: '2026-10-20T00:00:00Z', build_commit: null, age_days: 2, possibly_stale: [], inputs: [] },
    ]);
  });

  test('passes now to each module\'s datasets', () => {
    const seen: Date[] = [];
    const module: Module = { ...exampleModule, name: 'clocked', datasets: (now) => (seen.push(now), []) };
    buildAbout([module], NOW);
    expect(seen).toEqual([NOW]);
  });

  test('de-duplicates upstreams by id and lists every module that uses one', () => {
    const second: Module = { ...exampleModule, name: 'second', capabilities: [] };
    const about = buildAbout([exampleModule, second], NOW);
    expect(about.upstreams).toHaveLength(1);
    expect(about.upstreams[0]?.used_by).toEqual(['example', 'second']);
  });
});
