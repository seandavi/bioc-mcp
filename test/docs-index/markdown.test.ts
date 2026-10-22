import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markdownRecords } from '../../scripts/docs-index/markdown';

function records(markdown: string, repo = 'r', file = 'README.md') {
  return markdownRecords({ owner: 'o', repo, ref: 'main', file, markdown });
}

describe('markdownRecords', () => {
  it('makes a document-level record from the preamble and the first level-1 heading', () => {
    const [doc, section] = records('Preamble\n\n# Title\n\nIntro\n\n## Part\n\nBody');
    expect(doc).toEqual({
      id: 'repo:r/README.md',
      url: 'https://github.com/o/r/blob/main/README.md',
      title: 'Title',
      section: '',
      crumbs: ['r', 'Title'],
      text: 'Preamble\n\n\nIntro',
      source: 'repo',
      repo: 'r',
    });
    expect(section).toMatchObject({
      id: 'repo:r/README.md#part',
      url: 'https://github.com/o/r/blob/main/README.md#part',
      section: 'Part',
      text: 'Body',
    });
  });

  it('splits at levels 2 and 3 and keeps level 4 in the body', () => {
    const out = records('# T\n\n## A\n\na\n\n### B\n\nb\n\n#### C\n\nc');
    expect(out.map((r) => r.section)).toEqual(['A', 'B']);
    expect(out[1]?.text).toBe('b\n\n#### C\n\nc');
    expect(out[1]?.crumbs).toEqual(['r', 'T', 'A']);
  });

  it('ignores headings inside backtick and tilde fences', () => {
    const out = records('# T\n\n## A\n\n```sh\n# not a heading\n```\n\n~~~~\n## nor this\n~~~\n~~~~\n\n## B\n\nb');
    expect(out.map((r) => r.section)).toEqual(['A', 'B']);
    expect(out[0]?.text).toContain('# not a heading');
    expect(out[0]?.text).toContain('## nor this');
  });

  it('suffixes duplicate headings like GitHub', () => {
    const out = records('# T\n\n## Same\n\none\n\n## Same\n\ntwo');
    expect(out.map((r) => r.id)).toEqual(['repo:r/README.md#same', 'repo:r/README.md#same-1']);
  });

  it('strips links, code and emphasis from section and anchor', () => {
    const [record] = records('# T\n\n## The [`bioc`](http://x) **tool** ![i](a.png)\n\nbody');
    expect(record?.section).toBe('The bioc tool i');
    expect(record?.id).toBe('repo:r/README.md#the-bioc-tool-i');
  });

  it('skips empty sections but names them in their children crumbs', () => {
    const out = records('# T\n\n## Parent\n\n### Child\n\nchild text\n\n<!-- hidden -->\n## Hidden\n\n<!-- only a comment -->');
    expect(out.map((r) => r.section)).toEqual(['Child']);
    expect(out[0]?.crumbs).toEqual(['r', 'T', 'Parent']);
  });

  it('falls back to repo/file when there is no level-1 heading', () => {
    const [record] = records('Just text\n\n## Part\n\nx', 'r', 'docs/api.md');
    expect(record).toMatchObject({ id: 'repo:r/docs/api.md', title: 'r/docs/api.md', section: '' });
  });

  it('handles CRLF line endings', () => {
    const out = records('# T\r\n\r\n## A\r\n\r\nbody\r\n');
    expect(out.map((r) => r.section)).toEqual(['A']);
    expect(out[0]?.text).toBe('body');
  });

  it('drops a title equal to the repo from the crumbs', () => {
    const [record] = records('# r\n\ntext');
    expect(record?.crumbs).toEqual(['r']);
  });

  it('matches GitHub anchors in the bioc-edge DATAPLANE.md fixture', () => {
    const markdown = readFileSync(
      join(import.meta.dirname, '../fixtures/docs/raw.githubusercontent.com/seandavi/bioc-edge/main/DATAPLANE.md'),
      'utf8',
    );
    const out = records(markdown, 'bioc-edge', 'DATAPLANE.md');
    const record = out.find((r) => r.id === 'repo:bioc-edge/DATAPLANE.md#cloudflare-workflows-v');
    expect(record?.crumbs).toEqual(['bioc-edge', 'A data plane for bioconductor.org', '1. Prior art']);
  });
});
