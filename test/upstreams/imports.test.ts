import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const UPSTREAMS_DIR = join(import.meta.dirname, '..', '..', 'src', 'upstreams');
const adapters = readdirSync(UPSTREAMS_DIR).filter((file) => file.endsWith('.ts'));

describe('upstream adapters import core only as types', () => {
  test('there are adapters to check', () => {
    expect(adapters).toContain('github.ts');
  });

  test.each(adapters)('%s', (file) => {
    const source = readFileSync(join(UPSTREAMS_DIR, file), 'utf8');
    const coreImports = source.match(/^import\s.*from\s+'\.\.\/core\/.*$/gm) ?? [];
    for (const line of coreImports) expect(line).toMatch(/^import type /);
  });
});
