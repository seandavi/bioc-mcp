import { parse as parseYaml } from 'yaml';
import * as z from 'zod';

const segment = /^[A-Za-z0-9._-]+$/;

export const DocsSourcesConfigSchema = z
  .strictObject({
    max_artifact_bytes: z.number().int().positive(),
    site_url: z.url({ protocol: /^https$/ }).refine((u) => u.endsWith('/'), 'site_url must end with "/"'),
    github_owner: z.string().regex(/^[A-Za-z0-9-]+$/),
    repos: z
      .array(
        z.strictObject({
          repo: z.string().regex(segment),
          ref: z.string().regex(segment), // a branch or tag without "/"
          files: z
            .array(z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/))
            .min(1),
        }),
      )
      .min(1),
  })
  .refine((c) => new Set(c.repos.map((r) => r.repo)).size === c.repos.length, 'each repo may appear once');
export type DocsSourcesConfig = z.infer<typeof DocsSourcesConfigSchema>;

/** YAML text → validated config. Throws Error(`docs-sources.yaml: ${z.prettifyError(…)}`). */
export function parseDocsSourcesConfig(yamlText: string): DocsSourcesConfig {
  const result = DocsSourcesConfigSchema.safeParse(parseYaml(yamlText));
  if (!result.success) throw new Error(`docs-sources.yaml: ${z.prettifyError(result.error)}`);
  return result.data;
}
