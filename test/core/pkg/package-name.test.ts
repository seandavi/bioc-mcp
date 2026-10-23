import { describe, expect, test } from 'vitest';
import { closeMatches, PackageNameSchema } from '../../../src/core/pkg/package-name';

describe('PackageNameSchema', () => {
  test.each(['edgeR', 'RTCGA.RPPA', 'BSgenome.Hsapiens.UCSC.hg38', 'ab'])('accepts %s', (name) => {
    expect(PackageNameSchema.safeParse(name).success).toBe(true);
  });

  test.each(['x', '1abc', 'edgeR.', "a'b", 'a/b', 'a b', 'a'.repeat(101)])('rejects %j', (name) => {
    expect(PackageNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('closeMatches', () => {
  const candidates = ['edge', 'edgeR', 'biomaRt', 'trackViewer', 'limma', 'DESeq2'];

  test('finds names within edit distance 2, best first', () => {
    expect(closeMatches('edgr', candidates)).toEqual(['edge', 'edgeR']);
  });

  test('finds a wrong-case name', () => {
    expect(closeMatches('biomart', candidates)).toEqual(['biomaRt']);
  });

  test('finds a prefix of three or more characters', () => {
    expect(closeMatches('trackview', candidates)).toEqual(['trackViewer']);
  });

  test('a prefix needs at least three characters', () => {
    expect(closeMatches('tra', ['trackViewer'])).toEqual(['trackViewer']);
    expect(closeMatches('tr', ['trackViewer'])).toEqual([]);
  });

  test('returns nothing when no name is close', () => {
    expect(closeMatches('zzzzzz', candidates)).toEqual([]);
  });

  test('excludes the exact name', () => {
    expect(closeMatches('edgeR', candidates)).toEqual(['edge']);
  });

  test('honours the limit', () => {
    expect(closeMatches('edgr', candidates, 1)).toEqual(['edge']);
  });

  test('a prefix match survives the length filter; a non-prefix more than 2 characters longer is skipped', () => {
    expect(closeMatches('Bioc', ['BiocParallel', 'Biobase'])).toEqual(['BiocParallel']);
  });

  test('a 100-character query against 3,000 candidates matches nothing', () => {
    const names = Array.from({ length: 3000 }, (_, i) => `pkg${i}`);
    expect(closeMatches('a'.repeat(100), names)).toEqual([]);
  });

  test('orders ties by code unit, not locale', () => {
    expect(closeMatches('abc', ['abe', 'abd', 'Abf'])).toEqual(['Abf', 'abd', 'abe']);
  });
});
