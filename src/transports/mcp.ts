import {
  createMcpHandler,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { Context, Hono } from 'hono';
import { buildAbout } from '../core/about';
import type { Deps } from '../core/deps';
import { invokeCapability } from '../core/invoke';
import type { Module } from '../core/registry';
import type { AppConfig } from '../config';
import { CapabilityError } from '../errors';
import { VERSION } from '../version';

const MAX_REQUEST_BODY_BYTES = 65_536;

export interface McpAppOptions {
  modules: readonly Module[];
  deps: Deps;
  config: AppConfig;
}

/** 'docs+pkg' → modules in registry order, de-duplicated; any unknown or empty segment fails. */
export function parseToolset(
  segment: string,
  modules: readonly Module[],
): { ok: true; selected: Module[] } | { ok: false; unknown: string[] } {
  const requested = segment.split('+');
  const known = new Set(modules.map((module) => module.name));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, selected: modules.filter((module) => requested.includes(module.name)) };
}

/** One McpServer exposing `selected` modules' tools plus bioc://about for `all`. */
export function buildMcpServer(all: readonly Module[], selected: readonly Module[], deps: Deps): McpServer {
  const server = new McpServer(
    { name: 'bioc-mcp', version: VERSION },
    {
      instructions:
        'Read-only access to public Bioconductor infrastructure data. Every tool result ' +
        'carries `sources` (URL and as_of, the freshness of that data); cite them. Read bioc://about ' +
        'for the modules, tools and upstream sources covered and their cache TTLs.',
      cacheHints: {
        'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
        'resources/read': { ttlMs: 300_000, cacheScope: 'public' },
      },
      maxToolInputElements: 1000,
    },
  );

  for (const capability of selected.flatMap((module) => module.capabilities)) {
    server.registerTool(
      capability.name,
      {
        title: capability.title,
        description: capability.description,
        inputSchema: capability.input,
        outputSchema: capability.output,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      // The SDK validates args against inputSchema before this callback runs. Its failures come back
      // as isError text "Input validation error: Invalid arguments for tool <name>: …", not
      // "invalid_input: …"; REST reports the same failure as 400 invalid_input.
      async (args: Record<string, unknown>) => {
        const result = await invokeCapability(capability, args, deps);
        return result.ok
          ? { content: [{ type: 'text' as const, text: result.envelope.summary }], structuredContent: result.envelope }
          : {
              content: [{ type: 'text' as const, text: `${result.error.code}: ${result.error.message}` }],
              isError: true,
            };
      },
    );
  }

  const toolNames = new Set(selected.flatMap((module) => module.capabilities.map((c) => c.name)));
  for (const module of selected) {
    for (const def of module.resources ?? []) {
      server.registerResource(
        def.name,
        new ResourceTemplate(def.uriTemplate, {
          list: () => ({ resources: def.list().map((r) => ({ ...r, mimeType: def.mimeType })) }),
        }),
        { title: def.title, description: def.description, mimeType: def.mimeType },
        (uri) => {
          let text: string;
          try {
            text = def.read(uri.href);
          } catch (error) {
            if (error instanceof CapabilityError && error.code === 'not_found') {
              throw new ResourceNotFoundError(uri.href, error.message);
            }
            throw error;
          }
          return { contents: [{ uri: uri.href, mimeType: def.mimeType, text }] };
        },
      );
    }
    for (const prompt of module.prompts ?? []) {
      if (!prompt.tools.every((tool) => toolNames.has(tool))) continue;
      server.registerPrompt(
        prompt.name,
        { title: prompt.title, description: prompt.description, argsSchema: prompt.args },
        (args) => ({
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.render(args) } }],
        }),
      );
    }
  }

  server.registerResource(
    'about',
    'bioc://about',
    {
      title: 'About this server',
      description: 'Modules, tools, upstream sources and their cache TTLs.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(buildAbout(all)) }],
    }),
  );
  return server;
}

/** Hono app to mount at /mcp: serves `/` (all modules) and `/:toolset`. */
export function createMcpApp({ modules, deps, config }: McpAppOptions): Hono {
  const app = createMcpHonoApp({
    host: '0.0.0.0', // not localhost: the allowlists below apply instead
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });

  // One handler per toolset; the server factory still runs per request, as the SDK requires.
  const handlers = new Map<string, McpHttpHandler>();
  const handlerFor = (selected: readonly Module[]): McpHttpHandler => {
    const key = selected.map((module) => module.name).join('+');
    let handler = handlers.get(key);
    if (!handler) {
      handler = createMcpHandler(() => buildMcpServer(modules, selected, deps), {
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        onerror: (error) => console.error('mcp', error),
      });
      handlers.set(key, handler);
    }
    return handler;
  };

  app.all('/', (c: Context) => handlerFor(modules).fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));

  app.all('/:toolset', async (c: Context) => {
    const parsed = parseToolset(c.req.param('toolset') ?? '', modules);
    if (!parsed.ok) {
      const valid = modules.map((module) => module.name);
      return c.json(
        {
          error: {
            code: 'unknown_module',
            message:
              `Unknown module(s): ${parsed.unknown.join(', ')}. Valid modules: ${valid.join(', ')}. ` +
              'Use /mcp for every module, or /mcp/<module>[+<module>…].',
            unknown: parsed.unknown,
            valid,
          },
        },
        404,
      );
    }
    return handlerFor(parsed.selected).fetch(c.req.raw, { parsedBody: c.get('parsedBody') });
  });

  return app;
}
