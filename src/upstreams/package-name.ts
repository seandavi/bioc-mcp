import * as z from 'zod';

/** R package name: starts with a letter, letters/digits/'.', at least two characters, no trailing '.'. */
export const PackageNameSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(
    /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/,
    "Not a valid R package name: it must start with a letter, contain only letters, digits and '.', and not end with '.'",
  )
  .describe('Package name, case-sensitive, e.g. "edgeR"');
