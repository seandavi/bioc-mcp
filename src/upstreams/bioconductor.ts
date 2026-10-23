import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { fetchUpstream, fetchUpstreamJson, pathSegment, type Upstream, type UpstreamResponse } from './http';
import { PackageNameSchema } from './package-name';

export const BIOCONDUCTOR_BASE_URL = 'https://bioconductor.org/';

export const bioconductorUpstream: Upstream = {
  id: 'bioconductor',
  name: 'bioconductor.org',
  baseUrl: BIOCONDUCTOR_BASE_URL,
  ttlSeconds: 3600, // proposal: stats 1 h, config.yaml and manifests 1 h
  description:
    'bioconductor.org: config.yaml (release and devel versions), the published manifest index, ' +
    'the source PACKAGES index of each repository, and package download stats (/packages/stats).',
};

const upstreamDetails = (url: string) => ({ upstream: bioconductorUpstream.id, url });

// config.yaml

export const BiocConfigSchema = z.object({
  release_version: z.string(),
  devel_version: z.string(),
  r_version_associated_with_release: z.string(),
  r_version_associated_with_devel: z.string(),
  release_dates: z.record(z.string(), z.string()).optional(),
});
export type BiocConfig = z.infer<typeof BiocConfigSchema>;

/**
 * GET config.yaml, parsed with the YAML failsafe schema so every scalar stays a string
 * (the core schema would turn an unquoted `3.30` into the number 3.3).
 */
export async function getBiocConfig(deps: Deps): Promise<{ response: UpstreamResponse; config: BiocConfig }> {
  const response = await fetchUpstream(deps, bioconductorUpstream, 'config.yaml');
  let doc: unknown;
  try {
    doc = parseYaml(response.body, { schema: 'failsafe', logLevel: 'error' });
  } catch {
    throw new CapabilityError(
      'upstream_error',
      'bioconductor.org returned a config.yaml that is not valid YAML',
      upstreamDetails(response.url),
    );
  }
  const parsed = BiocConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new CapabilityError(
      'upstream_error',
      'bioconductor.org config.yaml lacks the release and devel version keys',
      upstreamDetails(response.url),
    );
  }
  return { response, config: parsed.data };
}

// Manifest index

export const ManifestIndexSchema = z.object({
  generated: z.string(), // ISO 8601, e.g. '2026-10-22T17:45:18Z'
  versions: z.object({ release: z.string(), devel: z.string() }),
  build: z.string().optional(),
  manifest_prefix: z.string().optional(),
  manifests: z.array(
    z.object({ path: z.string(), objects: z.number().int(), without_hash: z.number().int() }),
  ),
  symlinks: z.record(z.string(), z.string()).optional(),
});
export type ManifestIndex = z.infer<typeof ManifestIndexSchema>;

/** GET api/v1/manifest/index.json. */
export async function getManifestIndex(deps: Deps): Promise<{ response: UpstreamResponse; index: ManifestIndex }> {
  const { response, json } = await fetchUpstreamJson(deps, bioconductorUpstream, 'api/v1/manifest/index.json');
  const parsed = ManifestIndexSchema.safeParse(json);
  if (!parsed.success) {
    throw new CapabilityError(
      'upstream_error',
      'bioconductor.org returned a manifest index with an unexpected shape',
      upstreamDetails(response.url),
    );
  }
  return { response, index: parsed.data };
}

// Source PACKAGES indexes

/** bioconductor.org repositories the registry carries packages for; data/annotation is not one (it has none). */
export const BIOC_REPOS = ['bioc', 'data-experiment', 'workflows', 'books'] as const;
export type BiocRepo = (typeof BIOC_REPOS)[number];

const BIOC_REPO_PATHS: Record<BiocRepo, string> = {
  bioc: 'bioc',
  'data-experiment': 'data/experiment',
  workflows: 'workflows',
  books: 'books',
};

const BIOC_VERSION = /^\d+\.\d+$/;

/** 'packages/{version}/{repo path}/src/contrib/PACKAGES'; version through pathSegment(), repo paths are constants. */
export function packagesPath(biocVersion: string, repo: BiocRepo): string {
  if (!BIOC_VERSION.test(biocVersion)) {
    throw new CapabilityError(
      'upstream_error',
      `bioconductor.org config.yaml names version "${biocVersion}", which is not of the form 3.24`,
      upstreamDetails(new URL('config.yaml', BIOCONDUCTOR_BASE_URL).href),
    );
  }
  return `packages/${pathSegment(biocVersion)}/${BIOC_REPO_PATHS[repo]}/src/contrib/PACKAGES`;
}

/** GET packages/{version}/{repo path}/src/contrib/PACKAGES. The body is parsed by the caller (parsePackagesFile). */
export async function getPackagesFile(deps: Deps, biocVersion: string, repo: BiocRepo): Promise<UpstreamResponse> {
  try {
    return await fetchUpstream(deps, bioconductorUpstream, packagesPath(biocVersion, repo));
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError(
        'upstream_error',
        `bioconductor.org has no ${BIOC_REPO_PATHS[repo]} PACKAGES for Bioconductor ${biocVersion} (${error.details.url})`,
        error.details,
      );
    }
    throw error;
  }
}

const PACKAGES_FIELD = /^([^\s:]+):[ \t]*(.*)$/;
const PACKAGES_VERSION = /^\d+([.-]\d+)*$/;

/** Package → Version from a PACKAGES (DCF) body, in file order; throws upstream_error (with `url`) on any deviation. */
export function parsePackagesFile(body: string, url: string): Map<string, string> {
  const malformed = () =>
    new CapabilityError(
      'upstream_error',
      `bioconductor.org returned a PACKAGES file in an unexpected format (${url})`,
      upstreamDetails(url),
    );
  const versions = new Map<string, string>();
  let packageNames: string[] = [];
  let packageVersions: string[] = [];
  let inStanza = false;

  const endStanza = () => {
    if (!inStanza) return;
    const name = packageNames[0];
    const version = packageVersions[0];
    if (
      packageNames.length !== 1 ||
      packageVersions.length !== 1 ||
      name === undefined ||
      version === undefined ||
      !PackageNameSchema.safeParse(name).success ||
      !PACKAGES_VERSION.test(version) ||
      versions.has(name)
    ) {
      throw malformed();
    }
    versions.set(name, version);
    packageNames = [];
    packageVersions = [];
    inStanza = false;
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      endStanza();
    } else if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!inStanza) throw malformed();
    } else {
      const match = PACKAGES_FIELD.exec(line);
      if (!match) throw malformed();
      inStanza = true;
      if (match[1] === 'Package') packageNames.push(match[2]!.trim());
      else if (match[1] === 'Version') packageVersions.push(match[2]!.trim());
    }
  }
  endStanza();
  return versions;
}

// Download stats

export const STATS_CATEGORIES = ['bioc', 'data-annotation', 'data-experiment', 'workflows'] as const;
export type StatsCategory = (typeof STATS_CATEGORIES)[number];

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export type Month = (typeof MONTHS)[number];

export interface StatsPage {
  response: UpstreamResponse;
  category: StatsCategory;
  url: string; // https://bioconductor.org/packages/stats/{category}/{name}/
  dataAsOf: string | null; // 'YYYY-MM-DD'
  years: number[]; // ascending, unique
}

/** GET packages/stats/{category}/{name}/ for each category in STATS_CATEGORIES order; the first 200 wins. */
export async function findStatsPage(deps: Deps, name: string): Promise<StatsPage | undefined> {
  for (const category of STATS_CATEGORIES) {
    let response: UpstreamResponse;
    try {
      response = await fetchUpstream(deps, bioconductorUpstream, `packages/stats/${category}/${pathSegment(name)}/`);
    } catch (error) {
      if (error instanceof CapabilityError && error.code === 'not_found') continue;
      throw error;
    }
    return {
      response,
      category,
      url: response.url,
      dataAsOf: parseDataAsOf(response.body),
      years: parseStatsYears(response.body, name),
    };
  }
  return undefined;
}

const DATA_AS_OF = /Data as of\s+(?:[A-Za-z]{3}\.?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/;

/** A real calendar date as 'YYYY-MM-DD', or null if month/day/year do not round-trip through Date.UTC. */
export function isoDate(year: number, monthIndex: number, day: number): string | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return null;
  return [
    String(year).padStart(4, '0'),
    String(monthIndex + 1).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

/** 'Data as of Thu. 22 Oct 2026' → '2026-10-22'; null if absent or not a real date. */
export function parseDataAsOf(html: string): string | null {
  const match = DATA_AS_OF.exec(html);
  if (!match) return null;
  const monthIndex = (MONTHS as readonly string[]).indexOf(match[2]!);
  if (monthIndex === -1) return null;
  return isoDate(Number(match[3]), monthIndex, Number(match[1]));
}

/** Years whose {name}_{year}_stats.tab the page links to, ascending and unique. */
export function parseStatsYears(html: string, name: string): number[] {
  const years = new Set<number>();
  // Compare names rather than building a regex from `name`: package names contain '.'.
  for (const match of html.matchAll(/href="([^"/]+)_(\d{4})_stats\.tab"/g)) {
    if (match[1] === name) years.add(Number(match[2]));
  }
  return [...years].sort((a, b) => a - b);
}

export interface StatsCounts {
  distinct_ips: number;
  downloads: number;
}
export interface StatsTab {
  response: UpstreamResponse;
  months: ({ month: Month } & StatsCounts)[]; // all 12, calendar order
  total: StatsCounts; // the 'all' row
}

/** 'packages/stats/{category}/{name}/{name}_{year}_stats.tab', each derived segment through pathSegment(). */
export function statsTabPath(category: StatsCategory, name: string, year: number): string {
  return `packages/stats/${category}/${pathSegment(name)}/${pathSegment(`${name}_${year}_stats.tab`)}`;
}

/** GET packages/stats/{category}/{name}/{name}_{year}_stats.tab; undefined on 404. */
export async function getStatsTab(
  deps: Deps,
  category: StatsCategory,
  name: string,
  year: number,
): Promise<StatsTab | undefined> {
  let response: UpstreamResponse;
  try {
    response = await fetchUpstream(deps, bioconductorUpstream, statsTabPath(category, name, year));
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') return undefined;
    throw error;
  }
  return { response, ...parseStatsTab(response.body, year, response.url) };
}

const STATS_TAB_HEADER = 'Year\tMonth\tNb_of_distinct_IPs\tNb_of_downloads';

/** Parse a .tab body; throws upstream_error (with `url`) on any deviation from the format. */
export function parseStatsTab(body: string, year: number, url: string): Omit<StatsTab, 'response'> {
  const malformed = () =>
    new CapabilityError(
      'upstream_error',
      `bioconductor.org returned a stats file in an unexpected format (${url})`,
      upstreamDetails(url),
    );
  const lines = body.split(/\r?\n/).filter((line) => line !== '');
  if (lines[0] !== STATS_TAB_HEADER) throw malformed();

  const byMonth = new Map<Month, StatsCounts>();
  let total: StatsCounts | undefined;
  for (const line of lines.slice(1)) {
    const fields = line.split('\t');
    if (fields.length !== 4) throw malformed();
    const [rowYear, rowMonth, ips, downloads] = fields as [string, string, string, string];
    if (rowYear !== String(year) || !/^\d+$/.test(ips) || !/^\d+$/.test(downloads)) throw malformed();
    const counts = { distinct_ips: Number(ips), downloads: Number(downloads) };
    if (rowMonth === 'all') {
      if (total) throw malformed();
      total = counts;
    } else {
      const month = MONTHS.find((m) => m === rowMonth);
      if (!month || byMonth.has(month)) throw malformed();
      byMonth.set(month, counts);
    }
  }
  if (!total || byMonth.size !== MONTHS.length) throw malformed();
  return { months: MONTHS.map((month) => ({ month, ...byMonth.get(month)! })), total };
}
