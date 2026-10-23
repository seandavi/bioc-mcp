import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAnalyticsEngineSink, createMemoryUsageSink, type UsageEvent } from '../src/usage';

const okEvent: UsageEvent = {
  transport: 'rest',
  capability: 'example_item',
  latency_ms: 12,
  upstream_status: 200,
  ok: true,
  error_code: null,
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAnalyticsEngineSink', () => {
  test('writes the dataset layout for an ok event', () => {
    const writeDataPoint = vi.fn();
    createAnalyticsEngineSink({ writeDataPoint }).record(okEvent);
    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ['rest'],
      blobs: ['rest', 'example_item', ''],
      doubles: [12, 200, 1],
    });
  });

  test('writes the error code and ok = 0 for a failed event', () => {
    const writeDataPoint = vi.fn();
    createAnalyticsEngineSink({ writeDataPoint }).record({
      ...okEvent,
      upstream_status: 404,
      ok: false,
      error_code: 'not_found',
    });
    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.blobs[2]).toBe('not_found');
    expect(point.doubles).toEqual([12, 404, 0]);
  });

  test('swallows a writeDataPoint that throws and logs usage', () => {
    const boom = new Error('boom');
    const sink = createAnalyticsEngineSink({
      writeDataPoint: () => {
        throw boom;
      },
    });
    expect(() => sink.record(okEvent)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('usage', boom);
  });
});

describe('createMemoryUsageSink', () => {
  test('collects events in order', () => {
    const sink = createMemoryUsageSink();
    const second = { ...okEvent, capability: 'meta_ping' };
    sink.record(okEvent);
    sink.record(second);
    expect(sink.events).toEqual([okEvent, second]);
  });
});
