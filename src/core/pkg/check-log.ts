// Pure text helpers for pkg_check_output. No I/O. Every size is a JSON text size (jsonTextBytes),
// because the 8 KB limit applies to the serialized envelope.

import { jsonTextBytes } from '../../envelope';

/** CRLF/CR → LF, then strip ANSI CSI sequences. All offsets and lengths refer to this text. */
export function normalizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\r\n?/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export const SECTION_VERDICTS = ['ERROR', 'WARNING', 'NOTE'] as const;
export type SectionVerdict = (typeof SECTION_VERDICTS)[number];

export interface CheckSection {
  check: string; // e.g. 'checking examples', 'checking whether package ‘h5mread’ can be installed'
  verdict: SectionVerdict;
  offset: number; // where the body starts in the normalized text (the character after the header's '\n'), ≤ text.length
  text: string; // body lines joined with '\n', trailing empty lines removed
}

export interface ParsedCheckLog {
  status: string | null; // 'Status: 1 ERROR, 2 NOTEs'; null if absent
  errors: number | null; // null iff status is null
  warnings: number | null;
  notes: number | null;
  sections: CheckSection[]; // log order
}

const HEADER = /^\* (.+?) \.\.\.(?: \[[^\]]*\])? (OK|NOTE|WARNING|ERROR|SKIPPED|INFO|NONE)$/;
const STATUS_LINE = /^Status: /;
const MAX_HEADER_LINE_CHARS = 1000; // real step headers are well under 300 characters; HEADER is quadratic on long lines

function isSectionVerdict(verdict: string): verdict is SectionVerdict {
  return (SECTION_VERDICTS as readonly string[]).includes(verdict);
}

function countOf(status: string, noun: string): number {
  return Number(new RegExp(`(\\d+) ${noun}s?\\b`).exec(status)?.[1] ?? 0);
}

/** Split an R CMD check log (already normalized) into its ERROR, WARNING and NOTE steps. */
export function parseCheckLog(text: string): ParsedCheckLog {
  const sections: CheckSection[] = [];
  // The cast stops TypeScript narrowing `open` to null: close() assigns it.
  let open = null as { check: string; verdict: SectionVerdict; offset: number; body: string[] } | null;
  let status: string | null = null;

  const close = () => {
    if (open) {
      sections.push({
        check: open.check,
        verdict: open.verdict,
        offset: open.offset,
        text: open.body.join('\n').replace(/\n+$/, ''),
      });
      open = null;
    }
  };

  let lineStart = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('* ') || STATUS_LINE.test(line)) {
      close();
      if (STATUS_LINE.test(line)) status = line.trim();
      const match = line.length <= MAX_HEADER_LINE_CHARS ? HEADER.exec(line) : null;
      if (match && isSectionVerdict(match[2]!)) {
        open = { check: match[1]!, verdict: match[2], offset: Math.min(lineStart + line.length + 1, text.length), body: [] };
      }
    } else if (open) {
      open.body.push(line);
    }
    lineStart += line.length + 1;
  }
  close();

  if (status === null) return { status, errors: null, warnings: null, notes: null, sections };
  return {
    status,
    errors: countOf(status, 'ERROR'),
    warnings: countOf(status, 'WARNING'),
    notes: countOf(status, 'NOTE'),
    sections,
  };
}

export const SECTION_MAX_BYTES = 2000; // per-section cap
export const MAX_SECTIONS = 12;
export const SECTION_BUDGETS = [4500, 2500, 1000, 0] as const; // tried in order by the handler

export interface FittedSection extends CheckSection {
  truncated: boolean;
}

const omittedMarker = (lines: number, offset: number) =>
  `[… ${lines} lines omitted; read them with full=true and offset=${offset} …]`;

/**
 * Cut `text` to at most `maxBytes` (jsonTextBytes): its first 2 lines, a marker, then as many tail lines as fit.
 * `offset` is where `text` starts in the normalized log; the marker gives the offset of the first omitted line.
 */
export function fitSectionText(text: string, maxBytes: number, offset: number): { text: string; truncated: boolean } {
  if (jsonTextBytes(text) <= maxBytes) return { text, truncated: false };
  const lines = text.split('\n');
  const head = lines.slice(0, 2);
  const rest = lines.slice(2);
  const restOffset = offset + head.reduce((sum, line) => sum + line.length + 1, 0);
  const withTail = (k: number) =>
    [...head, omittedMarker(rest.length - k, restOffset), ...rest.slice(rest.length - k)].join('\n');

  // Each extra tail line adds at least 2 bytes and the marker loses at most 1, so size grows with k.
  let low = -1; // largest k known to fit
  let high = rest.length; // smallest k known not to fit (k < rest.length is the range)
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (jsonTextBytes(withTail(mid)) <= maxBytes) low = mid;
    else high = mid;
  }
  if (low >= 0) return { text: withTail(low), truncated: true };

  const marker = omittedMarker(lines.length, offset);
  return { text: jsonTextBytes(marker) <= maxBytes ? marker : '', truncated: true };
}

const SEVERITY_RANK: Record<SectionVerdict, number> = { ERROR: 0, WARNING: 1, NOTE: 2 };

/** Choose up to MAX_SECTIONS by severity, fit their text into `budget`, return them in log order. */
export function selectSections(
  sections: CheckSection[],
  budget: number,
): { sections: FittedSection[]; omitted: number } {
  const bySeverity = sections
    .map((_, index) => index)
    .sort((a, b) => SEVERITY_RANK[sections[a]!.verdict] - SEVERITY_RANK[sections[b]!.verdict] || a - b);
  const chosen = bySeverity.slice(0, MAX_SECTIONS);

  const fitted = new Map<number, FittedSection>();
  let remaining = budget;
  for (const index of chosen) {
    const section = sections[index]!;
    const allowance = Math.min(SECTION_MAX_BYTES, remaining);
    const { text, truncated } = fitSectionText(section.text, allowance, section.offset);
    remaining -= jsonTextBytes(text);
    fitted.set(index, { check: section.check, verdict: section.verdict, offset: section.offset, text, truncated });
  }
  return {
    sections: [...chosen].sort((a, b) => a - b).map((index) => fitted.get(index)!),
    omitted: sections.length - chosen.length,
  };
}

export const PAGE_BUDGETS = [5500, 3500, 1500] as const; // tried in order by the handler

export interface TextPage {
  offset: number; // start, in UTF-16 code units of the normalized text
  next_offset: number | null; // where the next page starts; null at end of file
  total_chars: number; // normalized text length
  text: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Page starting at `offset`. Caller validates offset. */
export function textPage(text: string, offset: number, budget: number): TextPage {
  // Largest end whose slice fits the budget (binary search; size grows with end).
  let low = offset;
  let high = Math.min(text.length, offset + budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonTextBytes(text.slice(offset, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let end = low;

  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  if (end < text.length) {
    const newline = text.lastIndexOf('\n', end - 1);
    if (newline + 1 > offset + Math.floor((end - offset) / 2)) end = newline + 1;
  }
  if (end === offset && offset < text.length) {
    end = isHighSurrogate(text.charCodeAt(offset)) && isLowSurrogate(text.charCodeAt(offset + 1)) ? offset + 2 : offset + 1;
  }
  return {
    offset,
    next_offset: end < text.length ? end : null,
    total_chars: text.length,
    text: text.slice(offset, end),
  };
}

/** Last page of `text` (next_offset is always null). */
export function tailPage(text: string, budget: number): TextPage {
  // Smallest start whose slice fits the budget (binary search; size shrinks as start grows).
  let low = Math.max(0, text.length - budget);
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (jsonTextBytes(text.slice(mid)) <= budget) high = mid;
    else low = mid + 1;
  }
  let start = low;

  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  if (start > 0) {
    const newline = text.indexOf('\n', start);
    if (newline !== -1 && newline + 1 - start <= Math.floor((text.length - start) / 2)) start = newline + 1;
  }
  return { offset: start, next_offset: null, total_chars: text.length, text: text.slice(start) };
}

export interface JobInfo {
  package: string | null;
  version: string | null;
  target: string | null; // 'linux' | 'macos' | 'windows' | 'source' | 'wasm' as observed
  job_status: string | null; // r-universe: 'success' | 'failure'
  check_status: string | null; // r-universe's verdict for this job: OK/NOTE/WARNING/ERROR
}

const PKGDATA_LINE = /^([A-Z_]+)=(.*)$/;
const PKGDATA_FILE = /^([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])_([0-9]+(?:[.-][0-9]+)*)(?:_R_[^/]*)?\.(?:tar\.gz|tgz|zip)$/;

/** Read the job's pkgdata.txt: KEY='value' lines. */
export function parseJobInfo(raw: string): JobInfo {
  const values = new Map<string, string>();
  for (const line of normalizeText(raw).split('\n')) {
    const match = PKGDATA_LINE.exec(line);
    if (!match) continue;
    values.set(match[1]!, match[2]!.replace(/^'(.*)'$/, '$1'));
  }
  const get = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === '' ? null : value;
  };
  const file = PKGDATA_FILE.exec(get('FILE') ?? '');
  return {
    package: file?.[1] ?? null,
    version: file?.[2] ?? null,
    target: get('TARGET'),
    job_status: get('JOB_STATUS'),
    check_status: get('CHECKSTATUS'),
  };
}
