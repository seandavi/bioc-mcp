import { describe, expect, it } from 'vitest';
import { bundledDocsIndex } from '../../src/docs-index/bundled';
import { DocsIndexMetaSchema } from '../../src/docs-index/schema';

describe('bundledDocsIndex', () => {
  it('loads the generated module once', () => {
    const index = bundledDocsIndex();
    expect(DocsIndexMetaSchema.safeParse(index.meta).success).toBe(true);
    expect(index.records.length).toBeGreaterThan(0);
    expect(index.records).toHaveLength(index.meta.record_count);
    expect(bundledDocsIndex()).toBe(index);
  });
});
