import * as z from 'zod';
import type { Upstream } from '../upstreams/http';
import type { Capability, Module } from './capability';
import { metaModule } from './meta';

export { defineCapability, type Capability, type Module } from './capability';

/** Production registry. Later issues append their modules here. */
export const modules: readonly Module[] = [metaModule];

const MODULE_NAME = /^[a-z]+$/;
const CAPABILITY_NAME = /^[a-z]+_[a-z][a-z0-9_]*$/;
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** Throws Error with a specific message on the first violation. createApp calls it. */
export function validateRegistry(registered: readonly Module[]): void {
  const moduleNames = new Set<string>();
  const capabilityNames = new Set<string>();
  const upstreams = new Map<string, Upstream>();

  for (const module of registered) {
    if (!MODULE_NAME.test(module.name)) {
      throw new Error(`Module name "${module.name}" must match ${MODULE_NAME}`);
    }
    if (moduleNames.has(module.name)) throw new Error(`Duplicate module name "${module.name}"`);
    moduleNames.add(module.name);

    for (const upstream of module.upstreams) {
      const seen = upstreams.get(upstream.id);
      if (seen && JSON.stringify(seen) !== JSON.stringify(upstream)) {
        throw new Error(`Upstream "${upstream.id}" is declared twice with different fields (module "${module.name}")`);
      }
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
