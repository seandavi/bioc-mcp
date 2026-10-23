import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FetchFn } from '../../src/core/deps';

function fixturePath(root: string, url: URL): string {
  const segments = [url.hostname, ...url.pathname.split('/').filter(Boolean).map(decodeURIComponent)];
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      throw new Error(`Refusing unsafe fixture path for ${url.href}: segment ${JSON.stringify(segment)}`);
    }
  }
  return join(root, ...segments);
}

/**
 * Answers from files under `root`, at `<root>/<hostname>/<decoded path segments>`; a missing file
 * is a 404 Response. Content-Type is application/json for .json, text/plain otherwise; no other headers.
 * Throws on a URL whose hostname or decoded path segment is '.', '..' or contains '/' or '\\'.
 */
export function fixtureDocsFetch(root: string): FetchFn {
  return async (request) => {
    const path = fixturePath(root, new URL(request.url));
    let body: string;
    try {
      body = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response('Not found', { status: 404 });
      throw error;
    }
    const contentType = path.endsWith('.json') ? 'application/json' : 'text/plain';
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  };
}

/**
 * Passes requests to `inner`; writes each 200 body to the fixture path for its URL (mkdir -p).
 * Refuses an unsafe URL (see fixtureDocsFetch) before calling inner.
 */
export function recordingFetch(inner: FetchFn, root: string): FetchFn {
  return async (request) => {
    const path = fixturePath(root, new URL(request.url));
    const response = await inner(request);
    if (response.status === 200) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await response.clone().text());
    }
    return response;
  };
}
