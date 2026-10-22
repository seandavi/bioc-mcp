import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import { jsonTextBytes, normalizeText } from '../../../src/core/pkg/check-log';
import { pkgCheckOutput, PkgCheckOutputDataSchema } from '../../../src/core/pkg/check-output';
import { invokeCapability } from '../../../src/core/invoke';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { checksUrl, pkgRoutes } from '../../support/pkg-routes';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testContext } from '../../support/invoke-context';

type Data = z.output<typeof PkgCheckOutputDataSchema>;
type Input = { universe: string; job: string; file?: string; full?: boolean; offset?: number };

const NOW = '2026-10-22T12:00:00.000Z';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'registry', 'checks');

async function run(input: Input, routes: Record<string, FixtureRoute> = pkgRoutes) {
  const fetch = fixtureFetch(routes);
  const now = () => new Date(NOW);
  const result = await invokeCapability(pkgCheckOutput, input, { fetch, cache: createMemoryCache(now), now, env: {} }, testContext());
  return { result, fetch };
}

async function checkOutput(input: Input, routes?: Record<string, FixtureRoute>) {
  const { result, fetch } = await run(input, routes);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  return { envelope, data: envelope.data, summary: envelope.summary, fetch };
}

async function failure(input: Input, routes?: Record<string, FixtureRoute>) {
  const { result, fetch } = await run(input, routes);
  if (result.ok) throw new Error('expected an error');
  return { error: result.error, fetch };
}

function fixtureFile(universe: string, job: string, file: string): string {
  const files = JSON.parse(readFileSync(join(FIXTURES, universe, `${job}.json`), 'utf8')) as Record<string, string>;
  return files[file]!;
}

describe('failing check excerpt (yarn)', () => {
  test('returns the ERROR section, the status and the job info', async () => {
    const { data, summary, envelope, fetch } = await checkOutput({ universe: 'bioc', job: '96299707840' });
    expect(data.view).toBe('sections');
    expect(data.check).toMatchObject({ status: 'Status: 1 ERROR', errors: 1, warnings: 0, notes: 0, sections_omitted: 0 });
    expect(data.check!.sections).toHaveLength(1);
    expect(data.check!.sections[0]).toMatchObject({ check: 'checking examples', verdict: 'ERROR', truncated: false });
    expect(data.check!.sections[0]!.text.endsWith('Execution halted')).toBe(true);
    expect(data.text).toBeNull();
    expect(data.job_info).toEqual({
      package: 'yarn',
      version: '1.39.0',
      target: 'linux',
      job_status: 'failure',
      check_status: 'ERROR',
    });
    expect(data.files).toEqual(['00check.log', '00install.out', 'pkgdata.txt', 'testthat.Rout', 'yarn-Ex.Rout']);
    expect(data.files_total).toBe(5);
    expect(data.job_url).toBe('https://github.com/r-universe/bioc/runs/96299707840');
    expect(summary).toContain('yarn 1.39.0 bioc job 96299707840 (linux)');
    expect(summary).toContain('Status: 1 ERROR');
    expect(summary).toContain('checking examples (ERROR)');
    expect(summary).not.toContain('cut to fit');
    expect(envelope.sources).toEqual([{ url: checksUrl('bioc', '96299707840'), as_of: NOW }]);
    expect(fetch.calls).toEqual([checksUrl('bioc', '96299707840')]);
  });
});

describe('passing check with CRLF (ADAPT)', () => {
  test('Status: OK, no sections, no carriage returns anywhere', async () => {
    const { data, envelope } = await checkOutput({ universe: 'bioc', job: '91456856197' });
    expect(fixtureFile('bioc', '91456856197', '00check.log')).toContain('\r\n');
    expect(data.check).toMatchObject({ status: 'Status: OK', errors: 0, warnings: 0, notes: 0, sections: [] });
    expect(JSON.stringify(envelope)).not.toContain('\\r');
    expect(data.job_info).toMatchObject({ package: 'ADAPT', version: '1.7.0', target: 'windows' });
  });
});

describe('truncation', () => {
  test('GeneGA: sections stay in log order and only the 2,817-byte NOTE is cut', async () => {
    const { data, summary } = await checkOutput({ universe: 'bioc', job: '91651624908' });
    expect(data.check!.status).toBe('Status: 1 ERROR, 2 WARNINGs, 5 NOTEs');
    expect(data.check!.sections.map((s) => s.verdict)).toEqual([
      'NOTE',
      'NOTE',
      'NOTE',
      'NOTE',
      'NOTE',
      'WARNING',
      'ERROR',
      'WARNING',
    ]);
    expect(data.check!.sections.filter((s) => s.truncated).map((s) => s.check)).toEqual([
      'checking R code for possible problems',
    ]);
    expect(data.check!.sections[6]!.truncated).toBe(false);
    expect(summary).toContain('Some output was cut to fit; read the whole log with full=true.');
    expect(summary).toContain('and 3 more');
  });

  test('singIST: the huge ERROR keeps 2 head lines, a marker and the tail', async () => {
    const { data } = await checkOutput({ universe: 'bioc', job: '95858209718' });
    const section = data.check!.sections[0]!;
    const full = normalizeText(fixtureFile('bioc', '95858209718', '00check.log'));
    const lines = full.slice(full.indexOf('* checking examples')).split('\n').slice(1);
    expect(section).toMatchObject({ check: 'checking examples', verdict: 'ERROR', truncated: true });
    expect(section.text.split('\n').slice(0, 2)).toEqual(lines.slice(0, 2));
    expect(section.text).toContain('lines omitted; read them with full=true');
    expect(section.text.endsWith('Execution halted')).toBe(true);
    expect(jsonTextBytes(section.text)).toBeLessThanOrEqual(2000);
  });
});

describe('tail and paging (stJoincount testthat.Rout.fail)', () => {
  const input = { universe: 'bioc', job: '91484882071', file: 'testthat.Rout.fail' };
  const whole = () => normalizeText(fixtureFile('bioc', '91484882071', 'testthat.Rout.fail'));

  test('the tail view starts mid-file and ends with the last character', async () => {
    const { data, summary } = await checkOutput(input);
    expect(data.view).toBe('tail');
    expect(data.check).toBeNull();
    expect(data.text!.total_chars).toBe(6146);
    expect(data.text!.offset).toBeGreaterThan(0);
    expect(data.text!.next_offset).toBeNull();
    expect(data.text!.text.endsWith(whole().slice(-1))).toBe(true);
    expect(whole().slice(data.text!.offset)).toBe(data.text!.text);
    expect(summary).toContain('read from the start with full=true');
  });

  test('full=true pages chain and concatenate to the file', async () => {
    const first = (await checkOutput({ ...input, full: true })).data.text!;
    expect(first.offset).toBe(0);
    expect(first.next_offset).not.toBeNull();
    const second = (await checkOutput({ ...input, full: true, offset: first.next_offset! })).data.text!;
    expect(second.offset).toBe(first.next_offset);
    expect(second.next_offset).toBeNull();
    expect(first.text + second.text).toBe(whole());
    const summary = (await checkOutput({ ...input, full: true })).summary;
    expect(summary).toContain(`Next page: offset=${first.next_offset}.`);
    expect((await checkOutput({ ...input, full: true, offset: first.next_offset! })).summary).toContain('End of file.');
  });

  test('offset without full=true is invalid_input and fetches nothing', async () => {
    const { error, fetch } = await failure({ ...input, offset: 5 });
    expect(error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('offset at the end of the file is invalid_input', async () => {
    const { error } = await failure({ ...input, full: true, offset: 6146 });
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('6146');
  });
});

describe('bioc-checks job without 00check.log (DeepTarget)', () => {
  test('the default file is not_found and lists both files', async () => {
    const { error } = await failure({ universe: 'bioc', job: '91902836490' });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('00BiocCheck.log, output.log');
  });

  test('output.log comes back whole as a tail, with no job_info', async () => {
    const { data } = await checkOutput({ universe: 'bioc', job: '91902836490', file: 'output.log' });
    expect(data.job_info).toBeNull();
    expect(data.view).toBe('tail');
    expect(data.text).toMatchObject({ offset: 0, next_offset: null, total_chars: 4371 });
    expect(data.text!.text).toContain('✖ 1 ERRORS');
  });
});

test('bioc-release job', async () => {
  const { data, envelope } = await checkOutput({ universe: 'bioc-release', job: '91650205691' });
  expect(data.check).toMatchObject({ status: 'Status: 1 WARNING, 1 NOTE', errors: 0, warnings: 1, notes: 1 });
  expect(data.job_info).toMatchObject({ package: 'scTreeViz', target: 'linux' });
  expect(envelope.sources[0]!.url).toBe(checksUrl('bioc-release', '91650205691'));
});

describe('errors', () => {
  test('a job the registry never captured is not_found, with the capture explanation', async () => {
    const { error } = await failure({ universe: 'bioc', job: '112702240220' });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('has no captured check output');
    expect(error.message).toContain('may not be captured yet or may never be');
    expect(error.message).toContain('https://github.com/r-universe/bioc/runs/112702240220');
    expect(error.details.status).toBe(404);
  });

  test('the wrong universe is not_found', async () => {
    const { error } = await failure({ universe: 'bioc', job: '91650205691' });
    expect(error.code).toBe('not_found');
  });

  test.each(['../00check.log', 'constructor', '__proto__', '00check.log/x', 'toString'])(
    'file %j is not_found, lists the files and reaches no URL',
    async (file) => {
      const { error, fetch } = await failure({ universe: 'bioc', job: '96299707840', file });
      expect(error.code).toBe('not_found');
      expect(error.message).toContain('00check.log, 00install.out, pkgdata.txt, testthat.Rout, yarn-Ex.Rout');
      expect(fetch.calls).toEqual([checksUrl('bioc', '96299707840')]);
    },
  );

  test('a file named __proto__ in the response is readable', async () => {
    const url = checksUrl('bioc', '5');
    const routes = { [url]: { status: 200, body: '{"__proto__":"hello","pkgdata.txt":""}' } };
    const { data } = await checkOutput({ universe: 'bioc', job: '5', file: '__proto__' }, routes);
    expect(data.text!.text).toBe('hello');
  });

  test.each([
    ['an array', '[]'],
    ['a non-string value', '{"00check.log":5}'],
    ['null', 'null'],
  ])('upstream returning %s is upstream_error', async (_name, body) => {
    const url = checksUrl('bioc', '5');
    const { error } = await failure({ universe: 'bioc', job: '5' }, { [url]: { status: 200, body } });
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('not an object of file texts');
  });

  test('a 500 is upstream_error', async () => {
    const url = checksUrl('bioc', '5');
    const { error } = await failure({ universe: 'bioc', job: '5' }, { [url]: { status: 500 } });
    expect(error.code).toBe('upstream_error');
  });
});

describe('size budget', () => {
  test('15 long sections and 40 long file names still fit, at a smaller budget', async () => {
    const longLine = (n: number) => `line ${n} ${'x'.repeat(120)}`;
    const body = Array.from({ length: 30 }, (_, n) => longLine(n)).join('\n');
    const log =
      Array.from({ length: 15 }, (_, i) => `* checking step ${i} ... ${i < 3 ? 'ERROR' : 'NOTE'}\n${body}`).join('\n') +
      '\nStatus: 3 ERRORs, 12 NOTEs\n';
    const files: Record<string, string> = { '00check.log': log, 'pkgdata.txt': "FILE='x_1.0.tar.gz'\nTARGET='linux'\n" };
    for (let i = 0; i < 40; i++) files[`${'long-file-name-'.repeat(4)}${String(i).padStart(2, '0')}.Rout`] = 'x';
    const url = checksUrl('bioc', '7');
    const routes = { [url]: { status: 200, body: JSON.stringify(files) } };

    const { envelope, data } = await checkOutput({ universe: 'bioc', job: '7' }, routes);
    expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(data.files).toHaveLength(40);
    expect(data.files_total).toBe(42);
    expect(data.check!.sections).toHaveLength(12);
    expect(data.check!.sections_omitted).toBe(3);
    const total = data.check!.sections.reduce((sum, s) => sum + jsonTextBytes(s.text), 0);
    expect(total).toBeLessThan(4500); // a smaller budget than the first one was needed
  });
});

describe('every fixture scenario fits the limit', () => {
  test.each([
    ['bioc', '96299707840', undefined],
    ['bioc', '91456856197', undefined],
    ['bioc', '91651624908', undefined],
    ['bioc', '95858209718', undefined],
    ['bioc', '91484882071', 'testthat.Rout.fail'],
    ['bioc', '91902836490', 'output.log'],
    ['bioc-release', '91650205691', undefined],
  ])('%s %s %s', async (universe, job, file) => {
    const { envelope } = await checkOutput({ universe, job, ...(file ? { file } : {}) });
    expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });
});
