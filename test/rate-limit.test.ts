import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rateLimitKey, type RateLimiter } from '../src/rate-limit';
import { appFetch, makeTestApp } from './support/app';

const REFUSED_BODY = {
  error: { code: 'rate_limited', message: 'Too many requests from this address. Wait 60 seconds and try again.' },
};

function limiter(success: boolean) {
  const limit = vi.fn<RateLimiter['limit']>(async () => ({ success }));
  return { limit, rateLimiter: { limit } satisfies RateLimiter };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rateLimitKey', () => {
  test.each([
    [undefined, 'unknown'],
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['fe80::1%eth0', 'fe80::1%eth0'],
    ['1::2::3', '1::2::3'],
    ['1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8:9'],
    ['1:2:3:4:5:6:7::8', '1:2:3:4:5:6:7::8'],
    ['2001:db8:1:2:3:4:5:g', '2001:db8:1:2:3:4:5:g'],
  ])('%s → %s', (address, key) => {
    expect(rateLimitKey(address)).toBe(key);
  });
});

describe('rate limiting', () => {
  test.each([
    ['POST', '/mcp', 'mcp'],
    ['POST', '/mcp/example', 'mcp'],
    ['GET', '/api/v1/meta/ping', 'rest'],
    ['GET', '/api/openapi.json', 'rest'],
  ])('%s %s is refused with 429 when the limiter says no', async (method, path, transport) => {
    const { rateLimiter } = limiter(false);
    const { app, usage } = makeTestApp({ rateLimiter });
    const response = await appFetch(app)('http://test.local' + path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual(REFUSED_BODY);
    expect(usage.events).toEqual([
      { transport, capability: '', latency_ms: 0, upstream_status: 0, ok: false, error_code: 'rate_limited' },
    ]);
  });

  test.each(['/', '/mcpx'])('GET %s stays 404 and never calls the limiter', async (path) => {
    const { limit, rateLimiter } = limiter(false);
    const { app } = makeTestApp({ rateLimiter });
    const response = await appFetch(app)('http://test.local' + path);
    expect(response.status).toBe(404);
    expect(limit).not.toHaveBeenCalled();
  });

  test('the key is cf-connecting-ip, the same on MCP and REST', async () => {
    const { limit, rateLimiter } = limiter(true);
    const { app } = makeTestApp({ rateLimiter });
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    await appFetch(app)('http://test.local/mcp', { method: 'POST', body: '{}', headers });
    await appFetch(app)('http://test.local/api/v1/meta/ping', { headers });
    expect(limit.mock.calls).toEqual([[{ key: '203.0.113.9' }], [{ key: '203.0.113.9' }]]);
  });

  test('addresses in one IPv6 /64 share a key; a neighbouring /64 gets its own', async () => {
    const { limit, rateLimiter } = limiter(true);
    const { app } = makeTestApp({ rateLimiter });
    for (const address of ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:3::1']) {
      await appFetch(app)('http://test.local/api/v1/meta/ping', { headers: { 'cf-connecting-ip': address } });
    }
    expect(limit.mock.calls).toEqual([
      [{ key: '2001:db8:1:2::/64' }],
      [{ key: '2001:db8:1:2::/64' }],
      [{ key: '2001:db8:1:3::/64' }],
    ]);
  });

  test("the key is 'unknown' without the header", async () => {
    const { limit, rateLimiter } = limiter(true);
    const { app } = makeTestApp({ rateLimiter });
    await appFetch(app)('http://test.local/api/v1/meta/ping');
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: 'unknown' });
  });

  test('a limiter that rejects lets the request through and logs rate-limit', async () => {
    const boom = new Error('limiter down');
    const { app } = makeTestApp({ rateLimiter: { limit: async () => Promise.reject(boom) } });
    const response = await appFetch(app)('http://test.local/api/v1/meta/ping');
    expect(response.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith('rate-limit', boom);
  });

  test('an allowing limiter serves normally', async () => {
    const { rateLimiter } = limiter(true);
    const { app, usage } = makeTestApp({ rateLimiter });
    const response = await appFetch(app)('http://test.local/api/v1/meta/ping');
    expect(response.status).toBe(200);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(usage.events.map((event) => event.capability)).toEqual(['meta_ping']);
  });
});
