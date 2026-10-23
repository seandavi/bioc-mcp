import * as z from 'zod';
import { envelopeSchema, type Envelope } from '../envelope';
import type { Upstream } from '../upstreams/http';
import type { DatasetInput } from './about';
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

/** One entry of a resource template's `resources/list`; mimeType comes from the template. */
export interface ResourceListing {
  uri: string; // matches the template, e.g. 'bioc://docs/adr/0009-client-addresses-are-hashed-at-the-edge.html'
  name: string; // the template variable's value, e.g. 'adr/0009-client-addresses-are-hashed-at-the-edge.html'
  title: string;
  description: string;
}

/** An MCP resource template. MCP only: REST reaches the same data through a capability. */
export interface ResourceTemplateDef {
  name: string; // /^[a-z]+(-[a-z]+)*$/, unique across modules; MCP template name
  uriTemplate: string; // RFC 6570, starts with `bioc://<module>/`; use {+var} for values containing '/'
  title: string;
  description: string;
  mimeType: string;
  list(): ResourceListing[];
  /** Full text at `uri`. Throws CapabilityError('not_found', message) when nothing is there. */
  read(uri: string): string;
}

/** An MCP prompt. MCP only: prompts have no REST form. */
export interface PromptDef<A extends z.ZodObject = z.ZodObject> {
  name: string; // /^[a-z]+(-[a-z]+)*$/, unique across modules
  title: string;
  description: string;
  args: A; // flat object of string fields: MCP prompt arguments are strings
  tools: readonly string[]; // every capability the prompt text tells the model to call
  // Method syntax on purpose: bivariant parameters let PromptDef<Specific> sit in PromptDef[].
  render(args: z.output<A>): string; // text of the single user message
}

export function definePrompt<A extends z.ZodObject>(def: PromptDef<A>): PromptDef<A> {
  return def;
}

/** Data built ahead of time and bundled with the Worker; listed by bioc://about. */
export interface BundledDataset {
  id: string; // kebab-case, e.g. 'docs-index'
  description: string;
  built_at: string; // ISO 8601
  build_commit: string | null;
  age_days: number; // whole days since built_at
  possibly_stale: string[]; // every warning for the dataset and its inputs; [] when none
  inputs: DatasetInput[]; // each input URL with its as_of, source commit and warning
}

export interface Module {
  name: string; // /^[a-z]+$/; also the toolset path segment
  description: string;
  upstreams: Upstream[]; // every upstream its capabilities call; listed by bioc://about
  capabilities: Capability[];
  resources?: readonly ResourceTemplateDef[]; // registered when the module is in the toolset
  prompts?: readonly PromptDef[]; // registered when the toolset has every tool in prompt.tools
  datasets?: (now: Date) => BundledDataset[]; // called by buildAbout; may load bundled data on first call
}
