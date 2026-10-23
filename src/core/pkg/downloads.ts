import * as z from 'zod';
import { CapabilityError } from '../../errors';
import {
  BIOCONDUCTOR_BASE_URL,
  findStatsPage,
  getStatsTab,
  MONTHS,
  STATS_CATEGORIES,
  statsTabPath,
  type StatsPage,
} from '../../upstreams/bioconductor';
import { sourceFor } from '../../upstreams/http';
import { defineCapability } from '../capability';
import { PackageNameSchema } from './package-name';

const CountsSchema = z.object({
  distinct_ips: z.number().int().describe('Distinct client IP addresses'),
  downloads: z.number().int().describe('Package downloads'),
});

export const PkgDownloadsDataSchema = z.object({
  package: z.string(),
  category: z
    .enum(STATS_CATEGORIES)
    .describe("Stats category: 'bioc' (software), 'data-annotation', 'data-experiment' or 'workflows'"),
  year: z.number().int().describe('The year these figures are for'),
  year_requested: z.number().int().nullable().describe('The year asked for; null when it was defaulted'),
  data_as_of: z
    .string()
    .nullable()
    .describe('Date bioconductor.org computed these stats (YYYY-MM-DD); null if the stats page does not say'),
  months: z
    .array(CountsSchema.extend({ month: z.enum(MONTHS) }))
    .describe('Calendar months in order; months after data_as_of are omitted (the file holds 0 placeholders for them)'),
  partial_month: z
    .enum(MONTHS)
    .nullable()
    .describe('The month containing data_as_of, whose counts cover only part of it; null for a finished year'),
  total: CountsSchema.describe(
    "The file's yearly 'all' row. distinct_ips counts each IP once per year, so it is less than the sum of the monthly distinct_ips",
  ),
  years_available: z.array(z.number().int()).describe('Years with stats for this package, ascending'),
  note: z.string().nullable().describe('Set when the year was defaulted to an earlier one'),
  definition: z.string().describe('What the numbers count, and where they are documented'),
  stats_page_url: z.string().describe("bioconductor.org's stats page for this package"),
});
type PkgDownloadsData = z.infer<typeof PkgDownloadsDataSchema>;

export const STATS_DEFINITION =
  "Bioconductor's published /packages/stats figures (https://bioconductor.org/packages/stats/): per calendar " +
  'month, package downloads and distinct client IP addresses from bioconductor.org. They do not separate ' +
  'people from automated clients. bioc-traffic recomputes them from the access logs on the same definition ' +
  'and documents where they differ: https://github.com/seandavi/bioc-traffic/blob/main/docs/published-comparison.md';

/** The year to show and, when it was defaulted to an earlier one, why. Throws not_found if there is none. */
function chooseYear(
  name: string,
  page: StatsPage,
  requested: number | undefined,
  current: number,
): { year: number; note: string | null } {
  const { years } = page;
  if (years.length === 0) {
    throw new CapabilityError('not_found', `${name} (${page.category}) has no yearly download stats on bioconductor.org.`);
  }
  if (requested !== undefined) {
    if (!years.includes(requested)) {
      throw new CapabilityError(
        'not_found',
        `${name} (${page.category}) has no download stats for ${requested}; years with stats: ${years[0]}–${years.at(-1)}.`,
      );
    }
    return { year: requested, note: null };
  }
  if (years.includes(current)) return { year: current, note: null };
  // The January case: a year's file appears only once that year has downloads in a stats run.
  const year = years.findLast((y) => y < current) ?? years.at(-1)!;
  return {
    year,
    note: `bioconductor.org has no ${current} download stats for ${name} yet; showing ${year}, the latest year with stats.`,
  };
}

function summarize(name: string, data: PkgDownloadsData): string {
  const { category, year, total, partial_month, data_as_of, note } = data;
  return (
    `${name} (${category}) in ${year}: ${String(total.downloads)} downloads from ${String(total.distinct_ips)} distinct IPs` +
    (partial_month ? ` through ${data_as_of}` : '') +
    '.' +
    (note ? ` ${note}` : '') +
    " Figures follow bioconductor.org's published /packages/stats definition."
  );
}

export const pkgDownloads = defineCapability({
  module: 'pkg',
  name: 'pkg_downloads',
  title: 'Package download stats',
  description:
    'Monthly download counts for one Bioconductor package in one calendar year, as bioconductor.org publishes ' +
    'them at /packages/stats: distinct IPs and downloads per month and for the year, with the date the stats ' +
    'were computed (data_as_of). Finds the package among software (bioc), annotation, experiment-data and ' +
    'workflow packages. year defaults to the current year, or the latest year with stats when the current ' +
    'year has none yet (early January). Package names are case-sensitive. Does not separate people from ' +
    'automated clients or give per-version or per-country counts. For build or propagation state use ' +
    'pkg_status; for release versions use pkg_release_info. ' +
    'For why or how the infrastructure works this way (design, ADRs, runbooks) use docs_search.',
  input: z.object({
    package: PackageNameSchema,
    year: z
      .number()
      .int()
      .min(2009)
      .max(2100)
      .optional()
      .describe(
        'Calendar year (stats start in 2009); default: the current year, or the latest year with stats if it has none yet',
      ),
  }),
  data: PkgDownloadsDataSchema,
  async handler({ package: name, year: requested }, deps) {
    const page = await findStatsPage(deps, name);
    if (!page) {
      throw new CapabilityError(
        'not_found',
        `No download stats for "${name}" in any Bioconductor category (${STATS_CATEGORIES.join(', ')}). ` +
          'Package names are case-sensitive.',
      );
    }
    const { year, note } = chooseYear(name, page, requested, deps.now().getUTCFullYear());
    const tab = await getStatsTab(deps, page.category, name, year);
    if (!tab) {
      throw new CapabilityError(
        'upstream_error',
        `bioconductor.org lists ${year} stats for ${name} but has no stats file for it`,
        {
          upstream: 'bioconductor',
          url: new URL(statsTabPath(page.category, name, year), BIOCONDUCTOR_BASE_URL).href,
        },
      );
    }

    // The file holds 0 placeholders for the months after data_as_of; leave them out.
    const asOf =
      page.dataAsOf === null
        ? null
        : { year: Number(page.dataAsOf.slice(0, 4)), month: Number(page.dataAsOf.slice(5, 7)) - 1 };
    const partial = asOf !== null && asOf.year === year;
    const data: PkgDownloadsData = {
      package: name,
      category: page.category,
      year,
      year_requested: requested ?? null,
      data_as_of: page.dataAsOf,
      months: partial ? tab.months.slice(0, asOf.month + 1) : tab.months,
      partial_month: partial ? MONTHS[asOf.month]! : null,
      total: tab.total,
      years_available: page.years,
      note,
      definition: STATS_DEFINITION,
      stats_page_url: page.url,
    };
    const asOfDate = page.dataAsOf ?? undefined;
    return {
      data,
      summary: summarize(name, data),
      sources: [sourceFor(page.response, asOfDate), sourceFor(tab.response, asOfDate)],
    };
  },
});
