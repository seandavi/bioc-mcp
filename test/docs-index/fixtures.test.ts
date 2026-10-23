import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureDocsFetch, recordingFetch } from '../../scripts/docs-index/fixtures';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docs-fixtures-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('docs fixture fetches', () => {
  it.each([
    'https://raw.githubusercontent.com/seandavi/x/..%2F..%2Fx',
    'https://raw.githubusercontent.com/seandavi/x/..%5Cx',
    'https://../x',
  ])('refuse the unsafe url %s', async (url) => {
    const inner = vi.fn(async () => new Response('x'));
    await expect(recordingFetch(inner, root)(new Request(url))).rejects.toThrow(/unsafe fixture path/);
    expect(inner).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    await expect(fixtureDocsFetch(root)(new Request(url))).rejects.toThrow(/unsafe fixture path/);
  });

  it('writes a safe url under <root>/<host>/<path> and reads it back', async () => {
    const inner = vi.fn(async () => new Response('hello', { status: 200 }));
    await recordingFetch(inner, root)(new Request('https://docs.test/a/b.md'));
    expect(await readFile(join(root, 'docs.test', 'a', 'b.md'), 'utf8')).toBe('hello');

    const response = await fixtureDocsFetch(root)(new Request('https://docs.test/a/b.md'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('content-type')).toBe('text/plain');
  });

  it('adds the encoded query string as one more path segment, and reads it back', async () => {
    const url = 'https://api.test/repos/o/r/deployments?environment=github-pages&per_page=10';
    const inner = vi.fn(async () => new Response('[]', { status: 200 }));
    await recordingFetch(inner, root)(new Request(url));
    const segment = '%3Fenvironment%3Dgithub-pages%26per_page%3D10';
    expect(await readFile(join(root, 'api.test', 'repos', 'o', 'r', 'deployments', segment), 'utf8')).toBe('[]');

    expect((await fixtureDocsFetch(root)(new Request('https://api.test/repos/o/r/deployments?per_page=1'))).status).toBe(404);
    const response = await fixtureDocsFetch(root)(new Request(url));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[]');
  });

  it('keeps a file and a directory of the same name apart when only one has a query string', async () => {
    const inner = vi.fn(async () => new Response('x', { status: 200 }));
    await recordingFetch(inner, root)(new Request('https://api.test/d/1/statuses?per_page=1'));
    await recordingFetch(inner, root)(new Request('https://api.test/d?per_page=10'));
    expect(await readdir(join(root, 'api.test', 'd'))).toEqual(expect.arrayContaining(['%3Fper_page%3D10', '1']));
  });

  it('writes a query string holding path separators as one safe segment', async () => {
    const inner = vi.fn(async () => new Response('x', { status: 200 }));
    await recordingFetch(inner, root)(new Request('https://api.test/a?x=../..'));
    expect(await readdir(join(root, 'api.test', 'a'))).toEqual(['%3Fx%3D..%2F..']);
  });
});
