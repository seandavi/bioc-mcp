import * as z from 'zod';
import { CapabilityError } from './errors';

export const SourceSchema = z.object({
  url: z.string().describe('Public URL the data came from'),
  as_of: z
    .string()
    .describe(
      "ISO 8601 date or date-time: the upstream's own data timestamp when it publishes one, else its Last-Modified, else when this server fetched it",
    ),
});
export type Source = z.infer<typeof SourceSchema>;

export function envelopeSchema<D extends z.ZodType>(data: D) {
  return z.object({
    data,
    summary: z.string().describe('One or two sentences answering the question; the first MCP text content block'),
    sources: z.array(SourceSchema).describe('Provenance: every upstream URL used, with freshness'),
  });
}

export interface Envelope<T> {
  data: T;
  summary: string;
  sources: Source[];
}

export const MAX_RESULT_BYTES = 8192;

const encoder = new TextEncoder();

/** UTF-8 byte length of JSON.stringify(envelope). */
export function envelopeBytes(envelope: Envelope<unknown>): number {
  return encoder.encode(JSON.stringify(envelope)).length;
}

/** UTF-8 bytes `s` occupies inside a JSON string: encode(JSON.stringify(s)).length - 2. */
export function jsonTextBytes(s: string): number {
  return encoder.encode(JSON.stringify(s)).length - 2;
}

/**
 * MCP text content for a successful result: the summary, then JSON of data and sources, so
 * clients that pass only text to the model see the same facts as structuredContent. Its UTF-8
 * size is envelopeBytes(envelope) − 13 − the summary's JSON escapes, so assertEnvelopeSize bounds it.
 */
export function envelopeTextBlocks(envelope: Envelope<unknown>): [summary: string, data: string] {
  return [envelope.summary, JSON.stringify({ data: envelope.data, sources: envelope.sources })];
}

/**
 * Rejects, never truncates: structured data cannot be cut generically. It also bounds the MCP text
 * content (see envelopeTextBlocks).
 */
export function assertEnvelopeSize(envelope: Envelope<unknown>, tool: string): void {
  const bytes = envelopeBytes(envelope);
  if (bytes > MAX_RESULT_BYTES) {
    throw new CapabilityError(
      'result_too_large',
      `${tool} returned ${bytes} bytes; the limit is ${MAX_RESULT_BYTES}. If the tool takes a limit or filter, narrow the request; otherwise this is a server bug, please report it at https://github.com/seandavi/bioc-mcp/issues.`,
    );
  }
}
