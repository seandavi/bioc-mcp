import { describe, expect, it } from 'vitest';
import { AboutSchema, buildAbout } from '../../../src/core/about';
import { createDocsModule } from '../../../src/core/docs';
import type { DocsInput } from '../../../src/docs-index/schema';
import { fixtureDocsIndex, fixtureDocsIndexWith } from '../../support/docs';

const BUILT = new Date('2026-10-22T00:00:00Z');
const INDEX_WARNING = (days: number) =>
  `The docs index was built 2026-10-22, ${days} days ago; it is rebuilt daily, so docs changed since then are not in it.`;

async function dataset(now: Date, edit?: Parameters<typeof fixtureDocsIndexWith>[0]) {
  const index = edit ? await fixtureDocsIndexWith(edit) : await fixtureDocsIndex();
  const about = AboutSchema.parse(buildAbout([createDocsModule(() => index)], now));
  expect(about.datasets).toHaveLength(1);
  return about.datasets[0]!;
}

describe('docs-index dataset', () => {
  it('lists the age, no warnings, and every input with its commit ', async () => {
    const d = await dataset(new Date('2026-10-22T12:00:00Z'));
    expect(d).toMatchObject({ id: 'docs-index', module: 'docs', age_days: 0, possibly_stale: [] });
    expect(d.description).toContain('possibly_stale says why it may be out of date');
    expect(d.inputs).toHaveLength(16);
    expect(Object.keys(d.inputs[0]!.commit!)).toEqual(['repo', 'ref', 'sha', 'head_sha', 'head_committed_at']);
    for (const input of d.inputs) expect(input.possibly_stale).toBeNull();
  });

  it('puts the index warning in the dataset at 2 days, not at 1 day 23:59', async () => {
    expect((await dataset(new Date('2026-10-23T23:59:00Z'))).possibly_stale).toEqual([]);
    const stale = await dataset(new Date('2026-10-24T00:00:00Z'));
    expect(stale).toMatchObject({ age_days: 2, possibly_stale: [INDEX_WARNING(2)] });
    expect(stale.inputs.every((input) => input.possibly_stale === null)).toBe(true);
  });

  it('flags an input behind its branch on the input and in the dataset list', async () => {
    const d = await dataset(BUILT, (inputs) => {
      inputs[3]!.commit = { ...inputs[3]!.commit!, head_sha: 'b'.repeat(40), head_committed_at: '2026-10-20T08:09:10Z' };
    });
    expect(d.inputs[3]!.possibly_stale).toMatch(/^Docs under https:\/\/github\.com\/seandavi\/.+ come from seandavi\/.+@[0-9a-f]{7}, but main was already at bbbbbbb/);
    expect(d.possibly_stale).toEqual([d.inputs[3]!.possibly_stale]);
    expect(d.inputs.filter((input) => input.possibly_stale !== null)).toHaveLength(1);
  });

  it('flags an input with no commit once it is 14 days old', async () => {
    const edit = (inputs: DocsInput[]) => {
      inputs[0]!.commit = null;
    };
    const at13 = await dataset(new Date('2026-11-04T23:59:59Z'), edit);
    expect(at13.inputs[0]).toMatchObject({ commit: null, possibly_stale: null });
    const at14 = await dataset(new Date('2026-11-05T00:00:00Z'), edit);
    expect(at14.inputs[0]!.possibly_stale).toBe(
      'Docs under https://seandavi.github.io/bioc-infrastructure/ are 14 days old (as of 2026-10-22) and their source commit is unknown.',
    );
    expect(at14.possibly_stale).toContain(at14.inputs[0]!.possibly_stale);
  });
});
