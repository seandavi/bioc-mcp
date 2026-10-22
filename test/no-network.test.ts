import { expect, test } from 'vitest';

test('the global fetch throws in tests', () => {
  expect(() => fetch('https://example.com/')).toThrow('Network access is disabled in tests');
});
