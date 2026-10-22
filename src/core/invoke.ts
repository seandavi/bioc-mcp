import * as z from 'zod';
import { assertEnvelopeSize, type Envelope } from '../envelope';
import { CapabilityError } from '../errors';
import type { Deps } from './deps';
import type { Capability } from './registry';

export type InvokeResult<T = unknown> =
  | { ok: true; envelope: Envelope<T> }
  | { ok: false; error: CapabilityError };

/** The one place a capability runs; both transports call only this. */
export async function invokeCapability(
  capability: Capability,
  rawInput: unknown,
  deps: Deps,
): Promise<InvokeResult> {
  const parsed = capability.input.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: new CapabilityError('invalid_input', z.prettifyError(parsed.error)) };
  }

  let envelope: Envelope<unknown>;
  try {
    envelope = await capability.handler(parsed.data, deps);
    assertEnvelopeSize(envelope, capability.name);
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
  return { ok: true, envelope };
}
