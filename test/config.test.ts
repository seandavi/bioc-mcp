import { describe, expect, test } from 'vitest';
import { parseConfig } from '../src/index';

describe('parseConfig', () => {
  test('splits on commas, trims and drops empties', () => {
    expect(parseConfig({ ALLOWED_HOSTS: ' a.test, b.test ,,', ALLOWED_ORIGINS: 'c.test' })).toEqual({
      allowedHosts: ['a.test', 'b.test'],
      allowedOrigins: ['c.test'],
    });
  });

  test('allowed origins may be empty', () => {
    expect(parseConfig({ ALLOWED_HOSTS: 'a.test' }).allowedOrigins).toEqual([]);
  });

  test.each([undefined, '', ' , '])('fails closed when ALLOWED_HOSTS is %j', (hosts) => {
    expect(() => parseConfig(hosts === undefined ? {} : { ALLOWED_HOSTS: hosts })).toThrow(/ALLOWED_HOSTS/);
  });
});
