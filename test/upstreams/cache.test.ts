import { describe, expect, test } from 'vitest';
import { createCloudflareCache, createMemoryCache, type CachedUpstream } from '../../src/upstreams/cache';

const value: CachedUpstream = {
  url: 'https://upstream.test/a',
  body: '{"a":1}',
  contentType: 'application/json',
  lastModified: '2026-09-01T00:00:00.000Z',
  fetchedAt: '2026-10-22T12:00:00.000Z',
};

describe('createMemoryCache', () => {
  test('an entry expires when now() >= stored-at + ttl', async () => {
    let now = new Date('2026-10-22T12:00:00Z');
    const cache = createMemoryCache(() => now);
    await cache.put(value.url, value, 60);
    expect(await cache.get(value.url)).toEqual(value);
    now = new Date('2026-10-22T12:00:59.999Z');
    expect(await cache.get(value.url)).toEqual(value);
    now = new Date('2026-10-22T12:01:00Z');
    expect(await cache.get(value.url)).toBeUndefined();
  });

  test('a miss is undefined', async () => {
    expect(await createMemoryCache(() => new Date()).get('https://nope.test/')).toBeUndefined();
  });
});

describe('createCloudflareCache', () => {
  function fakeCache() {
    const store = new Map<string, Response>();
    return {
      store,
      async match(key: RequestInfo | URL) {
        return store.get(String(key))?.clone();
      },
      async put(key: RequestInfo | URL, response: Response) {
        store.set(String(key), response);
      },
    };
  }

  test('round-trips a value and sets cache-control from the ttl', async () => {
    const fake = fakeCache();
    const cache = createCloudflareCache(fake);
    await cache.put(value.url, value, 300);
    expect(fake.store.get(value.url)?.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await cache.get(value.url)).toEqual(value);
  });

  test('round-trips null contentType and lastModified', async () => {
    const cache = createCloudflareCache(fakeCache());
    const bare = { ...value, contentType: null, lastModified: null };
    await cache.put(bare.url, bare, 60);
    const hit = await cache.get(bare.url);
    expect(hit?.lastModified).toBeNull();
    expect(hit?.body).toBe(bare.body);
  });

  test('a miss is undefined', async () => {
    expect(await createCloudflareCache(fakeCache()).get('https://nope.test/')).toBeUndefined();
  });

  test('a throwing cache is a miss on get and a no-op on put', async () => {
    const broken = {
      async match(): Promise<Response | undefined> {
        throw new Error('cache down');
      },
      async put(): Promise<void> {
        throw new Error('cache down');
      },
    };
    const cache = createCloudflareCache(broken);
    expect(await cache.get(value.url)).toBeUndefined();
    await expect(cache.put(value.url, value, 60)).resolves.toBeUndefined();
  });
});
