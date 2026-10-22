import * as z from 'zod';
import { definePrompt } from '../capability';

export const explainDecisionPrompt = definePrompt({
  name: 'explain-decision',
  title: 'Explain an infrastructure decision',
  description:
    'Explain why Bioconductor infrastructure works the way it does on a topic, from its architecture ' +
    'decision records (ADRs): searches the ADRs, reads the relevant one, and answers quoting it with links.',
  args: z.object({
    topic: z.string().min(1).max(200).describe('The decision or design question, e.g. "why are client addresses hashed"'),
  }),
  tools: ['docs_search', 'docs_read'],
  render: ({ topic }) =>
    [
      `Explain the Bioconductor infrastructure decision about: ${topic}`,
      '',
      `1. Call docs_search with query ${JSON.stringify(topic)} and source "adr". If no ADR is relevant, call docs_search again without source.`,
      "2. Call docs_read with the url of the most relevant hit. An ADR's status, context, decision and consequences matter most; read further hits only if the first does not settle the question.",
      "3. Answer: state the decision, then why it was made and what it trades away. Quote the ADR's own words in short block quotes and link each quote to the url docs_read returned. Name the ADR by number and title, and give its status (for example \"Superseded by 0012\") when the page states one.",
      '4. If the docs record no decision on this topic, say so plainly and list the closest pages you found. Do not guess.',
    ].join('\n'),
});
