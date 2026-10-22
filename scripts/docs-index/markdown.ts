import GithubSlugger from 'github-slugger';
import type { DocsRecord } from '../../src/docs-index/schema';

export interface MarkdownDocument {
  owner: string;
  repo: string;
  ref: string;
  file: string;
  markdown: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

interface Section {
  level: number; // 0 for the document-level section
  display: string;
  anchor: string;
  h2: string | undefined; // enclosing level-2 display text, for level-3 sections
  lines: string[];
}

function displayText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/** One Markdown file → records split at headings of level 1–3. */
export function markdownRecords(doc: MarkdownDocument): DocsRecord[] {
  const { owner, repo, ref, file } = doc;
  const slugger = new GithubSlugger();
  const documentLevel: Section = { level: 0, display: '', anchor: '', h2: undefined, lines: [] };
  const sections: Section[] = [documentLevel];
  let current = documentLevel;
  let title: string | undefined;
  let h2: string | undefined;
  let fence: { char: string; length: number } | undefined;

  for (const line of doc.markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = undefined;
      current.lines.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      fence = { char: open[0] as string, length: open.length };
      current.lines.push(line);
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    const level = (heading[1] as string).length;
    const display = displayText(heading[2] as string);
    const anchor = slugger.slug(display);
    if (level > 3) {
      current.lines.push(line);
    } else if (level === 1 && title === undefined) {
      title = display;
    } else {
      if (level === 1) h2 = undefined;
      if (level === 2) h2 = display;
      current = { level, display, anchor, h2: level === 3 ? h2 : undefined, lines: [] };
      sections.push(current);
    }
  }

  const documentTitle = title ?? `${repo}/${file}`;
  const baseCrumbs = documentTitle === repo ? [repo] : [repo, documentTitle];
  const fileUrl = `https://github.com/${owner}/${repo}/blob/${ref}/${file}`;
  const records: DocsRecord[] = [];
  for (const section of sections) {
    const text = section.lines
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (text === '') continue;
    const isDocument = section.level === 0;
    records.push({
      id: isDocument ? `repo:${repo}/${file}` : `repo:${repo}/${file}#${section.anchor}`,
      url: isDocument ? fileUrl : `${fileUrl}#${section.anchor}`,
      title: documentTitle,
      section: section.display,
      crumbs: section.h2 === undefined ? baseCrumbs : [...baseCrumbs, section.h2],
      text,
      source: 'repo',
      repo,
    });
  }
  return records;
}
