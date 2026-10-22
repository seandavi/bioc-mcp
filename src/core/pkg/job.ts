import * as z from 'zod';
import { UNIVERSES } from '../../upstreams/registry';

/** GitHub Actions job id: digits, no leading zero. */
export const JobIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, 'Job ids are digits, e.g. "96299707840"')
  .describe('GitHub Actions job id from pkg_status (upstream.jobs[].job), as a string of digits, e.g. "96299707840"');

/** The universe a job id belongs to; required, because a job id exists in exactly one universe. */
export const UniverseOfJobSchema = z
  .enum(UNIVERSES)
  .describe("Universe the job id came from: 'bioc' (devel) or 'bioc-release'");
