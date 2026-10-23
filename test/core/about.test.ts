import { describe, expect, test } from 'vitest';
import { AboutSchema, buildAbout } from '../../src/core/about';
import { metaModule } from '../../src/core/meta';
import type { Module } from '../../src/core/registry';
import { VERSION } from '../../src/version';
import { exampleModule } from '../support/example-module';

describe('buildAbout', () => {
  test('parses with AboutSchema and describes every module in order', () => {
    const about = AboutSchema.parse(buildAbout([metaModule, exampleModule]));
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
    const inputs = [{ url: 'https://data.test/a.json', as_of: '2026-10-22T00:00:00Z' }];
    const first: Module = {
      ...exampleModule,
      name: 'first',
      datasets: () => [
        { id: 'one', description: 'One.', built_at: '2026-10-22T00:00:00Z', build_commit: 'abc', inputs },
        { id: 'two', description: 'Two.', built_at: '2026-10-21T00:00:00Z', build_commit: null, inputs: [] },
      ],
    };
    const second: Module = {
      ...exampleModule,
      name: 'second',
      datasets: () => [{ id: 'three', description: 'Three.', built_at: '2026-10-20T00:00:00Z', build_commit: null, inputs }],
    };
    const about = AboutSchema.parse(buildAbout([metaModule, first, second]));
    expect(about.datasets).toEqual([
      { id: 'one', module: 'first', description: 'One.', built_at: '2026-10-22T00:00:00Z', build_commit: 'abc', inputs },
      { id: 'two', module: 'first', description: 'Two.', built_at: '2026-10-21T00:00:00Z', build_commit: null, inputs: [] },
      { id: 'three', module: 'second', description: 'Three.', built_at: '2026-10-20T00:00:00Z', build_commit: null, inputs },
    ]);
  });

  test('de-duplicates upstreams by id and lists every module that uses one', () => {
    const second: Module = { ...exampleModule, name: 'second', capabilities: [] };
    const about = buildAbout([exampleModule, second]);
    expect(about.upstreams).toHaveLength(1);
    expect(about.upstreams[0]?.used_by).toEqual(['example', 'second']);
  });
});
