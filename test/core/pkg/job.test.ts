import { describe, expect, test } from 'vitest';
import { JobIdSchema, UniverseOfJobSchema } from '../../../src/core/pkg/job';
import { jobUrl } from '../../../src/upstreams/registry';

describe('JobIdSchema', () => {
  test.each(['96299707840', '1', '91650205691', '9'.repeat(20)])('accepts %j', (job) => {
    expect(JobIdSchema.safeParse(job).success).toBe(true);
  });

  test.each(['abc', '0123', '0', '1e5', '-1', '12 3', '../1', '1/2', '', '1'.repeat(21), ' 123', '123\n'])(
    'rejects %j',
    (job) => {
      expect(JobIdSchema.safeParse(job).success).toBe(false);
    },
  );

  test('rejects a number', () => {
    expect(JobIdSchema.safeParse(96299707840).success).toBe(false);
  });
});

test('jobUrl is the GitHub runs page', () => {
  expect(jobUrl('bioc', '117752915543')).toBe('https://github.com/r-universe/bioc/runs/117752915543');
  expect(jobUrl('bioc-release', '1')).toBe('https://github.com/r-universe/bioc-release/runs/1');
});

describe('UniverseOfJobSchema', () => {
  test.each(['bioc', 'bioc-release'])('accepts %j', (universe) => {
    expect(UniverseOfJobSchema.safeParse(universe).success).toBe(true);
  });

  test.each(['cran', '', 'BIOC'])('rejects %j', (universe) => {
    expect(UniverseOfJobSchema.safeParse(universe).success).toBe(false);
  });
});
