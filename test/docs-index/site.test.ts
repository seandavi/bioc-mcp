import { describe, expect, it } from 'vitest';
import { siteRecords } from '../../scripts/docs-index/site';

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

  it('throws on duplicate hrefs', () => {
    const entry = { href: 'a.html', title: 't', section: '', text: '' };
    expect(() => siteRecords([entry, entry], SITE)).toThrow('Duplicate docs record id: site:a.html');
  });
});
