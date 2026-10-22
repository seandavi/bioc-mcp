import * as z from 'zod';
import { assertUpstream, type Upstream } from '../upstreams/http';
import type { Capability, Module, PromptDef } from './capability';
import { metaModule } from './meta';
import { docsModule } from './docs';
import { pkgModule } from './pkg';

export {
  defineCapability,
  definePrompt,
  type BundledDataset,
  type Capability,
  type Module,
  type PromptDef,
  type ResourceListing,
  type ResourceTemplateDef,
} from './capability';

/** Production registry. Later issues append their modules here. */
export const modules: readonly Module[] = [metaModule, pkgModule, docsModule];

const MODULE_NAME = /^[a-z]+$/;
const KEBAB_NAME = /^[a-z]+(-[a-z]+)*$/;
const CAPABILITY_NAME = /^[a-z]+_[a-z][a-z0-9_]*$/;
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

// Record<keyof Upstream, true> makes tsc fail when Upstream gains a field this list lacks.
const UPSTREAM_FIELDS: Record<keyof Upstream, true> = {
  id: true,
  name: true,
  baseUrl: true,
  ttlSeconds: true,
  timeoutMs: true,
  description: true,
};

function sameUpstream(a: Upstream, b: Upstream): boolean {
  return (Object.keys(UPSTREAM_FIELDS) as (keyof Upstream)[]).every((field) => a[field] === b[field]);
}

/** Throws Error with a specific message on the first violation. createApp calls it. */
export function validateRegistry(registered: readonly Module[]): void {
  const moduleNames = new Set<string>();
  const capabilityNames = new Set<string>();
  const upstreams = new Map<string, Upstream>();
  const templateNames = new Set<string>();
  const promptNames = new Set<string>();

  for (const module of registered) {
    if (!MODULE_NAME.test(module.name)) {
      throw new Error(`Module name "${module.name}" must match ${MODULE_NAME}`);
    }
    if (moduleNames.has(module.name)) throw new Error(`Duplicate module name "${module.name}"`);
    moduleNames.add(module.name);

    for (const upstream of module.upstreams) {
      const seen = upstreams.get(upstream.id);
      if (seen && !sameUpstream(seen, upstream)) {
        throw new Error(`Upstream "${upstream.id}" is declared twice with different fields (module "${module.name}")`);
      }
      assertUpstream(upstream);
      upstreams.set(upstream.id, upstream);
    }

    for (const capability of module.capabilities) {
      const label = `Capability "${capability.name}"`;
      if (capability.module !== module.name) {
        throw new Error(`${label} says module "${capability.module}" but is listed in module "${module.name}"`);
      }
      if (!CAPABILITY_NAME.test(capability.name) || !capability.name.startsWith(`${module.name}_`)) {
        throw new Error(`${label} must match ${CAPABILITY_NAME} and start with "${module.name}_"`);
      }
      if (capability.description.trim() === '') throw new Error(`${label} has an empty description`);
      if (capabilityNames.has(capability.name)) throw new Error(`Duplicate capability name "${capability.name}"`);
      capabilityNames.add(capability.name);
      assertRestCompatible(capability, label);
      assertIdempotentInput(capability, label);
    }

    for (const template of module.resources ?? []) {
      if (!KEBAB_NAME.test(template.name)) {
        throw new Error(`Resource template "${template.name}" must match ${KEBAB_NAME}`);
      }
      if (templateNames.has(template.name)) throw new Error(`Duplicate resource template name "${template.name}"`);
      templateNames.add(template.name);
      if (!template.uriTemplate.startsWith(`bioc://${module.name}/`)) {
        throw new Error(
          `Resource template "${template.name}" uriTemplate must start with "bioc://${module.name}/"`,
        );
      }
    }

    for (const prompt of module.prompts ?? []) {
      const label = `Prompt "${prompt.name}"`;
      if (!KEBAB_NAME.test(prompt.name)) throw new Error(`${label} must match ${KEBAB_NAME}`);
      if (promptNames.has(prompt.name)) throw new Error(`Duplicate prompt name "${prompt.name}"`);
      promptNames.add(prompt.name);
      if (prompt.description.trim() === '') throw new Error(`${label} has an empty description`);
      assertStringArguments(prompt, label);
    }
  }

  // Prompts may name tools of any module, so check once every capability is known.
  for (const module of registered) {
    for (const prompt of module.prompts ?? []) {
      for (const tool of prompt.tools) {
        if (!capabilityNames.has(tool)) throw new Error(`Prompt "${prompt.name}" names unknown tool "${tool}"`);
      }
    }
  }
}

function assertStringArguments(prompt: PromptDef, label: string): void {
  const schema = z.toJSONSchema(prompt.args, { io: 'input' }) as { properties?: Record<string, JsonSchemaProperty> };
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    if (property.type !== 'string') {
      throw new Error(`${label} argument "${field}" must be a string; MCP prompt arguments are strings`);
    }
  }
}

interface JsonSchemaProperty {
  type?: unknown;
  items?: { type?: unknown };
}

function assertRestCompatible(capability: Capability, label: string): void {
  const schema = z.toJSONSchema(capability.input, { io: 'input' }) as {
    properties?: Record<string, JsonSchemaProperty>;
  };
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const scalar = typeof property.type === 'string' && SCALAR_TYPES.has(property.type);
    const scalarArray =
      property.type === 'array' && typeof property.items?.type === 'string' && SCALAR_TYPES.has(property.items.type);
    if (!scalar && !scalarArray) {
      throw new Error(
        `${label} input field "${field}" cannot be carried by REST query strings; use string, number, integer, boolean, or arrays of them`,
      );
    }
  }
}

/** `/api/v1/<module>/<name without "<module>_">`, e.g. meta_ping → /api/v1/meta/ping. */
export function restPath(capability: Capability): string {
  return `/api/v1/${capability.module}/${capability.name.slice(capability.module.length + 1)}`;
}

/** Structural equality for JSON values; object key order does not matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}

/** `default` differs legitimately between io sides (.prefault sets it on input only). */
function withoutDefault(schema: unknown): unknown {
  const { default: _default, ...rest } = schema as Record<string, unknown>;
  return rest;
}

const IDEMPOTENT_RULE =
  'input schemas must accept their own output because MCP parses input twice (the SDK, then ' +
  'invokeCapability). Transform in the handler instead';

function assertIdempotentInput(capability: Capability, label: string): void {
  for (const [field, schema] of Object.entries(capability.input.shape)) {
    let output: unknown;
    try {
      output = z.toJSONSchema(schema, { io: 'output' });
    } catch {
      throw new Error(`${label} input field "${field}" has a transform; ${IDEMPOTENT_RULE}`);
    }
    const input = z.toJSONSchema(schema, { io: 'input' });
    if (!jsonEqual(withoutDefault(input), withoutDefault(output))) {
      throw new Error(`${label} input field "${field}" parses to a different type than it accepts; ${IDEMPOTENT_RULE}`);
    }
  }
}
