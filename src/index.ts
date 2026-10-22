import { Hono } from 'hono';
import { modules as registryModules, validateRegistry, type Module } from './core/registry';
import type { Deps } from './core/deps';
import { createMcpApp } from './transports/mcp';
import { createRestApp } from './transports/rest';
import { createCloudflareCache } from './upstreams/cache';
import { githubTokenWarning } from './upstreams/github';
import { parseConfig, type AppConfig } from './config';
import { rateLimitMiddleware, type RateLimiter } from './rate-limit';
import { createAnalyticsEngineSink, type UsageSink } from './usage';

export function createApp(options: {
  config: AppConfig;
  deps: Deps;
  usage: UsageSink;
  rateLimiter: RateLimiter;
  modules?: readonly Module[];
}): Hono {
  const modules = options.modules ?? registryModules;
  validateRegistry(modules);
  const app = new Hono();
  app.use('/mcp/*', rateLimitMiddleware(options.rateLimiter, options.usage, 'mcp'));
  app.use('/api/*', rateLimitMiddleware(options.rateLimiter, options.usage, 'rest'));
  app.route('/mcp', createMcpApp({ modules, deps: options.deps, usage: options.usage, config: options.config }));
  app.route('/', createRestApp({ modules, deps: options.deps, usage: options.usage }));
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}. MCP: /mcp. REST: /api/v1 (OpenAPI at /api/openapi.json).`,
        },
      },
      404,
    ),
  );
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });
  return app;
}

let app: Hono | undefined;

export default {
  fetch(request, env, ctx) {
    // Built on the first request because bindings arrive with the request.
    if (!app) {
      const warning = githubTokenWarning(env);
      if (warning) console.warn(warning);
      app = createApp({
        config: parseConfig(env),
        deps: {
          fetch: (r) => fetch(r), // wrapper: never store the bare global fetch on an object
          cache: createCloudflareCache(caches.default),
          now: () => new Date(),
          env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
        },
        usage: createAnalyticsEngineSink(env.USAGE),
        rateLimiter: env.RATE_LIMITER,
      });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
