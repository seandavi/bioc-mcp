import * as z from 'zod';
import type { Universe } from '../../upstreams/registry';

// Type-only import of Universe: registry.ts imports jobUrl from here, so a value import
// (UNIVERSES) would be a cycle. UniverseOfJobSchema therefore lives in universe.ts.

/** GitHub Actions job id: digits, no leading zero. */
export const JobIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, 'Job ids are digits, e.g. "96299707840"')
  .describe('GitHub Actions job id from pkg_status (upstream.jobs[].job), as a string of digits, e.g. "96299707840"');

/** The job's GitHub page. GitHub resolves /runs/{job} without the run id. Built, never fetched. */
export function jobUrl(universe: Universe, job: string): string {
  return `https://github.com/r-universe/${universe}/runs/${job}`;
}
