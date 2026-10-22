import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { VERSION } from '../src/version';

test('VERSION equals package.json version', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
