import * as z from 'zod';

export type ErrorCode =
  | 'invalid_input' // REST 400
  | 'not_found' // REST 404
  | 'upstream_error' // REST 502: upstream unreachable, non-2xx other than 404, or unparseable
  | 'upstream_timeout' // REST 502
  | 'result_too_large' // REST 500: a capability bug; the size guard caught it
  | 'internal'; // REST 500

export class CapabilityError extends Error {
  readonly code: ErrorCode;
  readonly details: { upstream?: string; url?: string; status?: number };

  constructor(code: ErrorCode, message: string, details: CapabilityError['details'] = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): 400 | 404 | 500 | 502 {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'upstream_error':
    case 'upstream_timeout':
      return 502;
    case 'result_too_large':
    case 'internal':
      return 500;
  }
}

// REST error body, also used for the 404 on unknown toolsets and unknown routes.
export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).catchall(z.unknown()),
});
