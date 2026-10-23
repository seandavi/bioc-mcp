import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { DocsSearchInputSchema } from '../../src/core/docs/search';

export const DocsEvalQuestionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), // kebab-case, unique in the set
  question: DocsSearchInputSchema.shape.query, // sent verbatim as docs_search `query`
  answers: z
    .array(z.url({ protocol: /^https$/ })) // record URLs (docs_search hit.url); any one counts
    .min(1)
    .refine((answers) => new Set(answers).size === answers.length, 'answers must be unique'),
  from: z.string().min(1), // where the question came from: an issue, ADR, skill or runbook
});
export type DocsEvalQuestion = z.infer<typeof DocsEvalQuestionSchema>;

export const DocsEvalSetSchema = z
  .strictObject({ questions: z.array(DocsEvalQuestionSchema).min(1) })
  .refine((set) => new Set(set.questions.map((q) => q.id)).size === set.questions.length, 'question ids must be unique');
export type DocsEvalSet = z.infer<typeof DocsEvalSetSchema>;

/** YAML text → validated set. Throws Error(`docs-questions.yaml: ${z.prettifyError(…)}`). */
export function parseDocsEvalQuestions(yamlText: string): DocsEvalSet {
  const result = DocsEvalSetSchema.safeParse(parseYaml(yamlText));
  if (!result.success) throw new Error(`docs-questions.yaml: ${z.prettifyError(result.error)}`);
  return result.data;
}
