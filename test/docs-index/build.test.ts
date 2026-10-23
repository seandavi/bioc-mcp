import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderArtifactModule, writeArtifactModule } from '../../scripts/docs-index/build';
import { siteSubsections } from '../../scripts/docs-index/site';
import { loadDocsIndex } from '../../src/docs-index/load';
import { DocsRecordSchema } from '../../src/docs-index/schema';
import { CapabilityError } from '../../src/errors';
import { fixtureFetch } from '../support/fixture-fetch';
import { BUILD_COMMIT, DOCS_FIXTURES_DIR, NOW, buildFromFixtures, fixtureArtifact, realConfig } from './support';

const SITE_URL = 'https://seandavi.github.io/bioc-infrastructure/';
const SEARCH_URL = SITE_URL + 'search.json';

/** The distinct pages (href before '#') of the fixture search.json. */
const SITE_PAGES: string[] = [
  ...new Set(
    (JSON.parse(readFileSync(join(DOCS_FIXTURES_DIR, 'seandavi.github.io', 'bioc-infrastructure', 'search.json'), 'utf8')) as { href: string }[]).map(
      (entry) => entry.href.split('#')[0]!,
    ),
  ),
];

function fixtureFile(url: string): string {
  const { hostname, pathname } = new URL(url);
  return join(DOCS_FIXTURES_DIR, hostname, pathname);
}

/** fixtureFetch routes for every config input, optionally overriding search.json. */
function routesFor(override?: Parameters<typeof fixtureFetch>[0][string]) {
  const config = realConfig();
  const routes: Parameters<typeof fixtureFetch>[0] = {};
  routes[SEARCH_URL] = override ?? { file: 'docs/seandavi.github.io/bioc-infrastructure/search.json' };
  for (const page of SITE_PAGES) {
    routes[SITE_URL + page] = { file: `docs/seandavi.github.io/bioc-infrastructure/${page}` };
  }
  for (const { repo, ref, files } of config.repos) {
    for (const file of files) {
      const path = `seandavi/${repo}/${ref}/${file}`;
      routes[`https://raw.githubusercontent.com/${path}`] = { file: `docs/raw.githubusercontent.com/${path}` };
    }
  }
  return routes;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docs-index-'));
  tempDirs.push(dir);
  return dir;
}

describe('buildDocsIndex', () => {
  it('is byte-identical across runs', async () => {
    const [a, b] = await Promise.all([buildFromFixtures(), buildFromFixtures()]);
    expect(a.storeJson).toBe(b.storeJson);
    expect(a.indexJson).toBe(b.indexJson);
  });

  it('matches the build summary snapshot', async () => {
    const { store, storeJson, indexJson } = await fixtureArtifact();
    const summary = {
      meta: store.meta,
      store_sha256: createHash('sha256').update(storeJson).digest('hex'),
      index_sha256: createHash('sha256').update(indexJson).digest('hex'),
      records: store.records.map(({ text, ...rest }) => ({ ...rest, text_chars: text.length })),
    };
    await expect(JSON.stringify(summary, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/build-summary.json');
  });

  it('builds valid records: 381 site/adr first, unique ids, repo only on repo records', async () => {
    const { store } = await fixtureArtifact();
    const siteCount = store.records.filter((r) => r.source !== 'repo').length;
    expect(siteCount).toBe(381);
    expect(store.records.slice(0, siteCount).every((r) => r.source !== 'repo')).toBe(true);
    expect(new Set(store.records.map((r) => r.id)).size).toBe(store.records.length);
    for (const record of store.records) {
      expect(DocsRecordSchema.safeParse(record).success).toBe(true);
      expect(new URL(record.url).protocol).toBe('https:');
      expect(record.repo !== undefined).toBe(record.source === 'repo');
    }
  });

  it('records 16 inputs in config order with the fixture sha256s', async () => {
    const { store } = await fixtureArtifact();
    const { inputs } = store.meta;
    const config = realConfig();
    expect(inputs.map((i) => i.url)).toEqual([
      SEARCH_URL,
      ...config.repos.flatMap(({ repo, ref, files }) =>
        files.map((file) => `https://raw.githubusercontent.com/seandavi/${repo}/${ref}/${file}`),
      ),
    ]);
    expect(inputs).toHaveLength(16);
    for (const input of inputs) {
      const body = await readFile(fixtureFile(input.url));
      expect(input.sha256).toBe(createHash('sha256').update(body).digest('hex'));
      expect(input.last_modified).toBeNull();
    }
    expect(inputs.reduce((sum, i) => sum + i.record_count, 0)).toBe(store.meta.record_count);
    expect(store.meta).toMatchObject({ built_at: '2026-10-22T00:00:00.000Z', build_commit: BUILD_COMMIT });
  });

  it('fetches 41 site pages and records 535 records', async () => {
    expect(SITE_PAGES).toHaveLength(41);
    const { store } = await fixtureArtifact();
    expect(store.records).toHaveLength(535);
    expect(store.meta.inputs[0]?.record_count).toBe(381);
  });

  it('splits site h2 records at h3: the rollback-worker runbook is its own record', async () => {
    const { store } = await fixtureArtifact();
    const byId = new Map(store.records.map((r) => [r.id, r]));
    const runbook = byId.get('site:operations.html#rollback-worker')!;
    expect(runbook).toMatchObject({
      url: SITE_URL + 'operations.html#rollback-worker',
      section: 'Roll back the Worker',
      crumbs: ['Overview', 'Operating', 'Operations & Runbooks', 'Runbooks'],
      source: 'site',
    });
    expect(runbook.text.startsWith('Roll back the Worker\n')).toBe(true);
    expect(byId.get('site:operations.html#runbooks')!.text).not.toContain('wrangler rollback');
    for (const id of ['deploy-worker', 'rollback-worker', 'rollback-site', 'failed-sync', 'purge', 'yank', 'rollback-dns']) {
      expect(byId.has(`site:operations.html#${id}`)).toBe(true);
    }
  });

  it('makes every level-3 section of every page a record that starts with its heading', async () => {
    const { store } = await fixtureArtifact();
    const byId = new Map(store.records.map((r) => [r.id, r]));
    let count = 0;
    for (const page of SITE_PAGES) {
      const html = readFileSync(join(DOCS_FIXTURES_DIR, 'seandavi.github.io', 'bioc-infrastructure', page), 'utf8');
      for (const subsections of siteSubsections(html).values()) {
        for (const { id, heading } of subsections) {
          const record = byId.get(`site:${page}#${id}`);
          expect(record, `${page}#${id}`).toBeDefined();
          expect(record!.text.split('\n')[0]).toBe(heading);
          expect(record!.section).toBe(heading);
          count++;
        }
      }
    }
    expect(count).toBe(117);
  });

  it('rejects with not_found naming the page URL when a site page has no route', async () => {
    const routes = routesFor();
    routes[SITE_URL + 'operations.html'] = { status: 404 };
    const error = await buildFromFixtures(realConfig(), fixtureFetch(routes)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe('not_found');
    expect((error as CapabilityError).message).toContain(SITE_URL + 'operations.html');
  });

  it('passes through last_modified from the upstream header', async () => {
    const fetch = fixtureFetch(
      routesFor({
        file: 'docs/seandavi.github.io/bioc-infrastructure/search.json',
        headers: { 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      }),
    );
    const { store } = await buildFromFixtures(realConfig(), fetch);
    expect(store.meta.inputs[0]?.last_modified).toBe('2026-10-21T07:28:00.000Z');
    expect(store.meta.inputs[1]?.last_modified).toBeNull();
  });

  it('rejects with not_found naming the URL when an input is missing', async () => {
    const config = realConfig();
    const first = config.repos[0]!;
    const withMissing = { ...config, repos: [{ ...first, files: [...first.files, 'MISSING.md'] }, ...config.repos.slice(1)] };
    const error = await buildFromFixtures(withMissing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe('not_found');
    expect((error as CapabilityError).message).toContain('/bioc-registry/main/MISSING.md');
  });

  it('rejects naming the search.json entry that has no href', async () => {
    const fetch = fixtureFetch(
      routesFor({ status: 200, body: JSON.stringify([{ href: 'a.html', title: '', section: '', text: '' }, { title: '' }]) }),
    );
    await expect(buildFromFixtures(realConfig(), fetch)).rejects.toThrow(/entry 1/);
  });
});

describe('renderArtifactModule', () => {
  it('renders a module whose constants load back into an index', async () => {
    const artifact = await fixtureArtifact();
    const rendered = renderArtifactModule(artifact);
    const dir = await tempDir();
    await writeArtifactModule(dir, rendered, rendered.bytes);
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'docs-index.js')).href)) as {
      DOCS_STORE_JSON: string;
      DOCS_INDEX_JSON: string;
    };
    expect(mod.DOCS_STORE_JSON).toBe(artifact.storeJson);
    const index = loadDocsIndex({ storeJson: mod.DOCS_STORE_JSON, indexJson: mod.DOCS_INDEX_JSON });
    expect(index.records).toHaveLength(artifact.store.meta.record_count);
  });
});

describe('writeArtifactModule', () => {
  it('refuses a module over the limit and writes nothing', async () => {
    const rendered = renderArtifactModule(await fixtureArtifact());
    const dir = join(await tempDir(), 'out');
    await expect(writeArtifactModule(dir, rendered, rendered.bytes - 1)).rejects.toThrow(/max_artifact_bytes/);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes both files at exactly the limit', async () => {
    const rendered = renderArtifactModule(await fixtureArtifact());
    const dir = await tempDir();
    await writeArtifactModule(dir, rendered, rendered.bytes);
    expect((await readdir(dir)).sort()).toEqual(['docs-index.d.ts', 'docs-index.js']);
  });
});
