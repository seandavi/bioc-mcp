import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureRoute } from './fixture-fetch';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const GITHUB_DIR = join(FIXTURES_DIR, 'github');

export const GITHUB_RECORDED_AT = new Date(readFileSync(join(GITHUB_DIR, 'RECORDED_AT'), 'utf8').trim());

export function githubUrl(repo: string, suffix?: string): string {
  return `https://api.github.com/repos/seandavi/${repo}${suffix ?? ''}`;
}

const ISSUES_QUERY = '?state=open&per_page=100&sort=created&direction=desc';

/** URL suffix for a file path under test/fixtures/github/<repo>/; undefined when the file is unknown. */
function suffixFor(path: string, defaultBranch: string): string | undefined {
  const fixed: Record<string, string> = {
    'repo.json': '',
    'issues.json': `/issues${ISSUES_QUERY}`,
    'pulls.json': `/pulls${ISSUES_QUERY}`,
    'actions/workflows.json': '/actions/workflows?per_page=100',
  };
  if (path in fixed) return fixed[path];
  const pull = /^pulls\/(\d+)\.json$/.exec(path);
  if (pull) return `/pulls/${pull[1]}`;
  const commit = /^commits\/([0-9a-f]+)\/(check-runs|status)\.json$/.exec(path);
  if (commit) return `/commits/${commit[1]}/${commit[2] === 'status' ? 'status' : 'check-runs?per_page=100'}`;
  const runs = /^actions\/runs\/([^/]+)\.json$/.exec(path);
  if (runs) {
    return `/actions/workflows/${runs[1]}/runs?branch=${defaultBranch}&per_page=20&exclude_pull_requests=true`;
  }
  return undefined;
}

/** Every recorded GitHub response under `dir` (default test/fixtures/github), keyed by URL. A fresh object each call. */
export function githubRoutes(dir: string = GITHUB_DIR): Record<string, FixtureRoute> {
  const routes: Record<string, FixtureRoute> = {};
  for (const repo of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const repoDir = join(dir, repo.name);
    const { default_branch: defaultBranch } = JSON.parse(readFileSync(join(repoDir, 'repo.json'), 'utf8')) as {
      default_branch: string;
    };
    for (const entry of readdirSync(repoDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      const path = relative(repoDir, fullPath).split(sep).join('/');
      const suffix = suffixFor(path, defaultBranch);
      if (suffix === undefined) throw new Error(`Unknown GitHub fixture: ${repo.name}/${path}`);
      routes[githubUrl(repo.name, suffix)] = { file: relative(FIXTURES_DIR, fullPath).split(sep).join('/') };
    }
  }
  return routes;
}
