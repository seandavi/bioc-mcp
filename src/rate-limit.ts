import type { MiddlewareHandler } from 'hono';
import type { Transport, UsageSink } from './usage';

/** The Workers rate-limit binding's shape (env.RATE_LIMITER satisfies it). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Must equal simple.period of RATE_LIMITER in wrangler.jsonc. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** One limiter key per client address (cf-connecting-ip, else 'unknown'). Fails open. */
export function rateLimitMiddleware(limiter: RateLimiter, usage: UsageSink, transport: Transport): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header('cf-connecting-ip') ?? 'unknown';
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
