import { beforeAll, describe, expect, it } from 'vitest';
import { docsPages, docsPageSource, docsSource, renderPage, renderSection, sectionLabel, type DocsPages } from '../../../src/core/docs/pages';
import type { DocsIndex } from '../../../src/docs-index/load';
import type { DocsRecord } from '../../../src/docs-index/schema';
import { fixtureDocsIndex, syntheticDocsIndex } from '../../support/docs';

let index: DocsIndex;
let pages: DocsPages;
beforeAll(async () => {
  index = await fixtureDocsIndex();
  pages = docsPages(index);
});

function record(overrides: Partial<DocsRecord> & Pick<DocsRecord, 'id' | 'url'>): DocsRecord {
  return { title: 'T', section: '', crumbs: [], text: '', source: 'site', ...overrides };
}

describe('docsPages', () => {
  it('finds 56 pages on the fixture index and caches them per index', () => {
    expect(pages.list).toHaveLength(56);
    expect(docsPages(index)).toBe(pages);
  });

  it('derives path and uri for a site page, an ADR and a repo document', () => {
    const site = pages.byPath.get('propagation-gate.html')!;
    expect(site).toMatchObject({
      id: 'site:propagation-gate.html',
      uri: 'bioc://docs/propagation-gate.html',
      url: 'https://seandavi.github.io/bioc-infrastructure/propagation-gate.html',
      source: 'site',
      repo: null,
    });
    const adr = pages.byPath.get('adr/0009-client-addresses-are-hashed-at-the-edge.html')!;
    expect(adr.id).toBe('site:adr/0009-client-addresses-are-hashed-at-the-edge.html');
    expect(adr.source).toBe('adr');
    const repo = pages.byPath.get('repo/bioc-edge/DATAPLANE.md')!;
    expect(repo).toMatchObject({ id: 'repo:bioc-edge/DATAPLANE.md', uri: 'bioc://docs/repo/bioc-edge/DATAPLANE.md', repo: 'bioc-edge', source: 'repo' });
  });

  it('indexes pages by id and url and puts the page-level record first', () => {
    const page = pages.byPath.get('propagation-gate.html')!;
    expect(pages.byId.get(page.id)).toBe(page);
    expect(pages.byUrl.get(page.url)).toBe(page);
    expect(page.records[0]!.id).toBe(page.id);
    expect(page.title).toBe(page.records[0]!.title);
    expect(page.input).toBe(index.inputFor(page.id));
  });

  it('finds a section by fragment, including a percent-encoded one', () => {
    const page = pages.byPath.get('propagation-gate.html')!;
    expect(pages.section(page, 'why-the-registry-polls')?.id).toBe('site:propagation-gate.html#why-the-registry-polls');
    expect(pages.section(page, 'nope')).toBeUndefined();

    const synthetic = docsPages(
      syntheticDocsIndex([
        record({ id: 'site:x.html', url: 'https://docs.test/x.html' }),
        record({ id: 'site:x.html#caf%C3%A9', url: 'https://docs.test/x.html#caf%C3%A9', section: 'Café' }),
      ]),
    );
    const x = synthetic.list[0]!;
    expect(synthetic.section(x, 'café')?.section).toBe('Café');
    expect(synthetic.section(x, 'caf%C3%A9')?.section).toBe('Café');
  });

  it('throws on two pages with the same path', () => {
    const clash = syntheticDocsIndex([
      record({ id: 'site:repo/bioc-edge/A.md', url: 'https://docs.test/a' }),
      record({ id: 'repo:bioc-edge/A.md', url: 'https://docs.test/b', source: 'repo', repo: 'bioc-edge' }),
    ]);
    expect(() => docsPages(clash)).toThrow(/two pages at path "repo\/bioc-edge\/A\.md"/);
  });
});

describe('sectionLabel', () => {
  it('uses the section of a site record', () => {
    expect(sectionLabel(index.get('site:propagation-gate.html#why-the-registry-polls')!)).toBe('Why the registry polls');
  });

  it('derives the label of an ADR section from its anchor', () => {
    const adr = pages.byPath.get('adr/0009-client-addresses-are-hashed-at-the-edge.html')!;
    const context = adr.records.find((r) => r.url.endsWith('#context'))!;
    expect(context.section).toBe('');
    expect(sectionLabel(context)).toBe('Context');
  });

  it('is empty for a page-level record', () => {
    expect(sectionLabel(index.get('site:propagation-gate.html')!)).toBe('');
  });

  it('turns hyphens into spaces and upper-cases the first letter', () => {
    const r = record({ id: 'site:x.html#why-at-the-edge--rather', url: 'https://docs.test/x.html#why-at-the-edge--rather' });
    expect(sectionLabel(r)).toBe('Why at the edge rather');
  });
});

describe('rendering', () => {
  it('drops the repeated heading line of a site section and collapses blank-line runs', () => {
    const r = record({
      id: 'site:x.html#h',
      url: 'https://docs.test/x.html#h',
      section: 'Heading',
      text: 'Heading\nfirst\n\n\n\nsecond\n',
    });
    expect(renderSection(r)).toBe('## Heading\n\nhttps://docs.test/x.html#h\n\nfirst\n\nsecond');
  });

  it('keeps the first line of repo text and falls back to the title with no label', () => {
    const r = record({ id: 'repo:a/B.md', url: 'https://github.com/x/a/blob/main/B.md', source: 'repo', repo: 'a', title: 'B doc', text: '# B\nbody' });
    expect(renderSection(r)).toBe('## B doc\n\nhttps://github.com/x/a/blob/main/B.md\n\n# B\nbody');
  });

  it('ends on the URL line when the body is empty', () => {
    const r = record({ id: 'site:x.html#h', url: 'https://docs.test/x.html#h', section: 'H', text: 'H\n' });
    expect(renderSection(r)).toBe('## H\n\nhttps://docs.test/x.html#h');
  });

  it('renders a page: header, page-level body, then one ## per other record', () => {
    const page = pages.byPath.get('propagation-gate.html')!;
    const text = renderPage(page);
    expect(text.startsWith(`# ${page.title}\n\n${page.url}\n\n`)).toBe(true);
    expect(text.match(/^## /gm)).toHaveLength(page.records.length - 1);
    expect(text).toContain('## Why the registry polls\n\nhttps://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls\n\n');
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('shows each ADR section once and keeps the Status and Date lines', () => {
    const adrs = pages.list.filter((page) => page.source === 'adr');
    expect(adrs).toHaveLength(13);
    for (const page of adrs) {
      const text = renderPage(page);
      expect(text, page.id).toMatch(/\nStatus: /);
      expect(text, page.id).toMatch(/\nDate: /);
      for (const section of page.records.slice(1)) {
        const sectionBody = renderSection(section).split('\n\n').slice(2).join('\n\n');
        expect(sectionBody, section.id).not.toBe('');
        expect(text.split(sectionBody), section.id).toHaveLength(2);
      }
    }
  });

  it('keeps a page-level body that does not contain the first section', () => {
    const page = docsPages(
      syntheticDocsIndex([
        record({ id: 'site:z.html', url: 'https://docs.test/z.html', text: 'intro' }),
        record({ id: 'site:z.html#a', url: 'https://docs.test/z.html#a', section: 'A', text: 'A\nbody' }),
      ]),
    ).list[0]!;
    expect(renderPage(page)).toBe('# T\n\nhttps://docs.test/z.html\n\nintro\n\n## A\n\nhttps://docs.test/z.html#a\n\nbody');
  });

  it("keeps an intro that repeats the first section's body", () => {
    const page = docsPages(
      syntheticDocsIndex([
        record({ id: 'site:z.html', url: 'https://docs.test/z.html', text: 'Status: Accepted\n\nTBD for now.\n\nTBD' }),
        record({ id: 'site:z.html#a', url: 'https://docs.test/z.html#a', section: 'A', text: 'A\nTBD' }),
      ]),
    ).list[0]!;
    expect(renderPage(page)).toBe(
      '# T\n\nhttps://docs.test/z.html\n\nStatus: Accepted\n\nTBD for now.\n\n## A\n\nhttps://docs.test/z.html#a\n\nTBD',
    );
  });

  it('puts sections directly after the header when a page has no page-level record', () => {
    const only = docsPages(
      syntheticDocsIndex([record({ id: 'site:y.html#a', url: 'https://docs.test/y.html#a', section: 'A', text: 'A\nbody' })]),
    ).list[0]!;
    expect(renderPage(only)).toBe('# T\n\nhttps://docs.test/y.html\n\n## A\n\nhttps://docs.test/y.html#a\n\nbody');
  });
});

describe('docsSource', () => {
  it('prefers last_modified, else fetched_at', () => {
    const input = { url: 'https://docs.test/s.json', record_count: 1, last_modified: null, fetched_at: '2026-10-22T00:00:00Z', sha256: '0'.repeat(64) };
    expect(docsSource(input)).toEqual({ url: input.url, as_of: '2026-10-22T00:00:00Z' });
    expect(docsSource({ ...input, last_modified: '2026-10-01T00:00:00Z' }).as_of).toBe('2026-10-01T00:00:00Z');
  });
});

describe('pageOf and docsPageSource', () => {
  const GATE = 'https://seandavi.github.io/bioc-infrastructure/propagation-gate.html';

  it("pageOf finds a record's page", () => {
    const section = index.get('site:propagation-gate.html#why-the-registry-polls')!;
    expect(pages.pageOf(section)).toBe(pages.byPath.get('propagation-gate.html'));
  });

  it("docsPageSource cites the page url, dated by the page's input", () => {
    const page = pages.byPath.get('propagation-gate.html')!;
    expect(docsPageSource(page)).toEqual({ url: GATE, as_of: index.meta.inputs[0]!.fetched_at });
  });
});
