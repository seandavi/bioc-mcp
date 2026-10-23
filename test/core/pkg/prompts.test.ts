import { describe, expect, it } from 'vitest';
import { pkgModule } from '../../../src/core/pkg';
import { TRIAGE_DOCS_QUERY, triageFailingPackagePrompt as prompt } from '../../../src/core/pkg/prompts';
import { modules } from '../../../src/core/registry';

describe('triage-failing-package prompt', () => {
  it('renders the package and each step', () => {
    const text = prompt.render({ package: 'GEOfastq' });
    for (const part of [
      'Triage the Bioconductor package GEOfastq in devel',
      'package "GEOfastq"',
      'universe "bioc"',
      '"bioc-checks"',
      'data.upstream.newer_commit_failed.job',
      'testthat.Rout.fail',
      '00install.out',
      `query ${JSON.stringify(TRIAGE_DOCS_QUERY)}`,
      'What failed:',
      'Evidence:',
      'Likely cause:',
      'Where it is documented:',
      'Next step:',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('names exactly its tools', () => {
    const registered = new Set(modules.flatMap((m) => m.capabilities.map((c) => c.name)));
    const prefixes = new Set(modules.map((m) => m.name));
    const text = prompt.render({ package: 'GEOfastq' });
    for (const source of [text, prompt.description]) {
      const tokens = (source.match(/\b[a-z]+_[a-z_]+\b/g) ?? []).filter((t) => prefixes.has(t.split('_')[0]!));
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) expect(prompt.tools).toContain(token);
    }
    for (const tool of prompt.tools) {
      expect(registered.has(tool)).toBe(true);
      expect(text).toContain(tool);
    }
  });

  it('accepts a package name and rejects anything else', () => {
    for (const bad of ['', 'x', 'bad name', 'a.', '1abc']) {
      expect(prompt.args.safeParse({ package: bad }).success, bad).toBe(false);
    }
    expect(prompt.args.safeParse({}).success).toBe(false);
    expect(prompt.args.safeParse({ package: 'GEOfastq' }).success).toBe(true);
  });

  it('is registered on the pkg module', () => {
    expect(pkgModule.prompts).toEqual([prompt]);
  });
});
