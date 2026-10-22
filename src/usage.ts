import type { ErrorCode } from './errors';

export type Transport = 'mcp' | 'rest';

/** One capability call, or one rate-limited request. Never carries argument values or client data. */
export interface UsageEvent {
  transport: Transport;
  capability: string; // tool name, e.g. 'pkg_status'; '' for a rate-limited request
  latency_ms: number; // deps.now() at the end minus at the start of invokeCapability
  upstream_status: number; // highest non-3xx upstream HTTP status seen in the call; 0 = none
  ok: boolean;
  error_code: ErrorCode | 'rate_limited' | null; // null when ok
}

export interface UsageSink {
  record(event: UsageEvent): void; // never throws
}

/**
 * Workers Analytics Engine. The data point layout is the dataset's schema (see wrangler.jsonc):
 * index1 = transport; blob1 = transport, blob2 = capability, blob3 = error_code ('' when ok);
 * double1 = latency_ms, double2 = upstream_status, double3 = ok (1 or 0). Append only.
 */
export function createAnalyticsEngineSink(dataset: Pick<AnalyticsEngineDataset, 'writeDataPoint'>): UsageSink {
  return {
    record(event) {
      try {
        dataset.writeDataPoint({
          indexes: [event.transport],
          blobs: [event.transport, event.capability, event.error_code ?? ''],
          doubles: [event.latency_ms, event.upstream_status, event.ok ? 1 : 0],
        });
      } catch (error) {
        console.error('usage', error);
      }
    },
  };
}

/** Collects events in memory; for tests and Node. */
export function createMemoryUsageSink(): UsageSink & { events: UsageEvent[] } {
  const events: UsageEvent[] = [];
  return {
    events,
    record(event) {
      events.push(event);
    },
  };
}
