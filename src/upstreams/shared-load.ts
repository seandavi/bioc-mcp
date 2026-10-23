import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import type { UpstreamCache } from './cache';
import { DEFAULT_TIMEOUT_MS, type Upstream, type UpstreamResponseMeta } from './http';

// Covers the cache read and the parse around the fetch, which fetchUpstream's timeout does not.
const LOAD_ALLOWANCE_MS = 5_000;

interface MemoEntry<T> {
  load: Promise<T>;
  expiresAt: number; // startedAt + the load deadline while the load is in flight; fetchedAt + TTL once it settles
  loadDeadline: number | undefined; // set while the load is in flight
}

/**
 * A per-cache, per-URL memo for a large upstream body that is parsed into a value once per TTL.
 *
 * The parsed value lives exactly as long as the cache in front of it: a fresh cache (each test
 * app) gets a fresh memo, and the Worker (one cache per isolate) loads at most once per TTL. The
 * memo holds the load Promise, so concurrent callers on a cold or expired entry share one cache
 * read, fetch and parse instead of each holding their own copy of a multi-MB body. Request A's
 * I/O can be cancelled by the runtime (its client disconnected) or stall outside fetchUpstream's
 * timeout, so no caller waits on a load without a deadline of its own, and an in-flight entry
 * past its deadline is replaced by the next caller. Errors are not cached.
 *
 * Every parsed upstream body larger than a few hundred KB goes through one of these.
 */
export class SharedLoads<T extends { response: UpstreamResponseMeta }> {
  private readonly byCache = new WeakMap<UpstreamCache, Map<string, MemoEntry<T>>>();

  /**
   * `what` completes "<upstream> did not deliver ___ in time" in the timeout error. `load` runs
   * only when no live entry exists. Callers that join an existing entry get `fromCache: true`.
   */
  async get(deps: Deps, upstream: Upstream, url: string, what: string, load: () => Promise<T>): Promise<T> {
    let byUrl = this.byCache.get(deps.cache);
    if (!byUrl) {
      byUrl = new Map();
      this.byCache.set(deps.cache, byUrl);
    }

    const loadDeadlineMs = (upstream.timeoutMs ?? DEFAULT_TIMEOUT_MS) + LOAD_ALLOWANCE_MS;
    const now = deps.now().getTime();
    const memo = byUrl.get(url);
    if (memo && now < memo.expiresAt) {
      const shared =
        memo.loadDeadline === undefined
          ? await memo.load
          : await withinMs(memo.load, memo.loadDeadline - now, upstream, url, what);
      return { ...shared, response: { ...shared.response, fromCache: true } };
    }

    const loadDeadline = now + loadDeadlineMs;
    const entry: MemoEntry<T> = { load: load(), expiresAt: loadDeadline, loadDeadline };
    byUrl.set(url, entry);
    try {
      const value = await withinMs(entry.load, loadDeadlineMs, upstream, url, what);
      entry.expiresAt = Date.parse(value.response.fetchedAt) + upstream.ttlSeconds * 1000;
      entry.loadDeadline = undefined;
      return value;
    } catch (error) {
      if (byUrl.get(url) === entry) byUrl.delete(url);
      throw error;
    }
  }
}

/** Rejects with upstream_timeout if `promise` has not settled within `ms`. */
async function withinMs<T>(promise: Promise<T>, ms: number, upstream: Upstream, url: string, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CapabilityError('upstream_timeout', `${upstream.name} did not deliver ${what} in time (${url}). Retry shortly.`, {
            upstream: upstream.id,
            url,
          }),
        ),
      Math.max(ms, 0),
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
