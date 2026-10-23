import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocsEvalQuestions } from '../../scripts/docs-eval/questions';
import { fixtureDocsIndex } from '../support/docs';

const committed = readFileSync(join(import.meta.dirname, '..', '..', 'eval', 'docs-questions.yaml'), 'utf8');

describe('eval/docs-questions.yaml', () => {
  it('parses, has at least 30 questions and unique ids', () => {
    const { questions } = parseDocsEvalQuestions(committed);
    expect(questions.length).toBeGreaterThanOrEqual(30);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
  });

  it('names only answer URLs that are records of the fixture index', async () => {
    const recordUrls = new Set((await fixtureDocsIndex()).records.map((record) => record.url));
    const stale = parseDocsEvalQuestions(committed).questions.flatMap((q) =>
      q.answers.filter((url) => !recordUrls.has(url)).map((url) => `${q.id}: ${url}`),
    );
    expect(stale).toEqual([]);
  });
});

describe('parseDocsEvalQuestions', () => {
  const question = (overrides: Record<string, unknown> = {}) => ({
    id: 'one',
    question: 'How does it work?',
    answers: ['https://docs.test/a'],
    from: 'a test',
    ...overrides,
  });
  const yamlOf = (...questions: Record<string, unknown>[]) => JSON.stringify({ questions }); // JSON is YAML

  it('accepts a valid one-question set', () => {
    expect(parseDocsEvalQuestions(yamlOf(question())).questions).toHaveLength(1);
  });

  it.each([
    ['a duplicate id', yamlOf(question(), question())],
    ['an http: answer', yamlOf(question({ answers: ['http://docs.test/a'] }))],
    ['an empty answers', yamlOf(question({ answers: [] }))],
    ['a repeated answer', yamlOf(question({ answers: ['https://docs.test/a', 'https://docs.test/a'] }))],
    ['an unknown key', yamlOf(question({ extra: true }))],
    ['a question of 257 characters', yamlOf(question({ question: 'q'.repeat(257) }))],
    ['a whitespace-only question', yamlOf(question({ question: '   ' }))],
  ])('rejects %s', (_name, text) => {
    expect(() => parseDocsEvalQuestions(text)).toThrow(/^docs-questions\.yaml: /);
  });
});
