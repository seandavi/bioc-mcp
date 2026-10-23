import type { MiddlewareHandler } from 'hono';
import type { Transport, UsageSink } from './usage';

/** The Workers rate-limit binding's shape (env.RATE_LIMITER satisfies it). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Must equal simple.period of RATE_LIMITER in wrangler.jsonc. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

const HEXTET = /^[0-9a-f]{1,4}$/;

/**
 * The limiter key for a client address. An IPv6 client usually holds a whole /64, so an IPv6
 * address counts by its /64 prefix ("2001:db8:1:2::/64"); an IPv4-embedded IPv6 address
 * ("::ffff:203.0.113.9") by its IPv4 part; anything else, including text that does not parse,
 * as is. No address: 'unknown'.
 */
export function rateLimitKey(address: string | undefined): string {
  if (!address) return 'unknown';
  if (!address.includes(':')) return address;
  if (address.includes('.')) return address.slice(address.lastIndexOf(':') + 1);
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return address;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((group) => HEXTET.test(group))) return address;
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/** One limiter key per client address (an IPv6 /64 counts as one; rateLimitKey), else 'unknown'. Fails open. */
export function rateLimitMiddleware(limiter: RateLimiter, usage: UsageSink, transport: Transport): MiddlewareHandler {
  return async (c, next) => {
    const key = rateLimitKey(c.req.header('cf-connecting-ip'));
    let success = true;
    try {
      ({ success } = await limiter.limit({ key }));
    } catch (error) {
      console.error('rate-limit', error);
    }
    if (success) {
      await next();
      return;
    }
    usage.record({
      transport,
      capability: '',
      latency_ms: 0,
      upstream_status: 0,
      ok: false,
      error_code: 'rate_limited',
    });
    c.header('retry-after', String(RATE_LIMIT_PERIOD_SECONDS));
    return c.json(
      {
        error: {
          code: 'rate_limited',
          message: `Too many requests from this address. Wait ${RATE_LIMIT_PERIOD_SECONDS} seconds and try again.`,
        },
      },
      429,
    );
  };
}
