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
    summary: z.string().describe('One or two sentences answering the question; the MCP text content'),
    sources: z.array(SourceSchema).describe('Provenance: every upstream URL used, with freshness'),
  });
}

export interface Envelope<T> {
  data: T;
  summary: string;
  sources: Source[];
}

export const MAX_RESULT_BYTES = 8192;

/** UTF-8 byte length of JSON.stringify(envelope). */
export function envelopeBytes(envelope: Envelope<unknown>): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).length;
}

/** Rejects, never truncates: structured data cannot be cut generically. */
export function assertEnvelopeSize(envelope: Envelope<unknown>, tool: string): void {
  const bytes = envelopeBytes(envelope);
  if (bytes > MAX_RESULT_BYTES) {
    throw new CapabilityError(
      'result_too_large',
      `${tool} returned ${bytes} bytes; the limit is ${MAX_RESULT_BYTES}. If the tool takes a limit or filter, narrow the request; otherwise this is a server bug, please report it at https://github.com/seandavi/bioc-mcp/issues.`,
    );
  }
}
