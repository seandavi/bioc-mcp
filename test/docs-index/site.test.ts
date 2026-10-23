import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { siteRecords, siteSubsections, splitSiteRecords } from '../../scripts/docs-index/site';
import type { DocsRecord } from '../../src/docs-index/schema';

const SITE = 'https://example.org/docs/';

describe('siteRecords', () => {
  it('maps entries to absolute-URL records', () => {
    const records = siteRecords(
      [
        { objectID: 'adr/0001.html#context', href: 'adr/0001.html#context', title: 'ADR 1', section: '', text: 'a &lt;b&gt;', crumbs: ['ADRs'] },
        { objectID: 'x.html', href: 'x.html', title: 'X &amp; Y', section: 'S', text: 'plain', crumbs: ['A', 'B'] },
      ],
      SITE,
    );
    expect(records).toEqual([
      {
        id: 'site:adr/0001.html#context',
        url: 'https://example.org/docs/adr/0001.html#context',
        title: 'ADR 1',
        section: '',
        crumbs: ['ADRs'],
        text: 'a <b>',
        source: 'adr',
      },
      {
        id: 'site:x.html',
        url: 'https://example.org/docs/x.html',
        title: 'X & Y',
        section: 'S',
        crumbs: ['A', 'B'],
        text: 'plain',
        source: 'site',
      },
    ]);
    expect('repo' in (records[0] as object)).toBe(false);
  });

  it('decodes entities in one pass', () => {
    const [record] = siteRecords([{ href: 'a.html', title: 't', section: '', text: '&amp;lt; &quot;q&quot; &#39;s&#39;', crumbs: [] }], SITE);
    expect(record?.text).toBe('&lt; "q" \'s\'');
  });

  it('treats null crumbs as empty and keeps empty text', () => {
    const [record] = siteRecords([{ href: 'a.html', title: 't', section: '', text: '', crumbs: null }], SITE);
    expect(record?.crumbs).toEqual([]);
    expect(record?.text).toBe('');
  });

  it('throws on non-array input', () => {
    expect(() => siteRecords({}, SITE)).toThrow('search.json is not an array');
  });

  it('names the entry that has no href', () => {
    expect(() =>
      siteRecords([{ href: 'a.html', title: 't', section: '', text: '' }, { title: 't', section: '', text: '' }], SITE),
    ).toThrow(/entry 1/);
  });

  it.each(['https://other.example/x', '//other.example/x', 'javascript:alert(1)', 'data:text/html,x', '../x.html', '/elsewhere.html'])(
    'rejects href %s that leaves site_url',
    (href) => {
      expect(() => siteRecords([{ href, title: 't', section: '', text: '' }], SITE)).toThrow(/entry 0 href leaves site_url/);
    },
  );

  it('throws on duplicate hrefs', () => {
    const entry = { href: 'a.html', title: 't', section: '', text: '' };
    expect(() => siteRecords([entry, entry], SITE)).toThrow('Duplicate docs record id: site:a.html');
  });
});

const PAGE_HTML = `
<section id="early" class="level3"><h3 class="anchored" data-anchor-id="early">Before any h2</h3></section>
<section id="one" class="level2">
<h2 class="anchored" data-anchor-id="one">One</h2>
<p>intro</p>
<section id="one-a" class="level3 unnumbered">
<h3 class="anchored" data-anchor-id="one-a"><code>x</code> &amp; <a href="#y">y</a></h3>
</section>
<section id="one-b" class="level3">
<h3 class="anchored" data-anchor-id="one-b">Plain  heading</h3>
</section>
</section>
<section id="two" class="level2">
<h2 class="anchored" data-anchor-id="two">Two</h2>
<section id="two-a" class="level3"><h3>Only child</h3></section>
</section>`;

describe('siteSubsections', () => {
  it('keys level-3 sections by their enclosing h2, in order, and omits those before the first h2', () => {
    const result = siteSubsections(PAGE_HTML);
    expect([...result.keys()]).toEqual(['one', 'two']);
    expect(result.get('one')).toEqual([
      { id: 'one-a', heading: 'x & y' },
      { id: 'one-b', heading: 'Plain heading' },
    ]);
    expect(result.get('two')).toEqual([{ id: 'two-a', heading: 'Only child' }]);
  });

  it('finds the 7 runbooks of the operations.html fixture', () => {
    const html = readFileSync(
      join(import.meta.dirname, '..', 'fixtures', 'docs', 'seandavi.github.io', 'bioc-infrastructure', 'operations.html'),
      'utf8',
    );
    expect(siteSubsections(html).get('runbooks')?.map((s) => s.id)).toEqual([
      'deploy-worker',
      'rollback-worker',
      'rollback-site',
      'failed-sync',
      'purge',
      'yank',
      'rollback-dns',
    ]);
  });
});

describe('splitSiteRecords', () => {
  const parent: DocsRecord = {
    id: 'site:p.html#one',
    url: 'https://example.org/docs/p.html#one',
    title: 'Page',
    section: 'One',
    crumbs: ['Top'],
    text: 'One\nintro\nA\nalpha\nB\nbeta\nA',
    source: 'adr',
  };
  const pageLevel: DocsRecord = { ...parent, id: 'site:p.html', url: 'https://example.org/docs/p.html', section: '', crumbs: [] };
  const other: DocsRecord = { ...parent, id: 'site:q.html#x', url: 'https://example.org/docs/q.html#x' };
  const byPage = new Map([
    [
      'p.html',
      new Map([
        [
          'one',
          [
            { id: 'one-a', heading: 'A' },
            { id: 'one-b', heading: 'B' },
          ],
        ],
      ]),
    ],
  ]);

  it('splits a parent into its intro and one record per subsection', () => {
    const result = splitSiteRecords([parent], byPage, SITE);
    expect(result).toEqual([
      { ...parent, text: 'One\nintro' },
      {
        id: 'site:p.html#one-a',
        url: 'https://example.org/docs/p.html#one-a',
        title: 'Page',
        section: 'A',
        crumbs: ['Top', 'One'],
        text: 'A\nalpha',
        source: 'adr',
      },
      {
        id: 'site:p.html#one-b',
        url: 'https://example.org/docs/p.html#one-b',
        title: 'Page',
        section: 'B',
        crumbs: ['Top', 'One'],
        text: 'B\nbeta\nA',
        source: 'adr',
      },
    ]);
    expect('repo' in (result[1] as object)).toBe(false);
  });

  it('passes through page-level records and records without subsections', () => {
    const result = splitSiteRecords([pageLevel, other], byPage, SITE);
    expect(result[0]).toBe(pageLevel);
    expect(result[1]).toBe(other);
  });

  it('does not reuse a heading line that sits before the previous cut', () => {
    const twice = new Map([['p.html', new Map([['one', [{ id: 'a1', heading: 'A' }, { id: 'a2', heading: 'A' }]]])]]);
    const result = splitSiteRecords([parent], twice, SITE);
    expect(result.map((r) => r.text)).toEqual(['One\nintro', 'A\nalpha\nB\nbeta', 'A']);
  });

  it("does not cut at the parent's own heading line", () => {
    const summary: DocsRecord = { ...parent, id: 'site:p.html#summary', section: 'Summary', text: 'Summary\nintro\nSummary\ndetail' };
    const named = new Map([['p.html', new Map([['summary', [{ id: 'summary-1', heading: 'Summary' }]]])]]);
    const result = splitSiteRecords([summary], named, SITE);
    expect(result.map((r) => r.text)).toEqual(['Summary\nintro', 'Summary\ndetail']);
  });

  it('throws naming the record id and heading when the text has no such line', () => {
    const missing = new Map([['p.html', new Map([['one', [{ id: 'zzz', heading: 'Nowhere' }]]])]]);
    expect(() => splitSiteRecords([parent], missing, SITE)).toThrow(/site:p\.html#one: no line "Nowhere" for subsection #zzz/);
    expect(() => splitSiteRecords([parent], missing, SITE)).toThrow(/re-record both with npm run docs:record/);
  });
});
