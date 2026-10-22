export interface CachedUpstream {
  url: string;
  body: string;
  contentType: string | null;
  lastModified: string | null; // ISO 8601, parsed from the Last-Modified header
  fetchedAt: string; // ISO 8601, from deps.now()
}

export interface UpstreamCache {
  get(url: string): Promise<CachedUpstream | undefined>;
  put(url: string, value: CachedUpstream, ttlSeconds: number): Promise<void>;
}

/** Map-backed; an entry expires when now() >= stored-at + ttlSeconds. For tests and Node. */
export function createMemoryCache(now: () => Date): UpstreamCache {
  const entries = new Map<string, { value: CachedUpstream; expiresAt: number }>();
  return {
    async get(url) {
      const entry = entries.get(url);
      if (!entry) return undefined;
      if (now().getTime() >= entry.expiresAt) {
        entries.delete(url);
        return undefined;
      }
      return entry.value;
    },
    async put(url, value, ttlSeconds) {
      entries.set(url, { value, expiresAt: now().getTime() + ttlSeconds * 1000 });
    },
  };
}

const FETCHED_AT_HEADER = 'x-bioc-mcp-fetched-at';
const LAST_MODIFIED_HEADER = 'x-bioc-mcp-last-modified';

/** Cloudflare Cache API adapter (the Worker passes caches.default). */
export function createCloudflareCache(cache: Pick<Cache, 'match' | 'put'>): UpstreamCache {
  return {
    async get(url) {
      try {
        const hit = await cache.match(url);
        if (!hit) return undefined;
        const fetchedAt = hit.headers.get(FETCHED_AT_HEADER);
        if (!fetchedAt) return undefined;
        return {
          url,
          body: await hit.text(),
          contentType: hit.headers.get('content-type'),
          lastModified: hit.headers.get(LAST_MODIFIED_HEADER),
          fetchedAt,
        };
      } catch {
        return undefined;
      }
    },
    async put(url, value, ttlSeconds) {
      try {
        const headers: Record<string, string> = {
          'cache-control': `public, max-age=${ttlSeconds}`,
          [FETCHED_AT_HEADER]: value.fetchedAt,
        };
        if (value.contentType) headers['content-type'] = value.contentType;
        if (value.lastModified) headers[LAST_MODIFIED_HEADER] = value.lastModified;
        await cache.put(url, new Response(value.body, { headers }));
      } catch {
        // A broken cache is a miss, never an error.
      }
    },
  };
}
