import * as z from 'zod';
import { assertEnvelopeSize, type Envelope } from '../envelope';
import { CapabilityError } from '../errors';
import type { Transport, UsageSink } from '../usage';
import type { Deps } from './deps';
import type { Capability } from './registry';

export type InvokeResult<T = unknown> =
  | { ok: true; envelope: Envelope<T> }
  | { ok: false; error: CapabilityError };

export interface InvokeContext {
  transport: Transport;
  usage: UsageSink;
}

/** The one place a capability runs; both transports call only this. Records one usage event. */
export async function invokeCapability(
  capability: Capability,
  rawInput: unknown,
  deps: Deps,
  context: InvokeContext,
): Promise<InvokeResult> {
  const startedAt = deps.now().getTime();
  let upstreamStatus = 0;
  // Wraps fetch for this call only, so upstream_status needs nothing from adapters or fetchUpstream.
  const traced: Deps = {
    ...deps,
    fetch: async (request) => {
      const response = await deps.fetch(request);
      if (response.status < 300 || response.status > 399) upstreamStatus = Math.max(upstreamStatus, response.status);
      return response;
    },
  };
  const result = await runCapability(capability, rawInput, traced);
  context.usage.record({
    transport: context.transport,
    capability: capability.name,
    latency_ms: deps.now().getTime() - startedAt,
    upstream_status: upstreamStatus,
    ok: result.ok,
    error_code: result.ok ? null : result.error.code,
  });
  return result;
}

async function runCapability(capability: Capability, rawInput: unknown, deps: Deps): Promise<InvokeResult> {
  const parsed = capability.input.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: new CapabilityError('invalid_input', z.prettifyError(parsed.error)) };
  }

  let envelope: Envelope<unknown>;
  try {
    envelope = await capability.handler(parsed.data, deps);
  } catch (error) {
    if (error instanceof CapabilityError) return { ok: false, error };
    console.error(capability.name, error);
    return { ok: false, error: new CapabilityError('internal', `${capability.name} failed unexpectedly`) };
  }

  const output = capability.output.safeParse(envelope);
  if (!output.success) {
    console.error(capability.name, output.error);
    return {
      ok: false,
      error: new CapabilityError('internal', `${capability.name} produced output that does not match its schema`),
    };
  }
  // Return the parsed value so fields the output schema does not declare never leave the server.
  // Size that value, not the handler's: an output-side .default() or .transform() can add bytes.
  const sent = output.data as Envelope<unknown>;
  try {
    assertEnvelopeSize(sent, capability.name);
  } catch (error) {
    if (error instanceof CapabilityError) return { ok: false, error };
    throw error;
  }
  return { ok: true, envelope: sent };
}
