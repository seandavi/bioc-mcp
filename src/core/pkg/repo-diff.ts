import * as z from 'zod';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope, type Source } from '../../envelope';
import { CapabilityError } from '../../errors';
import {
  BIOC_REPOS,
  getBiocConfig,
  getPackagesFile,
  parsePackagesFile,
  type BiocRepo,
} from '../../upstreams/bioconductor';
import { sourceFor } from '../../upstreams/http';
import { getPropagationIndex, UNIVERSES, type Universe } from '../../upstreams/registry';
import { defineCapability } from '../capability';
import type { Deps } from '../deps';
import { compareRVersions } from './status';

export const REPO_DIFF_CATEGORIES = ['version_differs', 'only_registry', 'only_bioconductor'] as const;
export type RepoDiffCategory = (typeof REPO_DIFF_CATEGORIES)[number];

export const REPO_DIFF_REASONS = ['registry_newer', 'seeded_behind', 'gated_behind', 'incomparable'] as const;
export type RepoDiffReason = (typeof REPO_DIFF_REASONS)[number];

const ReasonSchema = z
  .enum(REPO_DIFF_REASONS)
  .describe(
    "Why the versions differ. 'registry_newer': the registry's version is newer, so r-universe (or bioc-build) " +
      "published it before bioconductor.org's build system did. 'seeded_behind': bioconductor.org is newer and the " +
      "registry entry was seeded from Bioconductor's release build; a seed is replaced only when r-universe builds a " +
      "newer version that passes the gate. 'gated_behind': bioconductor.org is newer and the registry entry is not " +
      'seeded, so the newer version has not passed the gate (pkg_status shows its r-universe build). ' +
      "'incomparable': the version strings differ but cannot be ordered",
  );

const RepoDiffItemSchema = z.object({
  package: z.string(),
  repo: z
    .enum(BIOC_REPOS)
    .nullable()
    .describe('bioconductor.org repository the package is in; null for only_registry'),
  registry_version: z.string().nullable().describe('Version in the propagation index; null for only_bioconductor'),
  bioconductor_version: z
    .string()
    .nullable()
    .describe("Version in that repository's src/contrib/PACKAGES; null for only_registry"),
  origin: z
    .string()
    .nullable()
    .describe(
      "The registry entry's origin: 'r-universe' or 'bioc-build' passed the gate, 'bioconductor' was seeded from " +
        "Bioconductor's release build; null for only_bioconductor",
    ),
  reason: ReasonSchema.nullable().describe('Set for version_differs; null otherwise'),
});
export type RepoDiffItem = z.infer<typeof RepoDiffItemSchema>;

const RepoCountsSchema = z.object({
  repo: z.enum(BIOC_REPOS),
  bioconductor_packages: z.number().int().describe("Packages in this repository's src/contrib/PACKAGES"),
  same_version: z.number().int().describe('Also in the propagation index, at the same version string'),
  version_differs: z.number().int().describe('Also in the propagation index, at a different version'),
  only_bioconductor: z.number().int().describe('Not in the propagation index'),
});
export type RepoCounts = z.infer<typeof RepoCountsSchema>;

export const PkgRepoDiffDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  bioconductor_version: z
    .string()
    .describe("Bioconductor version compared: config.yaml's devel_version for 'bioc', release_version for 'bioc-release'"),
  repo: z.enum(BIOC_REPOS).nullable().describe('The repository asked for; null when all four were compared'),
  counts: z
    .object({
      registry_packages: z.number().int().describe('Entries in the propagation index'),
      bioconductor_packages: z.number().int().describe('Packages in the compared repositories'),
      in_both: z.number().int().describe('same_version + version_differs'),
      same_version: z.number().int(),
      version_differs: z.number().int(),
      only_bioconductor: z.number().int(),
      only_registry: z
        .number()
        .int()
        .describe('Index entries in none of the four repositories; the same whichever repo is asked for'),
    })
    .describe('Over the compared repositories (repo, or all four)'),
  version_differs_by_reason: z
    .object({
      registry_newer: z.number().int(),
      seeded_behind: z.number().int(),
      gated_behind: z.number().int(),
      incomparable: z.number().int(),
    })
    .describe('counts.version_differs split by reason'),
  by_repo: z
    .array(RepoCountsSchema)
    .describe('One row per repository, always all four, in the order bioc, data-experiment, workflows, books'),
  category: z.enum(REPO_DIFF_CATEGORIES).describe('The list items is a page of'),
  items: z.array(RepoDiffItemSchema).describe('This page, sorted by package name (case-insensitive), then repository'),
  offset: z.number().int().nonnegative().describe('Position of the first item in the whole list'),
  total: z.number().int().nonnegative().describe('Length of the whole list for this category and repo'),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as cursor, with the same universe, repo and category, for the next page; null on the last page'),
});
type PkgRepoDiffData = z.infer<typeof PkgRepoDiffDataSchema>;

export interface RepoDiff {
  registryPackages: number;
  byRepo: RepoCounts[]; // BIOC_REPOS order
  lists: Record<RepoDiffCategory, RepoDiffItem[]>; // each sorted with compareItems
}

const DiffEntrySchema = z.object({ version: z.string(), origin: z.string().optional() });

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function repoRank(repo: BiocRepo | null): number {
  return repo === null ? BIOC_REPOS.length : BIOC_REPOS.indexOf(repo);
}

/** Case-insensitive package name, then exact name, then repository; code-unit order, never locale-dependent. */
function compareItems(a: RepoDiffItem, b: RepoDiffItem): number {
  return (
    compareStrings(a.package.toLowerCase(), b.package.toLowerCase()) ||
    compareStrings(a.package, b.package) ||
    repoRank(a.repo) - repoRank(b.repo)
  );
}

function reasonFor(registryVersion: string, bioconductorVersion: string, origin: string): RepoDiffReason {
  const cmp = compareRVersions(registryVersion, bioconductorVersion);
  if (cmp === 1) return 'registry_newer';
  if (cmp === -1) return origin === 'bioconductor' ? 'seeded_behind' : 'gated_behind';
  return 'incomparable';
}

/** Compare the index with one parsed PACKAGES per repository, given in BIOC_REPOS order. */
export function diffRepos(
  packages: Record<string, unknown>,
  files: readonly { repo: BiocRepo; versions: ReadonlyMap<string, string> }[],
  indexUrl: string,
): RepoDiff {
  const entries = new Map<string, { version: string; origin: string }>();
  for (const name of Object.keys(packages)) {
    const parsed = DiffEntrySchema.safeParse(packages[name]);
    if (!parsed.success) {
      throw new CapabilityError(
        'upstream_error',
        `Bioconductor propagation registry entry for ${name} has an unexpected shape`,
        { upstream: 'registry', url: indexUrl },
      );
    }
    entries.set(name, { version: parsed.data.version, origin: parsed.data.origin ?? 'r-universe' });
  }

  const lists: Record<RepoDiffCategory, RepoDiffItem[]> = {
    version_differs: [],
    only_registry: [],
    only_bioconductor: [],
  };
  const byRepo: RepoCounts[] = [];
  const inSomeRepo = new Set<string>();

  for (const { repo, versions } of files) {
    const counts: RepoCounts = {
      repo,
      bioconductor_packages: versions.size,
      same_version: 0,
      version_differs: 0,
      only_bioconductor: 0,
    };
    for (const [name, bioconductorVersion] of versions) {
      inSomeRepo.add(name);
      const entry = entries.get(name);
      if (entry === undefined) {
        counts.only_bioconductor++;
        lists.only_bioconductor.push({
          package: name,
          repo,
          registry_version: null,
          bioconductor_version: bioconductorVersion,
          origin: null,
          reason: null,
        });
      } else if (entry.version === bioconductorVersion) {
        counts.same_version++;
      } else {
        counts.version_differs++;
        lists.version_differs.push({
          package: name,
          repo,
          registry_version: entry.version,
          bioconductor_version: bioconductorVersion,
          origin: entry.origin,
          reason: reasonFor(entry.version, bioconductorVersion, entry.origin),
        });
      }
    }
    byRepo.push(counts);
  }

  for (const [name, entry] of entries) {
    if (inSomeRepo.has(name)) continue;
    lists.only_registry.push({
      package: name,
      repo: null,
      registry_version: entry.version,
      bioconductor_version: null,
      origin: entry.origin,
      reason: null,
    });
  }

  for (const list of Object.values(lists)) list.sort(compareItems);
  return { registryPackages: entries.size, byRepo, lists };
}

// Keyed by the parsed index's `packages` object, which the registry memo shares for one load and
// drops when it expires, so a diff lives exactly as long as the index it was computed from.
const repoDiffs = new WeakMap<Record<string, unknown>, { key: string; diff: RepoDiff }>();

/** The diff for one universe, plus what was compared; memoized per propagation-index load and PACKAGES fetch. */
export async function loadRepoDiff(
  deps: Deps,
  universe: Universe,
): Promise<{ diff: RepoDiff; bioconductorVersion: string; sources: Source[] }> {
  const [index, compared] = await Promise.all([
    getPropagationIndex(deps, universe),
    getBiocConfig(deps).then(async ({ response, config }) => {
      const bioconductorVersion = universe === 'bioc' ? config.devel_version : config.release_version;
      const files = await Promise.all(BIOC_REPOS.map((repo) => getPackagesFile(deps, bioconductorVersion, repo)));
      return { configResponse: response, bioconductorVersion, files };
    }),
  ]);
  const { configResponse, bioconductorVersion, files } = compared;

  // A cached response keeps its fetchedAt, so the key changes only when a PACKAGES file is refetched.
  const key = [bioconductorVersion, ...files.map((r) => `${r.url} ${r.fetchedAt}`)].join('\n');
  let memo = repoDiffs.get(index.packages);
  if (memo?.key !== key) {
    memo = {
      key,
      diff: diffRepos(
        index.packages,
        files.map((response, i) => ({
          repo: BIOC_REPOS[i]!,
          versions: parsePackagesFile(response.body, response.url),
        })),
        index.response.url,
      ),
    };
    repoDiffs.set(index.packages, memo);
  }

  return {
    diff: memo.diff,
    bioconductorVersion,
    sources: [sourceFor(index.response), sourceFor(configResponse), ...files.map((response) => sourceFor(response))],
  };
}

function summarize(data: PkgRepoDiffData): string {
  const { universe, bioconductor_version: v, repo, counts, version_differs_by_reason: by, category } = data;
  const parts = [
    `${universe} (Bioconductor ${v} ${universe === 'bioc' ? 'devel' : 'release'}) against bioconductor.org ${v}, ` +
      `${repo === null ? 'all four repositories' : `repository ${repo}`}: ` +
      `${counts.same_version} of ${counts.bioconductor_packages} packages at the same version; ` +
      `${counts.version_differs} differ (registry newer: ${by.registry_newer}, seeded behind: ${by.seeded_behind}, ` +
      `gated behind: ${by.gated_behind}${by.incomparable > 0 ? `, not comparable: ${by.incomparable}` : ''}); ` +
      `${counts.only_bioconductor} only on bioconductor.org; ${counts.only_registry} only in the registry.`,
  ];
  const software = data.by_repo.find((r) => r.repo === 'bioc');
  if (repo === null && software) {
    parts.push(`Software (bioc): ${software.same_version} of ${software.bioconductor_packages} at the same version.`);
  }
  if (data.total === 0) {
    parts.push(`No ${category} packages.`);
  } else {
    const end = data.offset + data.items.length;
    parts.push(
      `Showing ${category} ${data.offset + 1}–${end} of ${data.total}` +
        (data.next_cursor === null ? '.' : `; call again with cursor "${data.next_cursor}" for more.`),
    );
  }
  return parts.join(' ');
}

export const pkgRepoDiff = defineCapability({
  module: 'pkg',
  name: 'pkg_repo_diff',
  title: 'Registry vs bioconductor.org repositories',
  description:
    "How far the registry's propagation index agrees with bioconductor.org's own repositories, for one " +
    "universe ('bioc' devel, default; 'bioc-release' release) against the Bioconductor version config.yaml " +
    'maps it to: how many packages are in both at the same version, at a different version, only on ' +
    'bioconductor.org, or only in the registry, per repository (bioc software, data-experiment, workflows, books; ' +
    'the registry carries no annotation packages). Says why versions differ where the index shows it (registry ' +
    'newer, seeded entry behind, gated entry behind) and lists one category at a time with both versions, paged ' +
    "with cursor. For one package's propagation and build state, and why it is behind, use pkg_status; for the " +
    'release and devel version numbers use pkg_release_info.',
  input: z.object({
    universe: z
      .enum(UNIVERSES)
      .default('bioc')
      .describe("'bioc' is Bioconductor devel (default); 'bioc-release' is the current release"),
    repo: z
      .enum(BIOC_REPOS)
      .optional()
      .describe("One bioconductor.org repository; omit to compare all four. 'bioc' is software"),
    category: z
      .enum(REPO_DIFF_CATEGORIES)
      .default('version_differs')
      .describe('Which list to page through; the counts cover every category whichever is chosen'),
    cursor: z
      .string()
      .regex(/^\d{1,6}$/, 'cursor must be the next_cursor of a previous pkg_repo_diff call')
      .optional()
      .describe('next_cursor from the previous call (same universe, repo and category), for the next page'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum packages in this page (1–50); fewer are returned if the page would pass the size limit'),
  }),
  data: PkgRepoDiffDataSchema,
  async handler({ universe, repo, category, cursor, limit }, deps) {
    const { diff, bioconductorVersion, sources } = await loadRepoDiff(deps, universe);

    const rows = repo === undefined ? diff.byRepo : diff.byRepo.filter((r) => r.repo === repo);
    const inRepo = (item: RepoDiffItem) => repo === undefined || item.repo === repo;
    const versionDiffers = diff.lists.version_differs.filter(inRepo);
    const onlyBioconductor = diff.lists.only_bioconductor.filter(inRepo);
    const onlyRegistry = diff.lists.only_registry;

    const sum = (pick: (row: RepoCounts) => number) => rows.reduce((total, row) => total + pick(row), 0);
    const sameVersion = sum((r) => r.same_version);
    const versionDiffersCount = sum((r) => r.version_differs);
    const byReason = { registry_newer: 0, seeded_behind: 0, gated_behind: 0, incomparable: 0 };
    for (const item of versionDiffers) byReason[item.reason!]++;

    const list = { version_differs: versionDiffers, only_registry: onlyRegistry, only_bioconductor: onlyBioconductor }[
      category
    ];
    const total = list.length;
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (offset > total || (offset === total && offset > 0)) {
      throw new CapabilityError(
        'invalid_input',
        `cursor ${cursor} is past the end of the ${category} list (${total} packages); start again without cursor`,
      );
    }

    const build = (count: number): Envelope<PkgRepoDiffData> => {
      const items = list.slice(offset, offset + count);
      const data: PkgRepoDiffData = {
        universe,
        bioconductor_version: bioconductorVersion,
        repo: repo ?? null,
        counts: {
          registry_packages: diff.registryPackages,
          bioconductor_packages: sum((r) => r.bioconductor_packages),
          in_both: sameVersion + versionDiffersCount,
          same_version: sameVersion,
          version_differs: versionDiffersCount,
          only_bioconductor: sum((r) => r.only_bioconductor),
          only_registry: onlyRegistry.length,
        },
        version_differs_by_reason: byReason,
        by_repo: diff.byRepo,
        category,
        items,
        offset,
        total,
        next_cursor: offset + items.length < total ? String(offset + items.length) : null,
      };
      return { data, summary: summarize(data), sources };
    };

    let count = limit;
    let envelope = build(count);
    while (envelopeBytes(envelope) > MAX_RESULT_BYTES && envelope.data.items.length > 1) {
      count = envelope.data.items.length - 1;
      envelope = build(count);
    }
    return envelope;
  },
});
