import { Hono } from 'hono';
import { modules as registryModules, validateRegistry, type Module } from './core/registry';
import type { Deps } from './core/deps';
import { createMcpApp } from './transports/mcp';
import { createRestApp } from './transports/rest';
import { createCloudflareCache } from './upstreams/cache';
import { parseConfig, type AppConfig } from './config';

export function createApp(options: { config: AppConfig; deps: Deps; modules?: readonly Module[] }): Hono {
  const modules = options.modules ?? registryModules;
  validateRegistry(modules);
  const app = new Hono();
  app.route('/mcp', createMcpApp({ modules, deps: options.deps, config: options.config }));
  app.route('/', createRestApp({ modules, deps: options.deps }));
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

interface WorkerEnv extends Env {
  GITHUB_TOKEN?: string;
}

let app: Hono | undefined;

export default {
  fetch(request, env, ctx) {
    // Built on the first request because bindings arrive with the request.
    app ??= createApp({
      config: parseConfig(env),
      deps: {
        fetch: (r) => fetch(r), // wrapper: never store the bare global fetch on an object
        cache: createCloudflareCache(caches.default),
        now: () => new Date(),
        env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
      },
    });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
