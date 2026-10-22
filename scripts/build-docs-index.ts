import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { buildDocsIndex, renderArtifactModule, writeArtifactModule } from './docs-index/build';
import { parseDocsSourcesConfig } from './docs-index/config';
import { fixtureDocsFetch, recordingFetch } from './docs-index/fixtures';

const repoRoot = join(import.meta.dirname, '..');
const fixtureRoot = join(repoRoot, 'test', 'fixtures', 'docs');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      fixtures: { type: 'boolean' },
      'record-fixtures': { type: 'boolean' },
      'if-missing': { type: 'boolean' },
      config: { type: 'string', default: 'docs-sources.yaml' },
      out: { type: 'string', default: 'generated' },
    },
  });
  if (values.fixtures && values['record-fixtures']) {
    throw new Error('--fixtures and --record-fixtures cannot be combined');
  }
  const resolve = (path: string) => (isAbsolute(path) ? path : join(repoRoot, path));
  const outDir = resolve(values.out as string);
  const display = (file: string) => relative(repoRoot, join(outDir, file)) || file;

  if (values['if-missing'] && (await exists(join(outDir, 'docs-index.js'))) && (await exists(join(outDir, 'docs-index.d.ts')))) {
    console.log(
      `docs index: ${display('docs-index.js')} exists; skipping (npm run docs:fixtures or docs:build rebuilds it)`,
    );
    return;
  }

  const config = parseDocsSourcesConfig(await readFile(resolve(values.config as string), 'utf8'));
  let fetchFn = values.fixtures ? fixtureDocsFetch(fixtureRoot) : (request: Request) => fetch(request);
  if (values['record-fixtures']) fetchFn = recordingFetch(fetchFn, fixtureRoot);

  const artifact = await buildDocsIndex(config, {
    fetch: fetchFn,
    now: () => new Date(),
    buildCommit: process.env.GITHUB_SHA ?? null,
  });
  const rendered = renderArtifactModule(artifact);
  await writeArtifactModule(outDir, rendered, config.max_artifact_bytes);
  console.log(
    `docs index: ${artifact.store.meta.record_count} records from ${artifact.store.meta.inputs.length} inputs ` +
      `(${values.fixtures ? 'fixtures' : 'network'}), ${rendered.bytes} bytes → ${display('docs-index.js')}`,
  );
}

main().catch((error: unknown) => {
  console.error(`docs index build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
