import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { pkgModule } from '../../src/core/pkg';
import { TRIAGE_DOCS_QUERY, triageFailingPackagePrompt } from '../../src/core/pkg/prompts';
import { connectClient, makeTestApp } from '../support/app';
import { docsTestModule } from '../support/docs';
import { BIOC_INDEX_URL, checksUrl, pkgRoutes, ruUrl } from '../support/pkg-routes';

const NAME = 'triage-failing-package';
const GATE_CHECK = 'https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#the-gate-check-by-check';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(path: string) {
  const { app, fetch } = await makeTestApp({ routes: pkgRoutes, extraModules: [pkgModule, await docsTestModule()] });
  client = await connectClient(app, path);
  return { client, fetch };
}

type Job = { config: string; check: string | null; job: string; url: string };

/** Step 2 of the prompt text, as code: failing jobs that are not bioc-checks, ERROR first, then linux-*. */
function pickFailingJob(jobs: Job[]): Job | undefined {
  const failing = jobs.filter((j) => j.config !== 'bioc-checks' && /^(ERROR|FAIL|FAILURE)$/.test(j.check ?? ''));
  const rank = (j: Job) => (j.check === 'ERROR' ? 0 : 2) + (j.config.startsWith('linux-') ? 0 : 1);
  return [...failing].sort((a, b) => rank(a) - rank(b))[0];
}

describe('listing', () => {
  test.each(['/mcp', '/mcp/pkg+docs', '/mcp/docs+pkg'])('%s offers triage-failing-package with one required package argument', async (path) => {
    const { client } = await connect(path);
    const prompt = (await client.listPrompts()).prompts.find((p) => p.name === NAME);
    expect(prompt?.arguments).toEqual([expect.objectContaining({ name: 'package', required: true })]);
  });

  test('it is absent on /mcp/pkg and /mcp/docs', async () => {
    expect((await (await connect('/mcp/pkg')).client.listPrompts()).prompts).toEqual([]);
    await client?.close();
    const { client: docs } = await connect('/mcp/docs');
    expect((await docs.listPrompts()).prompts.map((p) => p.name)).toEqual(['explain-decision']);
  });
});

describe('prompts/get', () => {
  test('returns one user message equal to render, with no upstream request', async () => {
    const { client, fetch } = await connect('/mcp/pkg+docs');
    const result = await client.getPrompt({ name: NAME, arguments: { package: 'GEOfastq' } });
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0]!;
    expect(message.role).toBe('user');
    expect(message.content).toEqual({ type: 'text', text: triageFailingPackagePrompt.render({ package: 'GEOfastq' }) });
    expect(fetch.calls).toEqual([]);
  });

  test.each([{}, { package: 'bad name' }])('rejects %j with -32602', async (args) => {
    const { client } = await connect('/mcp/pkg+docs');
    await expect(client.getPrompt({ name: NAME, arguments: args })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('the walk the prompt describes', () => {
  test('GEOfastq, whose devel check fails', async () => {
    const { client, fetch } = await connect('/mcp/pkg+docs');
    const called: string[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      called.push(name);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return result.structuredContent as { summary: string; data: Record<string, any> };
    };

    const status = await call('pkg_status', { package: 'GEOfastq' });
    expect(status.data.propagated.version).toBe('1.21.0');
    expect(status.data.behind).toBe(false);
    expect(status.summary).toContain('failing linux-devel-x86_64 (ERROR)');

    const picked = pickFailingJob(status.data.upstream.jobs);
    expect(picked).toMatchObject({ config: 'linux-devel-x86_64', job: '107579662259' });
    const job = picked!.job;

    const output = await call('pkg_check_output', { universe: 'bioc', job });
    expect(output.data.check.status).toBe('Status: 1 ERROR');
    expect(output.data.check.sections[0]).toMatchObject({ check: 'checking tests', verdict: 'ERROR' });
    expect(output.data.check.sections[0].text).toContain('test-srp_utils.R:31:5');
    expect(output.data.files).toContain('testthat.Rout.fail');
    expect(output.data.job_url.endsWith('/runs/107579662259')).toBe(true);

    const tests = await call('pkg_check_output', { universe: 'bioc', job, file: 'testthat.Rout.fail' });
    expect(tests.data.view).toBe('tail');
    expect(tests.data.text.text).toContain('Failed tests');

    const docs = await call('docs_search', { query: TRIAGE_DOCS_QUERY });
    expect(docs.data.hits[0].url).toBe(GATE_CHECK);

    for (const name of called) expect(triageFailingPackagePrompt.tools).toContain(name);
    expect(new Set(fetch.calls)).toEqual(new Set([BIOC_INDEX_URL, ruUrl('bioc', 'GEOfastq'), checksUrl('bioc', job)]));
  });
});
