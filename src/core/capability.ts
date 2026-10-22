import * as z from 'zod';
import { envelopeSchema, type Envelope } from '../envelope';
import type { Upstream } from '../upstreams/http';
import type { Deps } from './deps';

// Split from registry.ts so capability modules can import defineCapability without a cycle
// through the production `modules` list, which imports them.

export interface Capability<I extends z.ZodObject = z.ZodObject, D extends z.ZodType = z.ZodType> {
  module: string; // /^[a-z]+$/
  name: string; // `${module}_<verb_or_noun>`, /^[a-z]+_[a-z][a-z0-9_]*$/
  title: string; // short human title; MCP `title`, OpenAPI `summary`
  description: string; // what it answers; which tool to use instead
  input: I; // flat, REST-carriable, and accepts its own output (see validateRegistry)
  data: D; // schema of envelope.data
  output: ReturnType<typeof envelopeSchema<D>>; // = envelopeSchema(data), set by defineCapability
  // Method syntax on purpose: bivariant parameters let Capability<Specific> sit in Capability[].
  handler(input: z.output<I>, deps: Deps): Promise<Envelope<z.output<D>>>;
}

export function defineCapability<I extends z.ZodObject, D extends z.ZodType>(
  spec: Omit<Capability<I, D>, 'output'>,
): Capability<I, D> {
  return { ...spec, output: envelopeSchema(spec.data) };
}

export interface Module {
  name: string; // /^[a-z]+$/; also the toolset path segment
  description: string;
  upstreams: Upstream[]; // every upstream its capabilities call; listed by bioc://about
  capabilities: Capability[];
}
