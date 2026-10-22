import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  fitSectionText,
  jsonTextBytes,
  MAX_SECTIONS,
  normalizeText,
  parseCheckLog,
  parseJobInfo,
  SECTION_MAX_BYTES,
  selectSections,
  tailPage,
  textPage,
  type CheckSection,
} from '../../../src/core/pkg/check-log';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'registry', 'checks', 'bioc');

function fixtureFile(job: string, file: string): string {
  const files = JSON.parse(readFileSync(join(FIXTURES, `${job}.json`), 'utf8')) as Record<string, string>;
  return files[file]!;
}

const checkLog = (job: string) => normalizeText(fixtureFile(job, '00check.log'));

describe('jsonTextBytes', () => {
  test.each([
    ['a', 1],
    ['\n', 2],
    ['‘', 3],
    ['\u0001', 6],
    ['😀', 4],
    ['"', 2],
    ['', 0],
  ] as const)('%j is %i bytes', (text, bytes) => {
    expect(jsonTextBytes(text)).toBe(bytes);
  });
});

describe('normalizeText', () => {
  test('CRLF and lone CR become LF', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  test('strips ANSI colour sequences', () => {
    expect(normalizeText('\x1b[1m✖\x1b[22m done')).toBe('✖ done');
  });
});

describe('parseCheckLog', () => {
  test('yarn: one ERROR section ending in Execution halted', () => {
    const parsed = parseCheckLog(checkLog('96299707840'));
    expect(parsed).toMatchObject({ status: 'Status: 1 ERROR', errors: 1, warnings: 0, notes: 0 });
    expect(parsed.sections).toHaveLength(1);
    const [section] = parsed.sections;
    expect(section).toMatchObject({ check: 'checking examples', verdict: 'ERROR' });
    expect(section!.text.split('\n')).toHaveLength(36);
    expect(section!.text.startsWith('Running examples in ‘yarn-Ex.R’ failed')).toBe(true);
    expect(section!.text.endsWith('Execution halted')).toBe(true);
    expect(jsonTextBytes(section!.text)).toBe(1558);
  });

  test('GeneGA: 8 sections in log order', () => {
    const parsed = parseCheckLog(checkLog('91651624908'));
    expect(parsed).toMatchObject({ status: 'Status: 1 ERROR, 2 WARNINGs, 5 NOTEs', errors: 1, warnings: 2, notes: 5 });
    expect(parsed.sections.map((s) => `${s.check} (${s.verdict})`)).toEqual([
      'checking for hidden files and directories (NOTE)',
      'checking DESCRIPTION meta-information (NOTE)',
      'checking whether the namespace can be loaded with stated dependencies (NOTE)',
      'checking dependencies in R code (NOTE)',
      'checking R code for possible problems (NOTE)',
      'checking files in ‘vignettes’ (WARNING)',
      'checking examples (ERROR)',
      'checking package vignettes (WARNING)',
    ]);
    expect(jsonTextBytes(parsed.sections[4]!.text)).toBe(2817);
    expect(jsonTextBytes(parsed.sections[6]!.text)).toBe(723);
  });

  test('ADAPT (CRLF): Status: OK and no sections', () => {
    const parsed = parseCheckLog(checkLog('91456856197'));
    expect(parsed).toEqual({ status: 'Status: OK', errors: 0, warnings: 0, notes: 0, sections: [] });
  });

  test('a log without a Status line has null counts', () => {
    const parsed = parseCheckLog('* using R\n* checking examples ... ERROR\nboom');
    expect(parsed).toEqual({
      status: null,
      errors: null,
      warnings: null,
      notes: null,
      sections: [{ check: 'checking examples', verdict: 'ERROR', text: 'boom' }],
    });
  });

  test('a verdict-less * line closes an open section', () => {
    const parsed = parseCheckLog(
      ['* checking foo ... NOTE', 'one', '', '* checking extension type ... Package', 'not part of the note', 'Status: 1 NOTE'].join('\n'),
    );
    expect(parsed.sections).toEqual([{ check: 'checking foo', verdict: 'NOTE', text: 'one' }]);
  });

  test('timing brackets are parsed', () => {
    const parsed = parseCheckLog('* checking examples ... [12s/16s] ERROR\nfailed\nStatus: 1 ERROR');
    expect(parsed.sections).toEqual([{ check: 'checking examples', verdict: 'ERROR', text: 'failed' }]);
  });

  test('OK, SKIPPED and INFO steps are not sections', () => {
    const parsed = parseCheckLog('* a ... OK\n* b ... SKIPPED\n* c ... INFO\ntext\nStatus: OK');
    expect(parsed.sections).toEqual([]);
  });

  test('counts singular and plural nouns', () => {
    const parsed = parseCheckLog('Status: 2 ERRORs, 1 WARNING, 3 NOTEs');
    expect([parsed.errors, parsed.warnings, parsed.notes]).toEqual([2, 1, 3]);
  });

  test('the last Status line wins', () => {
    expect(parseCheckLog('Status: 1 NOTE\nStatus: OK').status).toBe('Status: OK');
  });
});

describe('fitSectionText', () => {
  const body = Array.from({ length: 10 }, (_, i) => `line${i} ${'x'.repeat(40)}`);

  test('text that fits is unchanged', () => {
    expect(fitSectionText('a\nb', 10)).toEqual({ text: 'a\nb', truncated: false });
  });

  test('keeps 2 head lines, a marker and as many tail lines as fit', () => {
    const text = body.join('\n');
    const marker = (n: number) => `[… ${n} lines omitted; read them with full=true …]`;
    const keep5 = [body[0], body[1], marker(3), ...body.slice(5)].join('\n');
    const keep4 = [body[0], body[1], marker(4), ...body.slice(6)].join('\n');
    expect(fitSectionText(text, jsonTextBytes(keep5))).toEqual({ text: keep5, truncated: true });
    expect(fitSectionText(text, jsonTextBytes(keep5) - 1)).toEqual({ text: keep4, truncated: true });
  });

  test('head and marker only when no tail line fits', () => {
    const text = body.join('\n');
    const marker = '[… 8 lines omitted; read them with full=true …]';
    const headAndMarker = `${body[0]}\n${body[1]}\n${marker}`;
    expect(fitSectionText(text, jsonTextBytes(headAndMarker)).text).toBe(headAndMarker);
  });

  test('the marker alone when the head does not fit', () => {
    const text = `${'x'.repeat(200)}\n${'y'.repeat(200)}\nz\nz`;
    const marker = '[… 4 lines omitted; read them with full=true …]';
    expect(fitSectionText(text, jsonTextBytes(marker))).toEqual({ text: marker, truncated: true });
  });

  test('empty string when even the marker does not fit', () => {
    expect(fitSectionText('a\nb\nc\nd', 5)).toEqual({ text: '', truncated: true });
  });

  test('a section of two long lines becomes the marker', () => {
    const text = `${'x'.repeat(100)}\n${'y'.repeat(100)}`;
    const result = fitSectionText(text, 60);
    expect(result.text).toBe('[… 2 lines omitted; read them with full=true …]');
    expect(result.truncated).toBe(true);
  });
});

describe('selectSections', () => {
  test('GeneGA at budget 4500: log order, only the 2,817-byte NOTE is cut', () => {
    const sections = parseCheckLog(checkLog('91651624908')).sections;
    const { sections: selected, omitted } = selectSections(sections, 4500);
    expect(omitted).toBe(0);
    expect(selected.map((s) => s.check)).toEqual(sections.map((s) => s.check));
    expect(selected.filter((s) => s.truncated).map((s) => s.check)).toEqual(['checking R code for possible problems']);
    expect(selected[4]!.text).toContain('lines omitted; read them with full=true');
    expect(jsonTextBytes(selected[4]!.text)).toBeLessThanOrEqual(SECTION_MAX_BYTES);
    expect(selected[6]!.text).toBe(sections[6]!.text);
    expect(selected.reduce((sum, s) => sum + jsonTextBytes(s.text), 0)).toBeLessThanOrEqual(4500);
  });

  const synthetic = (verdicts: ('ERROR' | 'WARNING' | 'NOTE')[]): CheckSection[] =>
    verdicts.map((verdict, i) => ({ check: `step ${i}`, verdict, text: `${verdict} ${i}` }));

  test('at most 12 sections; ERRORs are kept before NOTEs', () => {
    const verdicts = [...Array(10).fill('NOTE'), 'ERROR', 'WARNING', 'ERROR', 'NOTE', 'NOTE'] as const;
    const sections = synthetic([...verdicts]);
    expect(sections).toHaveLength(15);
    const { sections: selected, omitted } = selectSections(sections, 4500);
    expect(selected).toHaveLength(MAX_SECTIONS);
    expect(omitted).toBe(3);
    expect(selected.filter((s) => s.verdict === 'ERROR')).toHaveLength(2);
    expect(selected.filter((s) => s.verdict === 'WARNING')).toHaveLength(1);
    // the three dropped are the last NOTEs (ties break by log order)
    expect(selected.map((s) => s.check)).not.toContain('step 14');
    expect(selected.map((s) => s.check)).not.toContain('step 13');
    expect(selected.map((s) => s.check)).not.toContain('step 9');
    const indices = selected.map((s) => Number(s.check.slice(5)));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('budget 0 replaces every text with a marker or nothing, all truncated', () => {
    const sections = parseCheckLog(checkLog('91651624908')).sections;
    const { sections: selected } = selectSections(sections, 0);
    expect(selected).toHaveLength(sections.length);
    for (const section of selected) {
      expect(section.truncated).toBe(true);
      expect(section.text).toBe('');
    }
  });
});

describe('textPage and tailPage', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join('\n');

  test('a page ends after a newline when that discards less than half', () => {
    const page = textPage(lines, 0, 100);
    expect(page.text.endsWith('\n')).toBe(true);
    expect(jsonTextBytes(page.text)).toBeLessThanOrEqual(100);
    expect(page.next_offset).toBe(page.text.length);
    expect(page.total_chars).toBe(lines.length);
  });

  test('pages chain and concatenate to the whole text', () => {
    let offset = 0;
    let rebuilt = '';
    for (let guard = 0; guard < 100; guard++) {
      const page = textPage(lines, offset, 100);
      expect(page.offset).toBe(offset);
      rebuilt += page.text;
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    expect(rebuilt).toBe(lines);
  });

  test('end of file has next_offset null', () => {
    const page = textPage('short', 0, 100);
    expect(page).toEqual({ offset: 0, next_offset: null, total_chars: 5, text: 'short' });
  });

  test('a line longer than the budget is split mid-line', () => {
    const page = textPage('x'.repeat(500), 0, 100);
    expect(page.text).toHaveLength(100);
    expect(page.next_offset).toBe(100);
  });

  test('never splits a surrogate pair', () => {
    const text = 'a' + '😀'.repeat(10);
    // budget 4 JSON bytes after 'a': the pair at index 1..2 costs 4 bytes, so 'a' + one emoji needs 5
    const page = textPage(text, 0, 5);
    expect(page.text).toBe('a😀');
    expect(page.next_offset).toBe(3);
    const odd = textPage('😀😀', 0, 6); // budget fits one pair and 2 bytes of the next only as an escape
    expect(odd.text).toBe('😀');
  });

  test('a page of control characters respects the byte budget', () => {
    const page = textPage('\u0001'.repeat(100), 0, 60);
    expect(jsonTextBytes(page.text)).toBeLessThanOrEqual(60);
    expect(page.text).toHaveLength(10);
  });

  test('tail page starts at a line when that is close', () => {
    const page = tailPage(lines, 100);
    expect(page.next_offset).toBeNull();
    expect(lines.slice(page.offset)).toBe(page.text);
    expect(page.offset).toBeGreaterThan(0);
    expect(lines[page.offset - 1]).toBe('\n');
    expect(jsonTextBytes(page.text)).toBeLessThanOrEqual(100);
    expect(page.text.endsWith('line number 39')).toBe(true);
  });

  test('tail of a short text is the whole text at offset 0', () => {
    expect(tailPage('abc', 100)).toEqual({ offset: 0, next_offset: null, total_chars: 3, text: 'abc' });
  });

  test('tail never starts inside a surrogate pair', () => {
    const text = '😀'.repeat(10);
    const page = tailPage(text, 6);
    expect(page.text).toBe('😀');
    expect(page.offset).toBe(18);
  });

  test('stJoincount testthat.Rout.fail: the tail starts mid-file and ends at the last character', () => {
    const text = normalizeText(fixtureFile('91484882071', 'testthat.Rout.fail'));
    expect(text).toHaveLength(6146);
    const page = tailPage(text, 5500);
    expect(page.offset).toBeGreaterThan(0);
    expect(text.endsWith(page.text)).toBe(true);
  });
});

describe('parseJobInfo', () => {
  const pkgdata = (file: string, extra = "TARGET='linux'\nCHECKSTATUS='OK'") =>
    `JOB_STATUS='success'\nDISTRO='resolute'\nFILE='${file}'\n${extra}\nSTOREDATE=20260820\n`;

  test('linux binary', () => {
    expect(parseJobInfo(pkgdata('yarn_1.39.0_R_x86_64-pc-linux-gnu.tar.gz'))).toEqual({
      package: 'yarn',
      version: '1.39.0',
      target: 'linux',
      job_status: 'success',
      check_status: 'OK',
    });
  });

  test.each([
    ['pwalign_1.9.1.zip', 'pwalign', '1.9.1'],
    ['S4Vectors_0.51.6.tgz', 'S4Vectors', '0.51.6'],
    ['PCAtools_2.25.0.tar.gz', 'PCAtools', '2.25.0'],
    ['RCurl_1.98-1.19.tar.gz', 'RCurl', '1.98-1.19'],
  ])('%s', (file, name, version) => {
    const info = parseJobInfo(pkgdata(file));
    expect([info.package, info.version]).toEqual([name, version]);
  });

  test("CHECKSTATUS='' is null", () => {
    expect(parseJobInfo(pkgdata('S4Vectors_0.51.6.tar.gz', "TARGET='source'\nCHECKSTATUS=''")).check_status).toBeNull();
  });

  test('a FILE that does not match gives null package and version', () => {
    const info = parseJobInfo(pkgdata('not-a-package.txt'));
    expect([info.package, info.version]).toEqual([null, null]);
    expect(info.target).toBe('linux');
  });

  test('a missing FILE gives null package and version', () => {
    expect(parseJobInfo("TARGET='wasm'\n")).toEqual({
      package: null,
      version: null,
      target: 'wasm',
      job_status: null,
      check_status: null,
    });
  });

  test('CRLF line endings', () => {
    expect(parseJobInfo(pkgdata('ADAPT_1.7.0.zip').replace(/\n/g, '\r\n')).package).toBe('ADAPT');
  });
});
