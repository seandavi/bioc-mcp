import { expect, test } from 'vitest';
import { CapabilityError, httpStatusFor, type ErrorCode } from '../src/errors';

test.each<[ErrorCode, number]>([
  ['invalid_input', 400],
  ['not_found', 404],
  ['upstream_error', 502],
  ['upstream_timeout', 502],
  ['result_too_large', 500],
  ['internal', 500],
])('httpStatusFor(%s) is %i', (code, status) => {
  expect(httpStatusFor(code)).toBe(status);
});

test('CapabilityError carries code and details', () => {
  const error = new CapabilityError('upstream_error', 'boom', { status: 500 });
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('upstream_error');
  expect(error.details).toEqual({ status: 500 });
});
