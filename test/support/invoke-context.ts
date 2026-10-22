import type { InvokeContext } from '../../src/core/invoke';
import { createMemoryUsageSink } from '../../src/usage';

/** A REST invoke context with a throwaway usage sink, for tests that call invokeCapability directly. */
export function testContext(): InvokeContext {
  return { transport: 'rest', usage: createMemoryUsageSink() };
}
