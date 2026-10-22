import * as z from 'zod';
import { sourceFor } from '../../upstreams/http';
import { getBuildManifest, UNIVERSES } from '../../upstreams/registry';
import { defineCapability } from '../capability';
import { JobIdSchema, jobUrl } from './job';
import { PackageNameSchema } from './package-name';
import { UniverseOfJobSchema } from './universe';

export const PkgBuildEnvironmentDataSchema = z.object({
  universe: z.enum(UNIVERSES),
  job: z.string(),
  job_url: z.string().describe('GitHub Actions job page'),
  image: z
    .string()
    .nullable()
    .describe('Container image pinned by digest (Linux configs), or the GitHub-hosted runner image and version (macOS, Windows)'),
  digest: z.string().nullable().describe("The image's sha256 digest; null for runner images, which have none"),
  repos: z.array(z.string()).describe('Repositories dependencies were resolved from, in the order the build used'),
  moving_repos: z
    .array(z.string())
    .describe("Repos that are moving snapshots (p3m '.../latest'), which pin nothing by themselves"),
  deps_count: z.number().int().describe('How many dependencies the build installed'),
  deps: z
    .array(z.object({ package: z.string(), version: z.string().nullable() }))
    .describe('The requested dependencies in request order (duplicates removed); version null if the build did not install it'),
});
type PkgBuildEnvironmentData = z.infer<typeof PkgBuildEnvironmentDataSchema>;

function summarize(data: PkgBuildEnvironmentData): string {
  const { universe, job, image, digest, repos, moving_repos: moving, deps_count: count, deps } = data;
  const sentences: string[] = [];
  if (digest) sentences.push(`${universe} job ${job} ran in container ${image}.`);
  else if (image) sentences.push(`${universe} job ${job} ran on runner image ${image} (no container digest).`);
  else sentences.push(`${universe} job ${job}: the build manifest records no image.`);
  sentences.push(`It installed ${count} dependencies from ${repos.length} repositories.`);
  if (moving.length > 0) {
    sentences.push(
      `${moving.join(', ')} ${moving.length === 1 ? 'is a moving snapshot' : 'are moving snapshots'}; ` +
        'the dependency versions are the record of what it served.',
    );
  }
  if (deps.length > 0) {
    const versions = deps.slice(0, 10).map((d) => `${d.package} ${d.version ?? 'not installed'}`);
    sentences.push(`Versions: ${versions.join(', ')}${deps.length > 10 ? ` and ${deps.length - 10} more` : ''}.`);
  } else if (count > 0) {
    sentences.push('Pass dependencies to see installed versions.');
  }
  return sentences.join(' ');
}

export const pkgBuildEnvironment = defineCapability({
  module: 'pkg',
  name: 'pkg_build_environment',
  title: 'Build environment of one build job',
  description:
    'What one r-universe build job ran with: the container image pinned by digest (or the GitHub-hosted ' +
    'runner image for macOS and Windows), the repositories it resolved dependencies from, how many it ' +
    'installed, and the exact installed versions of the dependencies you name. Use it when a check broke ' +
    'without the package changing. Get the job id and universe from pkg_status (upstream.jobs[].job). Only ' +
    "jobs whose log the registry captured are available. For the check's output, use pkg_check_output.",
  input: z.object({
    universe: UniverseOfJobSchema,
    job: JobIdSchema,
    dependencies: z
      .array(PackageNameSchema)
      .max(50)
      .default([])
      .describe('Dependency package names whose installed version to report (up to 50), e.g. ["biomaRt", "httr2"]'),
  }),
  data: PkgBuildEnvironmentDataSchema,
  async handler({ universe, job, dependencies }, deps) {
    const { response, manifest } = await getBuildManifest(deps, universe, job);
    const image = manifest.image ?? null;
    const repos = manifest.repos ?? [];
    const installed = manifest.deps ?? {};
    const data: PkgBuildEnvironmentData = {
      universe,
      job,
      job_url: jobUrl(universe, job),
      image,
      digest: /@(sha256:[0-9a-f]{64})$/.exec(image ?? '')?.[1] ?? null,
      repos,
      moving_repos: repos.filter((r) => /\/latest\/?$/.test(r)),
      deps_count: Object.keys(installed).length,
      deps: [...new Set(dependencies)].map((name) => ({
        package: name,
        version: Object.hasOwn(installed, name) ? installed[name]! : null,
      })),
    };
    return { data, summary: summarize(data), sources: [sourceFor(response)] };
  },
});
