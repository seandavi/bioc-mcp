import * as z from 'zod';
import { UNIVERSES } from '../../upstreams/registry';

/** The universe a job id belongs to; required, because a job id exists in exactly one universe. */
export const UniverseOfJobSchema = z
  .enum(UNIVERSES)
  .describe("Universe the job id came from: 'bioc' (devel) or 'bioc-release'");
