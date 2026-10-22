import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchFn } from '../../src/core/deps';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const pendingSignals = new Set<AbortSignal>();

export type FixtureRoute =
  | { file: string; status?: number; headers?: Record<string, string> }
  | { status: number; body?: string; headers?: Record<string, string> }
  | 'timeout'
  | 'network-error';

/** A FetchFn that answers from `routes` (keyed by full URL) and records every requested URL. */
export function fixtureFetch(routes: Record<string, FixtureRoute>): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (request: Request) => {
    calls.push(request.url);
    const route = routes[request.url];
    if (route === undefined) throw new Error(`Unexpected upstream request: ${request.url}`);
    if (route === 'network-error') throw new TypeError('fetch failed');
    if (route === 'timeout') {
      // A Request's signal only follows AbortSignal.timeout() weakly, so nothing else keeps it
      // alive while this promise is pending; hold it until it aborts or GC can swallow the timeout.
      pendingSignals.add(request.signal);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            pendingSignals.delete(request.signal);
            reject(request.signal.reason);
          },
          { once: true },
        );
      });
    }
    if ('file' in route) {
      const body = readFileSync(join(FIXTURES_DIR, route.file), 'utf8');
      return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
    }
    return new Response(route.body ?? '', { status: route.status, headers: route.headers ?? {} });
  }) as FetchFn & { calls: string[] };
  fetchFn.calls = calls;
  return fetchFn;
}
