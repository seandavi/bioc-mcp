import * as z from 'zod';
import { sourceFor } from '../../upstreams/http';
import { getBiocConfig, getManifestIndex, isoDate, type BiocConfig, type ManifestIndex } from '../../upstreams/bioconductor';
import { defineCapability } from '../capability';

const VersionInfoSchema = z.object({
  version: z.string().describe('Bioconductor version, e.g. "3.23"'),
  r_version: z.string().describe("R version associated with it in config.yaml, e.g. '4.6.0'"),
  release_date: z
    .string()
    .nullable()
    .describe('Release date (YYYY-MM-DD) from config.yaml release_dates; null when absent (devel usually has none)'),
});

export const PkgReleaseInfoDataSchema = z.object({
  release: VersionInfoSchema.describe('The current release, from config.yaml'),
  devel: VersionInfoSchema.describe('The current devel version, from config.yaml'),
  manifest: z.object({
    generated: z.string().describe('When the manifest index was generated, ISO 8601'),
    release: z.string().describe('versions.release in the manifest index'),
    devel: z.string().describe('versions.devel in the manifest index'),
    serving_symlinks: z
      .object({ release: z.string().nullable(), devel: z.string().nullable() })
      .describe(
        "Targets of the site's packages/release and packages/devel symlinks, from the manifest index; null if not listed",
      ),
    build: z.string().nullable(),
    manifests: z
      .array(
        z.object({
          path: z.string().describe("e.g. '3.23/bioc.tsv.gz'"),
          url: z
            .string()
            .nullable()
            .describe('Download URL (not fetched by this server); null if the path is not in the expected form'),
          objects: z.number().int().describe('Objects listed in the manifest'),
          without_hash: z.number().int().describe('Objects with no usable MD5'),
        }),
      )
      .describe('Published manifests, in index order'),
  }),
  agree: z.boolean().describe('true when config.yaml and the manifest index name the same release and devel versions'),
  disagreements: z.array(z.string()).describe('Each mismatch found, in plain words; empty when agree is true'),
});
type PkgReleaseInfoData = z.infer<typeof PkgReleaseInfoDataSchema>;
type VersionInfo = z.infer<typeof VersionInfoSchema>;

const MANIFEST_BASE_URL = 'https://bioconductor.org/api/v1/manifest/';
const MANIFEST_PREFIX = '/api/v1/manifest';
const MANIFEST_PATH = /^\d+\.\d+\/[a-z][a-z-]*\.tsv\.gz$/;
const RELEASE_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** config.yaml's 'M/D/YYYY' (padding varies) → 'YYYY-MM-DD'; null if absent, malformed or not a real date. */
export function parseReleaseDate(value: string | undefined): string | null {
  const match = value === undefined ? null : RELEASE_DATE.exec(value);
  if (!match) return null;
  return isoDate(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
}

function versionInfo(config: BiocConfig, version: string, rVersion: string): VersionInfo {
  const dates = config.release_dates;
  return {
    version,
    r_version: rVersion,
    release_date: parseReleaseDate(dates && Object.hasOwn(dates, version) ? dates[version] : undefined),
  };
}

function symlinkTarget(index: ManifestIndex, link: string): string | null {
  const { symlinks } = index;
  return symlinks && Object.hasOwn(symlinks, link) ? symlinks[link]! : null;
}

/** Upstream strings are only turned into a URL after both checks pass; nothing here is fetched. */
function manifestUrl(index: ManifestIndex, path: string): string | null {
  return index.manifest_prefix === MANIFEST_PREFIX && MANIFEST_PATH.test(path)
    ? new URL(path, MANIFEST_BASE_URL).href
    : null;
}

function summarize(data: PkgReleaseInfoData): string {
  const { release, devel, manifest, agree, disagreements } = data;
  const head =
    `Bioconductor ${release.version} is the current release (R ${release.r_version}` +
    `${release.release_date ? `, released ${release.release_date}` : ''}); ` +
    `${devel.version} is devel (R ${devel.r_version}).`;
  const tail = agree
    ? `config.yaml and the manifest index (generated ${manifest.generated}) agree.`
    : `The sources disagree: ${disagreements.join(' ')}`;
  return `${head} ${tail}`;
}

export const pkgReleaseInfo = defineCapability({
  module: 'pkg',
  name: 'pkg_release_info',
  title: 'Bioconductor release and devel versions',
  description:
    'Which Bioconductor versions are current: the release and devel version numbers, the R version each ' +
    'is associated with, the release date, and the published package manifests (one per repository and ' +
    "version, with object counts and download URLs). Reads bioconductor.org's config.yaml and the manifest " +
    'index and flags any disagreement between them (expected briefly around a release). Takes no input. ' +
    "For one package's build or propagation state use pkg_status; for download counts use pkg_downloads.",
  input: z.object({}),
  data: PkgReleaseInfoDataSchema,
  async handler(_input, deps) {
    const [{ response: configResponse, config }, { response: manifestResponse, index }] = await Promise.all([
      getBiocConfig(deps),
      getManifestIndex(deps),
    ]);
    const serving = {
      release: symlinkTarget(index, 'packages/release'),
      devel: symlinkTarget(index, 'packages/devel'),
    };

    const disagreements: string[] = [];
    if (config.release_version !== index.versions.release) {
      disagreements.push(
        `config.yaml says release ${config.release_version}; the manifest index says ${index.versions.release}.`,
      );
    }
    if (config.devel_version !== index.versions.devel) {
      disagreements.push(
        `config.yaml says devel ${config.devel_version}; the manifest index says ${index.versions.devel}.`,
      );
    }
    if (serving.release !== null && serving.release !== index.versions.release) {
      disagreements.push(
        `The packages/release symlink points to ${serving.release}; the manifest index says release ${index.versions.release}.`,
      );
    }
    if (serving.devel !== null && serving.devel !== index.versions.devel) {
      disagreements.push(
        `The packages/devel symlink points to ${serving.devel}; the manifest index says devel ${index.versions.devel}.`,
      );
    }

    const data: PkgReleaseInfoData = {
      release: versionInfo(config, config.release_version, config.r_version_associated_with_release),
      devel: versionInfo(config, config.devel_version, config.r_version_associated_with_devel),
      manifest: {
        generated: index.generated,
        release: index.versions.release,
        devel: index.versions.devel,
        serving_symlinks: serving,
        build: index.build ?? null,
        manifests: index.manifests.map((m) => ({
          path: m.path,
          url: manifestUrl(index, m.path),
          objects: m.objects,
          without_hash: m.without_hash,
        })),
      },
      agree: disagreements.length === 0,
      disagreements,
    };
    return {
      data,
      summary: summarize(data),
      sources: [sourceFor(configResponse), sourceFor(manifestResponse, index.generated)],
    };
  },
});
