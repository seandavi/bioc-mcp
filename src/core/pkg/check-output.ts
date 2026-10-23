import * as z from 'zod';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../envelope';
import { CapabilityError } from '../../errors';
import { sourceFor } from '../../upstreams/http';
import { getCheckFiles, jobUrl, UNIVERSES } from '../../upstreams/registry';
import { defineCapability } from '../capability';
import {
  MAX_SECTIONS,
  normalizeText,
  PAGE_BUDGETS,
  parseCheckLog,
  parseJobInfo,
  SECTION_BUDGETS,
  SECTION_VERDICTS,
  selectSections,
  tailPage,
  textPage,
  type ParsedCheckLog,
  type TextPage,
} from './check-log';
import { JobIdSchema, UniverseOfJobSchema } from './job';

const MAX_LISTED_FILES = 40;
const CHECK_LOG = '00check.log';

const JobInfoSchema = z.object({
  package: z.string().nullable(),
  version: z.string().nullable(),
  target: z.string().nullable().describe("'linux', 'macos', 'windows', 'source' or 'wasm'"),
  job_status: z.string().nullable().describe("r-universe's job result, 'success' or 'failure'"),
  check_status: z.string().nullable().describe("r-universe's check verdict for this job"),
});

const CheckSectionSchema = z.object({
  check: z.string().describe("The R CMD check step, e.g. 'checking examples'"),
  verdict: z.enum(SECTION_VERDICTS),
  offset: z
    .number()
    .int()
    .describe(
      "Character offset in the normalized 00check.log where this step's output starts; pass it as offset with full=true to read the step whole",
    ),
  text: z.string().describe('What R CMD check printed under this step'),
  truncated: z
    .boolean()
    .describe('true if lines were cut to fit the size limit; the marker in text gives the offset to read them with full=true'),
});

const TextPageSchema = z.object({
  offset: z.number().int().describe('Character offset of this page in the file (CRLF → LF, ANSI colour codes removed)'),
  next_offset: z.number().int().nullable().describe('Pass as offset with full=true for the next page; null at end of file'),
  total_chars: z
    .number()
    .int()
    .describe('Length of the normalized file (CRLF → LF, ANSI removed), in the same units as offset'),
  text: z.string(),
});

export const PkgCheckOutputDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  job: z.string(),
  job_url: z.string().describe("GitHub Actions job page; the same page as pkg_status's jobs[].url, in its short form"),
  job_info: JobInfoSchema.nullable().describe("From the job's pkgdata.txt; null on bioc-checks jobs, which have none"),
  file: z.string(),
  view: z
    .enum(['sections', 'tail', 'page'])
    .describe("'sections': 00check.log's ERROR/WARNING/NOTE steps; 'tail': the end of another file; 'page': full=true"),
  check: z
    .object({
      status: z
        .string()
        .nullable()
        .describe("R CMD check's summary line, e.g. 'Status: 1 ERROR, 2 NOTEs'; null if the check did not finish"),
      errors: z.number().int().nullable(),
      warnings: z.number().int().nullable(),
      notes: z.number().int().nullable(),
      sections: z.array(CheckSectionSchema).describe('ERROR, WARNING and NOTE steps, in log order'),
      sections_omitted: z.number().int().describe(`Steps left out beyond the ${MAX_SECTIONS} most severe`),
    })
    .nullable()
    .describe("Set when view is 'sections'"),
  text: TextPageSchema.nullable().describe("Set when view is 'tail' or 'page'"),
  files: z.array(z.string()).describe(`The job's captured files, sorted, at most ${MAX_LISTED_FILES}`),
  files_total: z.number().int().describe(`Number of captured files; files lists at most ${MAX_LISTED_FILES}`),
});
type PkgCheckOutputData = z.infer<typeof PkgCheckOutputDataSchema>;

function summarize(data: PkgCheckOutputData): string {
  const { universe, job, job_info: info, file, view, check, text, files, files_total } = data;
  const subject = info?.package
    ? `${info.package}${info.version ? ' ' + info.version : ''} ${universe} job ${job}${info.target ? ` (${info.target})` : ''}`
    : `${universe} job ${job}`;
  const sentences: string[] = [];
  if (view === 'sections' && check) {
    sentences.push(`${subject}, ${CHECK_LOG}: ${check.status ?? 'no Status line, so the check did not finish'}.`);
    if (check.sections.length > 0) {
      const names = check.sections.slice(0, 5).map((s) => `${s.check} (${s.verdict})`);
      const more = check.sections.length > 5 ? ` and ${check.sections.length - 5} more` : '';
      sentences.push(`Sections: ${names.join('; ')}${more}.`);
    }
    if (check.sections.some((s) => s.truncated) || check.sections_omitted > 0) {
      sentences.push("Some output was cut to fit; each cut section's marker gives the offset to read it with full=true.");
    }
  } else if (view === 'tail' && text) {
    sentences.push(
      text.offset === 0
        ? `${subject}, ${file}: all ${text.total_chars} characters.`
        : `${subject}, ${file}: the last ${text.total_chars - text.offset} of ${text.total_chars} characters; read from the start with full=true.`,
    );
  } else if (text) {
    sentences.push(
      `${subject}, ${file}: characters ${text.offset}–${text.offset + text.text.length} of ${text.total_chars}.` +
        (text.next_offset === null ? ' End of file.' : ` Next page: offset=${text.next_offset}.`),
    );
  }
  sentences.push(`Files: ${files.join(', ')}${files_total > files.length ? ` and ${files_total - files.length} more` : ''}.`);
  return sentences.join(' ');
}

function listFiles(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_FILES);
  return shown.join(', ') + (names.length > shown.length ? ` and ${names.length - shown.length} more` : '');
}

export const pkgCheckOutput = defineCapability({
  module: 'pkg',
  name: 'pkg_check_output',
  title: 'R CMD check output for one build job',
  description:
    "Why an r-universe check failed: the ERROR, WARNING and NOTE sections of R CMD check's 00check.log " +
    "for one GitHub Actions job, the check's Status line, and the job's other captured files " +
    '(00install.out, <pkg>-Ex.Rout, testthat.Rout.fail, 00BiocCheck.log, output.log, …). ' +
    "bioc-checks jobs have no 00check.log; pass file='output.log' for BiocCheck's results. Get the job id " +
    'and universe from pkg_status (upstream.jobs[].job). Other files return their last ~5 KB; full=true ' +
    'returns any file one page at a time (offset). Only jobs the registry captured are available; ' +
    'others are not_found. For the image and dependency versions the job ran with, use ' +
    'pkg_build_environment.',
  input: z.object({
    universe: UniverseOfJobSchema,
    job: JobIdSchema,
    file: z
      .string()
      .min(1)
      .max(255)
      .default(CHECK_LOG)
      .describe(
        "Captured file to read, by basename (default '00check.log'); the result lists the job's files. " +
          "bioc-checks jobs have no 00check.log: use file='output.log' (BiocCheck's results). source jobs hold only pkgdata.txt",
      ),
    full: z
      .boolean()
      .default(false)
      .describe("true: return the file's text one page (~5 KB) at a time instead of the failing sections or tail"),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("With full=true: character offset to start at; pass the previous page's text.next_offset"),
  }),
  data: PkgCheckOutputDataSchema,
  async handler({ universe, job, file, full, offset }, deps) {
    if (!full && offset > 0) throw new CapabilityError('invalid_input', 'offset is used only with full=true');
    const { response, files } = await getCheckFiles(deps, universe, job);
    const names = Object.keys(files).sort(); // code-unit order
    if (!Object.hasOwn(files, file)) {
      throw new CapabilityError(
        'not_found',
        `${universe} job ${job} has no file "${file}". Its files: ${listFiles(names)}. Pass one of them as file.`,
      );
    }
    const text = normalizeText(files[file]!);
    if (full && offset > 0 && offset >= text.length) {
      throw new CapabilityError('invalid_input', `offset ${offset} is past the end of ${file} (${text.length} characters)`);
    }
    const jobInfo = Object.hasOwn(files, 'pkgdata.txt') ? parseJobInfo(files['pkgdata.txt']!) : null;
    const view = full ? 'page' : file === CHECK_LOG ? 'sections' : 'tail';
    const parsed: ParsedCheckLog | null = view === 'sections' ? parseCheckLog(text) : null;

    const build = (budget: number): Envelope<PkgCheckOutputData> => {
      let check: PkgCheckOutputData['check'] = null;
      let page: TextPage | null = null;
      if (parsed) {
        const selected = selectSections(parsed.sections, budget);
        check = {
          status: parsed.status,
          errors: parsed.errors,
          warnings: parsed.warnings,
          notes: parsed.notes,
          sections: selected.sections,
          sections_omitted: selected.omitted,
        };
      } else {
        page = view === 'page' ? textPage(text, offset, budget) : tailPage(text, budget);
      }
      const data: PkgCheckOutputData = {
        universe,
        job,
        job_url: jobUrl(universe, job),
        job_info: jobInfo,
        file,
        view,
        check,
        text: page,
        files: names.slice(0, MAX_LISTED_FILES),
        files_total: names.length,
      };
      return { data, summary: summarize(data), sources: [sourceFor(response)] };
    };

    const budgets: readonly number[] = view === 'sections' ? SECTION_BUDGETS : PAGE_BUDGETS;
    let envelope = build(budgets[0]!);
    for (const budget of budgets.slice(1)) {
      if (envelopeBytes(envelope) <= MAX_RESULT_BYTES) break;
      envelope = build(budget);
    }
    return envelope;
  },
});
