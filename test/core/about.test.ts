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
  });

  test('de-duplicates upstreams by id and lists every module that uses one', () => {
    const second: Module = { ...exampleModule, name: 'second', capabilities: [] };
    const about = buildAbout([exampleModule, second]);
    expect(about.upstreams).toHaveLength(1);
    expect(about.upstreams[0]?.used_by).toEqual(['example', 'second']);
  });
});
