import { describe, expect, it } from 'vitest';
import { explainDecisionPrompt } from '../../../src/core/docs/prompts';
import { modules } from '../../../src/core/registry';

describe('explainDecisionPrompt', () => {
  it('renders the topic and the tools to call', () => {
    const text = explainDecisionPrompt.render({ topic: 'why are client addresses hashed' });
    expect(text).toContain('why are client addresses hashed');
    expect(text).toContain('docs_search');
    expect(text).toContain('source "adr"');
    expect(text).toContain('docs_read');
    expect(text).toContain('url without its #anchor');
  });

  it('quotes the topic as JSON so quotes in it cannot end the query', () => {
    expect(explainDecisionPrompt.render({ topic: 'a "b" c' })).toContain('query "a \\"b\\" c"');
  });

  it('names only registered capabilities in tools', () => {
    const registered = new Set(modules.flatMap((m) => m.capabilities.map((c) => c.name)));
    for (const tool of explainDecisionPrompt.tools) expect(registered.has(tool)).toBe(true);
  });

  it('requires a non-empty topic of at most 200 characters', () => {
    expect(explainDecisionPrompt.args.safeParse({ topic: '' }).success).toBe(false);
    expect(explainDecisionPrompt.args.safeParse({ topic: 'x'.repeat(201) }).success).toBe(false);
    expect(explainDecisionPrompt.args.safeParse({ topic: 'x' }).success).toBe(true);
  });
});
