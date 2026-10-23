import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const UPSTREAMS_DIR = join(import.meta.dirname, '..', '..', 'src', 'upstreams');
const adapters = readdirSync(UPSTREAMS_DIR).filter((file) => file.endsWith('.ts'));

/** Every import or export statement whose specifier starts with '../core/'; `[^;]` spans wrapped lines. */
function coreStatements(source: string): string[] {
  return source.match(/^(?:import|export)\s[^;]*?from\s+'\.\.\/core\/[^']*'/gm) ?? [];
}

describe('upstream adapters import core only as types', () => {
  test('there are adapters to check', () => {
    expect(adapters).toContain('github.ts');
  });

  test('the matcher finds wrapped imports and re-exports, one statement at a time', () => {
    expect(coreStatements("import {\n  X,\n} from '../core/x';")).toEqual(["import {\n  X,\n} from '../core/x'"]);
    expect(coreStatements("export { X } from '../core/x';")).toEqual(["export { X } from '../core/x'"]);
    expect(coreStatements("import { Y } from './y';\nimport type { X } from '../core/x';")).toEqual([
      "import type { X } from '../core/x'",
    ]);
  });

  test.each(adapters)('%s', (file) => {
    const source = readFileSync(join(UPSTREAMS_DIR, file), 'utf8');
    for (const statement of coreStatements(source)) expect(statement).toMatch(/^(?:import|export) type /);
  });
});
