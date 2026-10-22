import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import * as z from 'zod';
import { AboutSchema, buildAbout } from '../core/about';
import type { Deps } from '../core/deps';
import { invokeCapability } from '../core/invoke';
import { restPath, type Module } from '../core/registry';
import { ErrorBodySchema, httpStatusFor } from '../errors';
import type { UsageSink } from '../usage';
import { VERSION } from '../version';

export interface RestAppOptions {
  modules: readonly Module[];
  deps: Deps;
  usage: UsageSink;
}

interface QueryProperty {
  type?: string;
  items?: { type?: string };
}

const propertiesBySchema = new WeakMap<z.ZodObject, Record<string, QueryProperty>>();

function propertiesOf(input: z.ZodObject): Record<string, QueryProperty> {
  let properties = propertiesBySchema.get(input);
  if (!properties) {
    properties = (z.toJSONSchema(input, { io: 'input' }) as { properties?: Record<string, QueryProperty> })
      .properties ?? {};
    propertiesBySchema.set(input, properties);
  }
  return properties;
}

function coerceScalar(value: string, type: string | undefined): string | number | boolean {
  if ((type === 'integer' || type === 'number') && value !== '') return Number(value);
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

/** Query string → input object, typed by the input's JSON Schema. Unknown parameters are ignored. */
export function queryToInput(input: z.ZodObject, params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(propertiesOf(input))) {
    const values = params.getAll(name);
    const last = values.at(-1);
    if (last === undefined) continue;
    result[name] =
      property.type === 'array'
        ? values.map((value) => coerceScalar(value, property.items?.type))
        : coerceScalar(last, property.type);
  }
  return result;
}

const json = <S extends z.ZodType>(schema: S, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const tooManyRequests = json(
  ErrorBodySchema,
  'Too many requests from this client address; wait Retry-After seconds',
);

/** OpenAPIHono with full paths: /api/v1/<module>/<cap>, /api/v1/about, /api/openapi.json. */
export function createRestApp({ modules, deps, usage }: RestAppOptions): OpenAPIHono {
  const api = new OpenAPIHono();

  for (const capability of modules.flatMap((module) => module.capabilities)) {
    const path = restPath(capability);
    const route = createRoute({
      method: 'get',
      path,
      operationId: capability.name,
      tags: [capability.module],
      summary: capability.title,
      description: capability.description,
      request: { query: capability.input },
      responses: {
        200: json(capability.output, 'The result envelope (same as MCP structuredContent)'),
        400: json(ErrorBodySchema, 'Invalid input'),
        404: json(ErrorBodySchema, 'Not found upstream'),
        429: tooManyRequests,
        500: json(ErrorBodySchema, 'Server error'),
        502: json(ErrorBodySchema, 'Upstream failed or timed out'),
      },
    });
    // Document the route without attaching zod-openapi's query validator: query values are
    // strings, so we coerce with queryToInput and validate with the schema MCP uses.
    api.openAPIRegistry.registerPath(route);
    api.get(path, async (c) => {
      const input = queryToInput(capability.input, new URL(c.req.url).searchParams);
      const result = await invokeCapability(capability, input, deps, { transport: 'rest', usage });
      if (result.ok) return c.json(result.envelope, 200);
      return c.json(
        { error: { code: result.error.code, message: result.error.message } },
        httpStatusFor(result.error.code),
      );
    });
  }

  api.openAPIRegistry.registerPath(
    createRoute({
      method: 'get',
      path: '/api/v1/about',
      operationId: 'about',
      tags: ['meta'],
      summary: 'About this server',
      description: 'Modules, tools, upstream sources and their cache TTLs (same JSON as the bioc://about resource).',
      responses: { 200: json(AboutSchema, 'Server description'), 429: tooManyRequests },
    }),
  );
  api.get('/api/v1/about', (c) => c.json(buildAbout(modules), 200));

  api.doc31('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Bioconductor MCP REST API',
      version: VERSION,
      description: 'Read-only REST mirror of the bioc-mcp tools. Unstable until v1.',
    },
    tags: modules.map((module) => ({ name: module.name, description: module.description })),
  });
  return api;
}
