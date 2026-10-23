# Spec #10: the `triage-failing-package` prompt

Issue: [seandavi/bioc-mcp#10](https://github.com/seandavi/bioc-mcp/issues/10).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Prompts"). Conventions: [AGENTS.md](../../AGENTS.md). Builds on the prompt machinery of
[spec #4](4-docs-module.md) (`PromptDef`, `definePrompt`, `Module.prompts`, the MCP transport's
toolset rule, `validateRegistry`'s prompt checks) and the tools of [spec #6](6-pkg-status.md)
(`pkg_status`), [spec #7](7-pkg-check-output.md) (`pkg_check_output`) and spec #4 (`docs_search`,
`docs_read`). All of them are merged on `main` (`270d8a1`).

Everything marked **Verified** was checked on 2026-10-22 in this worktree (`npm ci`,
`npm run docs:fixtures`, so the docs index is the fixture build of 418 records from 16 inputs) with
throwaway scripts that were deleted afterwards:

- **Verified (SDK 2.3.1, `@modelcontextprotocol/server`):** `createPromptHandler` runs
  `validateStandardSchema(argsSchema, args ?? {})` on every `prompts/get` and throws
  `ProtocolError(InvalidParams, "Invalid arguments for prompt <name>: …")` (code `-32602`) on
  failure, so the full zod schema, regex included, guards the argument before `render` sees it.
  The callback receives the parsed data.
- **Verified (live, 2026-10-22):** `GEOfastq` in `bioc` (devel) has a failing devel check whose
  output the registry captured. `https://bioc.r-universe.dev/api/packages/GEOfastq` (12,108 bytes,
  `last-modified: Thu, 22 Oct 2026 23:17:55 GMT`): Version `1.21.0`, `_status` `success`, commit
  `b16140106c9441ca126dbc49f92489589df04a94`, `_created` `2026-09-24T09:45:16.000Z`, `_failure`
  null. Jobs: `linux-devel-x86_64` **ERROR** (job `107579662259`), `windows-devel-x86_64`,
  `windows-oldrel-x86_64`, `windows-release-x86_64` ERROR, `bioc-checks` WARNING, the rest OK.
  `GET https://bioc-registry.seandavi.workers.dev/checks/bioc/107579662259` is 200 (9,191 bytes;
  files `00check.log`, `00install.out`, `GEOfastq-Ex.Rout`, `pkgdata.txt`, `testthat.Rout.fail`).
  The live propagation index has `GEOfastq` at 1.21.0 (`ts` `2026-08-13T16:30:37.995Z`,
  `archs` `["linux","mac"]`, `bioccheck` `FAILURE`, same commit).
- **Verified (live capabilities, real fetch):** `pkg_status({ package: 'GEOfastq' })` summary is
  `GEOfastq (bioc) is propagated at 1.21.0 (passed the gate via r-universe, 2026-08-13). r-universe builds 1.21.0: status success, failing linux-devel-x86_64 (ERROR), windows-devel-x86_64 (ERROR), windows-oldrel-x86_64 (ERROR) and 1 more.`,
  `behind` false, `behind_reasons` `[]`.
  `pkg_check_output({ universe: 'bioc', job: '107579662259' })`: `check.status`
  `Status: 1 ERROR`, one section `checking tests` / `ERROR` whose text contains
  `Failure ('test-srp_utils.R:31:5'): get_fastqs can download a fastq files`; envelope 1,482 bytes.
  With `file: 'testthat.Rout.fail'`: view `tail`, all 1,142 characters, envelope 1,956 bytes.
- **Verified (fixture docs index):** `search('propagation gate check verdict', 5)` ranks
  `https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#the-gate-check-by-check`
  first (score 347.48), then `#relation-to-the-legacy-production-gate` and ADR 0011. That section
  states the gate's rules: which configs form the linux, win and mac families, that a family fails
  on any ERROR, FAIL or FAILURE job on the gating R version, and that BiocCheck is advisory.
- **Verified (fixture):** merging the live `GEOfastq` entry into
  `test/fixtures/registry/prop/bioc/index.json` with the `jq` command under [Fixtures](#fixtures)
  only appends lines; no existing entry changes.

No new npm package is needed.

## Goal

One MCP prompt, `triage-failing-package(package)`, that walks a model through:

1. `pkg_status` for the package in devel (`universe: "bioc"`);
2. `pkg_check_output` for the failing job it picks by a stated rule (and a second file the
   check log points at, when there is one);
3. `docs_search` for the propagation gate (and a runbook, when the failure looks like the
   infrastructure), with `docs_read` when a snippet does not settle it;
4. a structured answer: **what failed, evidence, likely cause, where it is documented, next step**.

The prompt is MCP only. Prompts have no REST form (AGENTS.md); the PR says so.

## Non-goals

- **No new capability, no REST route, no OpenAPI change.** The prompt only names existing tools.
- **No `universe` argument.** The issue and the proposal both give `(package)`, and the issue's
  acceptance is about a devel check. The prompt triages devel (`bioc`). A release form is a
  follow-up if someone asks for it.
- **No triage logic in code.** Which job to read and what the failure means are the model's work,
  guided by the prompt text. Nothing in `src/` picks jobs or classifies failures.
- **No change to `PromptDef`, `definePrompt`, `validateRegistry`, `src/transports/mcp.ts`,
  `pkg_status`, `pkg_check_output`, `docs_search`, `docs_read`, the envelope or usage events.**
  `prompts/get` emits no usage event today and still does not.
- **No docs ranking change and no docs re-record.**
- **No change to the existing fixture entries.** The `bioc` index fixture gains one entry.

## Decisions beyond the issue text

The issue does not settle these. Each is decided here; the reviewer can strike any of them.

1. **The prompt lives in the `pkg` module** (`src/core/pkg/prompts.ts`, `pkgModule.prompts`). Its
   subject and argument are a package. Where it lives does not change where it is offered: the
   transport offers a prompt only on toolsets holding every tool in `prompt.tools`, so it is
   listed on `/mcp`, `/mcp/pkg+docs` and `/mcp/docs+pkg` and nowhere else, whichever module owns it.
   The cost is a registration dependency: `validateRegistry` rejects any `prompt.tools` name that
   no registered module defines, and `createApp` runs it, so a registry holding `pkgModule`
   without `docsModule` now throws at startup. Production registers every module in `modules`, so
   it is unaffected; a test app that registers `pkgModule` must also register `docsModule`. This is
   the first prompt that names another module's tools (`explain-decision` names only `docs`
   tools), and the dependency is accepted.
2. **`tools` includes `docs_read`.** A `docs_search` snippet is about 200 characters. Whether a
   given failing config blocks propagation is in the gate section's full text (the families
   rule), so the prompt reads the top hit when the snippet does not settle it. `docs_read` is in
   the `docs` module, so this adds no condition to where the prompt is offered.
3. **The `package` argument is `PackageNameSchema`** (`src/core/pkg/package-name.ts`), the same
   schema `pkg_status` uses. It is a string in JSON Schema (it passes `assertStringArguments`), and
   its regex means the value inserted into the prompt text holds only letters, digits and `.`.
4. **The docs query is fixed**: `propagation gate check verdict`, exported as
   `TRIAGE_DOCS_QUERY` so the test runs the same words. It ranks the gate's rule-by-rule
   section first in the fixture index. A second, model-written query covers infrastructure
   failures.
5. **The job selection rule** in the text mirrors how `pkg_status` counts failures
   (`failingChecks` in `src/core/pkg/status.ts`: config not `bioc-checks`, check
   `ERROR|FAIL|FAILURE`), then prefers `ERROR` (FAIL and FAILURE jobs have no check output,
   spec #7) and a `linux-*` config, falls back to `upstream.newer_commit_failed.job`, and treats a
   `not_found` or `source` job by trying one other failing job.

## Design

### Files

```
src/core/pkg/prompts.ts            NEW  triageFailingPackagePrompt, TRIAGE_DOCS_QUERY
src/core/pkg/index.ts              pkgModule gains prompts: [triageFailingPackagePrompt]
README.md                          one sentence after the explain-decision sentence (below)
test/core/pkg/prompts.test.ts      NEW  render, args, tool names
test/transports/triage.test.ts     NEW  listing, prompts/get, the GEOfastq walk over fixtures
test/transports/docs.test.ts       /mcp now lists both prompts (see Test plan)
test/transports/pkg.test.ts        registers docsTestModule beside pkgModule (see Test plan)
test/transports/ops.test.ts        registers docsTestModule beside pkgModule (see Test plan)
test/support/pkg-routes.ts         routes for GEOfastq's r-universe record and check job
test/fixtures/r-universe/bioc/GEOfastq.json                 NEW (verbatim)
test/fixtures/registry/checks/bioc/107579662259.json        NEW (jq -c)
test/fixtures/registry/prop/bioc/index.json                 GEOfastq entry appended
```

Imports in `prompts.ts`: `import * as z from 'zod'` (for `z.object`), `definePrompt` from
`'../capability'`, `PackageNameSchema` from `'./package-name'`.

### `src/core/pkg/prompts.ts`

```ts
import * as z from 'zod';
import { definePrompt } from '../capability';
import { PackageNameSchema } from './package-name';

/** docs_search query the triage prompt prescribes; ranks the propagation gate's rule-by-rule section first. */
export const TRIAGE_DOCS_QUERY = 'propagation gate check verdict';

export const triageFailingPackagePrompt = definePrompt({
  name: 'triage-failing-package',
  title: 'Triage a failing package',
  description:
    'Find out why a Bioconductor package fails to build or check in devel and what should happen next: ' +
    'reads its build state (pkg_status), the failing check output (pkg_check_output) and the infrastructure ' +
    'docs on the propagation gate and runbooks (docs_search, docs_read), then answers what failed, the ' +
    'evidence, the likely cause, where it is documented and the next step.',
  args: z.object({ package: PackageNameSchema }),
  tools: ['pkg_status', 'pkg_check_output', 'docs_search', 'docs_read'],
  render: ({ package: name }) =>
    [
      `Triage the Bioconductor package ${name} in devel (universe "bioc"): what fails, why, and what to do next.`,
      '',
      `1. Call pkg_status with package ${JSON.stringify(name)} and universe "bioc". If it returns not_found, report the error and its suggestions and stop.`,
      '2. Pick one failing job from data.upstream.jobs: its check is ERROR, FAIL or FAILURE and its config is not "bioc-checks" (BiocCheck is advisory and never blocks propagation). Prefer ERROR, because FAIL and FAILURE jobs have no check output, and prefer a linux-* config over the others. If no current job fails but data.upstream.newer_commit_failed.job is set, pick that job: a newer commit failed while the older version is still served. If data.upstream is null or nothing fails, say so, report data.behind and data.behind_reasons, and go to step 4.',
      '3. Call pkg_check_output with universe "bioc" and the job id from that job\'s job field, unchanged. Read data.check.status and data.check.sections. When a section points at another captured file (failing tests at testthat.Rout.fail, a failed install at 00install.out), call pkg_check_output again with that file, taken from data.files. If the job is not_found, or is a "source" job (it holds only pkgdata.txt), try one other failing job; if none can be read, give the job\'s url from pkg_status instead.',
      `4. Call docs_search with query ${JSON.stringify(TRIAGE_DOCS_QUERY)} to find which failing checks block propagation. If the snippets do not settle whether this failure blocks it, call docs_read with the top hit's url. If the failure looks like the infrastructure rather than the package (the runner, the image, a dependency that failed to install, a network download), call docs_search again with a few words naming it, to find the runbook.`,
      '5. Answer under these headings:',
      '   - What failed: the configs and their verdicts, the version and commit, and whether the propagated version is affected (data.propagated, data.behind).',
      '   - Evidence: the decisive lines of the check output, quoted briefly, with the job_url.',
      '   - Likely cause: the package (code, tests, examples, vignettes, dependencies) or the infrastructure, and why. Say so when the evidence does not settle it.',
      '   - Where it is documented: the docs sections you used, each linked by url.',
      '   - Next step: who acts (the maintainer or the infrastructure team) and what they do first.',
      '',
      'Cite the sources each tool returned. Do not guess beyond the evidence.',
    ].join('\n'),
});
```

Copy the text verbatim; the tests below assert parts of it. Every field path it names exists in
the current output schemas: `data.upstream.jobs[].{config,check,job,url}`,
`data.upstream.newer_commit_failed.job`, `data.behind`, `data.behind_reasons`,
`data.propagated` (`PkgStatusDataSchema`); `data.check.status`, `data.check.sections`,
`data.files`, `data.job_url` (`PkgCheckOutputDataSchema`). The rendered text for `GEOfastq` is
2,405 characters (**Verified** by evaluating the array above).

### `src/core/pkg/index.ts`

```ts
import { triageFailingPackagePrompt } from './prompts';
// …
export const pkgModule: Module = {
  // name, description, upstreams, capabilities unchanged
  prompts: [triageFailingPackagePrompt],
};
```

`validateRegistry` already checks the name (kebab-case, unique), the non-empty description, that
`package` is a string argument, and that every name in `tools` is a registered capability in any
module. Nothing in it changes.

### MCP surface

| Toolset path | Prompts listed |
|---|---|
| `/mcp` | `triage-failing-package`, `explain-decision` |
| `/mcp/pkg+docs`, `/mcp/docs+pkg` | `triage-failing-package`, `explain-decision` |
| `/mcp/pkg`, `/mcp/pkg+ops`, `/mcp/meta`, `/mcp/ops` | none |
| `/mcp/docs` | `explain-decision` |

`prompts/list` entry: `name` `triage-failing-package`, `title` `Triage a failing package`, the
description above, `arguments: [{ name: 'package', description: 'Package name, case-sensitive, e.g. "edgeR"', required: true }]`.
`prompts/get` with `{ package: 'GEOfastq' }` returns one message, `role: 'user'`, content
`{ type: 'text', text: triageFailingPackagePrompt.render({ package: 'GEOfastq' }) }`. A missing or
invalid `package` (`''`, `'bad name'`, `'a.'`) is `-32602`.

### REST

None. No route, no OpenAPI entry. The PR description says: "Prompts are MCP only (AGENTS.md); this
PR adds no REST route."

### `README.md`

After the existing sentence "The `docs` module also serves each page as an MCP resource
(`bioc://docs/…`) and an `explain-decision` prompt." add:

```
The `pkg` module serves a `triage-failing-package` prompt, which uses `pkg_status`,
`pkg_check_output` and the docs tools, so it is offered only where both modules are (`/mcp`,
`/mcp/pkg+docs`).
```

### Upstream calls

The prompt makes none. The walk test drives these, all already implemented and all from fixtures:

| Tool call | URL | Fixture |
|---|---|---|
| `pkg_status({ package: 'GEOfastq' })` | `https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json` | `registry/prop/bioc/index.json` (GEOfastq appended) |
| same | `https://bioc.r-universe.dev/api/packages/GEOfastq` | `r-universe/bioc/GEOfastq.json` NEW |
| `pkg_check_output({ universe: 'bioc', job: '107579662259' })` and with `file: 'testthat.Rout.fail'` | `https://bioc-registry.seandavi.workers.dev/checks/bioc/107579662259` | `registry/checks/bioc/107579662259.json` NEW |
| `docs_search({ query: TRIAGE_DOCS_QUERY })` | none (bundled index; the test uses `docsTestModule()`) | the existing docs fixtures |

### Fixtures

The r-universe record is committed verbatim (as spec #6), the check job as `jq -c` (as spec #7),
and the index entry is appended to the existing trimmed index unchanged (as spec #6 trims it). Do
not re-record the other index entries: other tests assert their recorded state.

```bash
B=https://bioc-registry.seandavi.workers.dev
F=test/fixtures
T=$(mktemp -d)
curl -sf https://bioc.r-universe.dev/api/packages/GEOfastq > $F/r-universe/bioc/GEOfastq.json
curl -sf $B/checks/bioc/107579662259 | jq -c . > $F/registry/checks/bioc/107579662259.json
curl -sf $B/data/prop/bioc/index.json | jq '{GEOfastq}' > $T/entry.json
jq -s '.[0] + .[1]' $F/registry/prop/bioc/index.json $T/entry.json > $T/index.json
mv $T/index.json $F/registry/prop/bioc/index.json
git diff --stat $F/registry/prop/bioc/index.json   # additions only
```

Scenario criterion: the r-universe record's `linux-devel-x86_64` job has check `ERROR`, and the
registry returns 200 for that job under `/checks/bioc/`. If `GEOfastq` no longer fits when
recorded (it rebuilt and the new job passes or is not captured), substitute a package that does
and say so in the PR. Candidates observed on 2026-10-22, each with a captured failing
`linux-devel-x86_64` job: `CexoR` (`107091970128`), `epivizrChart` (`107097183281`),
`scQTLtools` (`107571981513`), `KnowSeq` (`108577084686`). Then update the job id, file names and
asserted strings in the tests to the recorded files.

`test/support/pkg-routes.ts`:

- add `'GEOfastq'` to the list of names mapped through `recorded(name)` (no headers, like the
  others except trackViewer);
- add `'107579662259'` to the list of captured bioc check jobs, and extend the comment above it
  with `GEOfastq (devel test failure, triage walk)`.

## Acceptance criteria

- [ ] `src/core/pkg/prompts.ts` exports `triageFailingPackagePrompt` and `TRIAGE_DOCS_QUERY` exactly
      as in [Design](#srccorepkgpromptsts); `pkgModule.prompts` is `[triageFailingPackagePrompt]`.
- [ ] `validateRegistry(modules)` passes with the prompt registered.
- [ ] Every name in `triageFailingPackagePrompt.tools` is a registered capability, appears in the
      rendered text, and every `<module>_<name>` token in the rendered text and in the
      description is in `tools` (test asserts this; issue acceptance).
- [ ] `package` rejects `''`, `'x'`, `'bad name'`, `'a.'`, `'1abc'` and accepts `'GEOfastq'`.
- [ ] `prompts/list` on `/mcp`, `/mcp/pkg+docs` and `/mcp/docs+pkg` includes
      `triage-failing-package` with one required argument `package`; on `/mcp/pkg` and `/mcp/docs`
      it is absent.
- [ ] `prompts/get` returns one user message equal to `render({ package })`; a missing or invalid
      `package` is `-32602`.
- [ ] Tested with a fixture package whose devel check fails (issue acceptance): over the MCP
      transport and fixtures only, the walk the prompt describes, on `GEOfastq`, picks
      `linux-devel-x86_64` job `107579662259`, `pkg_check_output` returns `Status: 1 ERROR` with a
      `checking tests` ERROR section naming `test-srp_utils.R:31:5`, the follow-up read of
      `testthat.Rout.fail` succeeds, and `docs_search` with `TRIAGE_DOCS_QUERY` ranks
      `propagation-gate.html#the-gate-check-by-check` first.
- [ ] No REST route or OpenAPI path is added (`/api/openapi.json` paths unchanged); `pkg.test.ts`
      and `ops.test.ts` change only to register `docsTestModule` beside `pkgModule`, and their
      assertions are otherwise unchanged.
- [ ] README sentence added.
- [ ] `npm test` and `npm run typecheck` pass; no test touches the network.

## Test plan

### `test/core/pkg/prompts.test.ts` (new)

```ts
import { describe, expect, it } from 'vitest';
import { pkgModule } from '../../../src/core/pkg';
import { TRIAGE_DOCS_QUERY, triageFailingPackagePrompt as prompt } from '../../../src/core/pkg/prompts';
import { modules } from '../../../src/core/registry';
```

- **renders the package and each step**: `render({ package: 'GEOfastq' })` contains
  `Triage the Bioconductor package GEOfastq in devel`, `package "GEOfastq"`, `universe "bioc"`,
  `"bioc-checks"`, `data.upstream.newer_commit_failed.job`, `testthat.Rout.fail`,
  `00install.out`, `` `query ${JSON.stringify(TRIAGE_DOCS_QUERY)}` ``, and the five headings
  `What failed:`, `Evidence:`, `Likely cause:`, `Where it is documented:`, `Next step:`.
- **names exactly its tools**: let `registered` be every capability name in `modules` and
  `prefixes` the module names. For the rendered text and for `prompt.description`, collect tokens
  matching `/\b[a-z]+_[a-z_]+\b/g` whose part before the first `_` is in `prefixes`; each is in
  `prompt.tools`. Every entry of `prompt.tools` is in `registered` and occurs in the rendered
  text.
- **package argument**: `prompt.args.safeParse({ package })` fails for `''`, `'x'`, `'bad name'`,
  `'a.'`, `'1abc'`, and for `{}`; succeeds for `'GEOfastq'`.
- **registered in pkg**: `pkgModule.prompts` equals `[prompt]`.

### `test/transports/triage.test.ts` (new)

App: `makeTestApp({ routes: pkgRoutes, extraModules: [pkgModule, await docsTestModule()] })`,
client via `connectClient(app, path)`, closed in `afterEach` as in `test/transports/docs.test.ts`.

- **listed where pkg and docs both are**: for `/mcp`, `/mcp/pkg+docs`, `/mcp/docs+pkg`,
  `listPrompts()` names include `triage-failing-package`, and its `arguments` equal
  `[expect.objectContaining({ name: 'package', required: true })]`.
- **absent elsewhere**: on `/mcp/pkg` the prompt list is `[]`; on `/mcp/docs` the names are
  `['explain-decision']`.
- **prompts/get**: on `/mcp/pkg+docs`, `getPrompt({ name: 'triage-failing-package', arguments: { package: 'GEOfastq' } })`
  returns one message, `role` `user`, text equal to `render({ package: 'GEOfastq' })`. No upstream
  request is made (`fetch.calls` is empty).
- **prompts/get rejects a bad package**: `arguments: {}` and `{ package: 'bad name' }` each reject
  with `{ code: -32602 }`.
- **walks GEOfastq, whose devel check fails**, on `/mcp/pkg+docs`, using `callTool` and reading
  `structuredContent`:
  1. `pkg_status` `{ package: 'GEOfastq' }`: not `isError`; `data.propagated.version` `1.21.0`,
     `data.behind` false; `summary` contains `failing linux-devel-x86_64 (ERROR)`.
  2. Apply step 2's rule with a local `pickFailingJob(jobs)` in the test: filter
     `config !== 'bioc-checks' && /^(ERROR|FAIL|FAILURE)$/.test(check ?? '')`, sort ERROR before
     the others and `linux-` configs before the others (stable), take the first. Expect
     `{ config: 'linux-devel-x86_64', job: '107579662259' }`.
  3. `pkg_check_output` `{ universe: 'bioc', job }`: `data.check.status` `Status: 1 ERROR`,
     `data.check.sections[0]` has `check` `checking tests` and `verdict` `ERROR`, its `text`
     contains `test-srp_utils.R:31:5`; `data.files` contains `testthat.Rout.fail`; `data.job_url`
     ends with `/runs/107579662259`.
  4. `pkg_check_output` `{ universe: 'bioc', job, file: 'testthat.Rout.fail' }`: not `isError`,
     `data.view` `tail`, `data.text.text` contains `Failed tests`.
  5. `docs_search` `{ query: TRIAGE_DOCS_QUERY }`: `data.hits[0].url` is
     `https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#the-gate-check-by-check`.
  6. Every tool called in 1–5 is in `triageFailingPackagePrompt.tools`, and `fetch.calls` holds
     only the three fixture URLs under [Upstream calls](#upstream-calls).

### `test/transports/docs.test.ts` (edit)

`explain-decision is listed on /mcp/docs and /mcp…` currently expects the names on `/mcp` to equal
`['explain-decision']`; with the pkg prompt registered, `/mcp` lists both. Compare sorted names:
`['explain-decision']` on `/mcp/docs`, `['explain-decision', 'triage-failing-package']` on `/mcp`,
and keep the `topic` argument check on the `explain-decision` entry (find it by name, not
`prompts[0]`). The `/mcp/pkg`, `/mcp/meta`, `/mcp/example` cases still expect `[]` and need no
change.

### `test/transports/pkg.test.ts` and `test/transports/ops.test.ts` (edit)

Both build apps with `extraModules: [pkgModule, …]`. With the prompt in `pkgModule`,
`validateRegistry` throws unless `docs_search` and `docs_read` are registered too (Decision 1), so
each file adds `const docsModule = await docsTestModule();` (from `../support/docs`) and passes
`docsModule` in `extraModules` wherever `pkgModule` is registered. In `ops.test.ts` the
all-modules tool-name check adds `docsModule` to its `expected` module list, because `/mcp` now
lists the docs tools. No assertion changes otherwise.

### Commands

`npm test`, `npm run typecheck`. Check that `git diff --stat` shows the index fixture with
additions only.

## Risks

- **Text, not code, does the triage.** A model can skip steps or pick another job. The tests pin
  the text and prove the walk it describes works on recorded data; they cannot prove a given
  model follows it. Kept short and numbered for that reason.
- **The docs query can drift.** A docs re-record (#3, #5 workflows) can move the gate section off
  rank 1 for `propagation gate check verdict`. The walk test then fails, which is the signal to
  update `TRIAGE_DOCS_QUERY` (and the test) in that PR.
- **Field paths in the text can drift.** If `PkgStatusDataSchema` or `PkgCheckOutputDataSchema`
  renames a field the text names, nothing in the type system notices. The walk test reads the same
  paths from real output, so a rename breaks it.
- **GEOfastq can change before recording.** The record and the captured job are live; see the
  substitution rule under [Fixtures](#fixtures). Once committed, fixtures are fixed.
- **Mixed-date index fixture.** The appended `GEOfastq` entry is from a later recording than the
  other nine. Entries are independent and the adapter validates only the one it slices, so no
  test depends on them sharing a date.
- **Devel only.** Release failures (`bioc-release`) are not covered by the text; a model asked
  about release will either adapt the universe or follow the text into devel. Out of scope by
  decision; a `universe` argument is the follow-up if wanted.
