# Spec #35: MCP text content carries the data, not only the summary

Issue: [seandavi/bioc-mcp#35](https://github.com/seandavi/bioc-mcp/issues/35).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md). Touches the scaffold's envelope and MCP transport
([spec #2](2-scaffold.md), [spec #15](15-scaffold-followups.md)).

The following was checked on 2026-10-22 against `main` at `8d31fbf` (`@modelcontextprotocol/server`
2.3.1, `@modelcontextprotocol/client` 2.3.1) with a throwaway Vitest file, since deleted. **Verified**
marks what it showed:

- **Verified:** `src/transports/mcp.ts` returns
  `{ content: [{ type: 'text', text: envelope.summary }], structuredContent: envelope }`. A client
  that passes only `content` to the model never sees `data` or `sources`. That is the bug in the issue.
- **Verified:** the SDK checks `structuredContent` against `outputSchema` (server
  `mcp-*.mjs`: "Output validation error: Tool … has an output schema but no structured content was
  provided") and does not read `content`. A `content` array with two `text` blocks passes through
  unchanged and `client.callTool` returns both.
- **Verified:** for every production tool, called over `/mcp/meta+pkg+ops` with the recorded
  fixtures, the UTF-8 bytes of the two text blocks this spec defines
  (`summary` + `JSON.stringify({ data, sources })`) were exactly `envelopeBytes(envelope) − 13`,
  or `− 15` where the summary contains characters JSON escapes:

  | call | envelope bytes | text bytes |
  |---|---|---|
  | `meta_ping {}` | 85 | 72 |
  | `pkg_status {package: trackViewer}` | 3564 | 3551 |
  | `pkg_status {package: edgeR, universe: bioc-release}` | 5044 | 5031 |
  | `pkg_check_output {universe: bioc, job: 96299707840}` | 2437 | 2424 |
  | `pkg_check_output {…, full: true}` | 5400 | 5387 |
  | `pkg_build_environment {universe: bioc, job: 96299707840}` | 803 | 790 |
  | `pkg_release_info {}` | 2133 | 2120 |
  | `pkg_downloads {package: edgeR}` | 1741 | 1728 |
  | `ops_activity {kind: summary}` | 5183 | 5168 |
  | `ops_activity {kind: issues}` | 5370 | 5357 |
  | `ops_activity {kind: prs}` | 3977 | 3964 |
  | `ops_activity {kind: workflows}` | 2927 | 2914 |
  | `ops_activity {kind: failures}` | 807 | 792 |

No new npm package is needed. No upstream calls change and no fixtures are recorded.

## Goal

Every successful MCP tool result carries its facts in `content`, not only in `structuredContent`,
so a client that passes only text to the model (the 2026-10-22 real-client test of
`pkg_status GEOquery`) gets the same job ids, URLs and provenance a `structuredContent` client gets.
The MCP spec (2025-06-18, "Structured Content") says a tool that returns structured content SHOULD
also return it serialized in a TextContent block.

The ~8 KB rule keeps holding for what the model actually receives, and no current tool's output
changes size or content beyond the added text block.

## Non-goals

- REST: no change to `/api/v1/…` bodies, status codes or routes. Only one schema `.describe()`
  string changes, which shows up in the OpenAPI document (below).
- No change to `structuredContent`, to the envelope shape, to `MAX_RESULT_BYTES` (stays `8192`) or to
  any per-tool budget (`SECTION_BUDGETS`, `PAGE_BUDGETS`, `MAX_LISTED_FILES`, …).
- No change to error results. `isError` results keep their single text block
  `` `${code}: ${message}` ``, and SDK input-validation errors are untouched.
- Resources (`bioc://about`) and, in #31, resource templates and prompts are not tool results. They
  are unchanged.
- PR #31 (`docs_search`, `docs_read`): rebasing it and dropping its `docs_read`-only fallback is
  the issue's "After" step, done in #31, not here. Recording the client result in #12 is also out of
  scope.
- The project proposal (`proposal-mcp.qmd` in bioc-infrastructure, "Adapters are pure: … return
  structuredContent + a short text summary") lives in another repo. This change records the rule in
  this repo's AGENTS.md. Updating the proposal is a follow-up for the main session (see Risks).

## Design

### Decision: what the text content is

A successful tool result's `content` is exactly two `text` blocks, in this order:

1. `envelope.summary`, unchanged (existing tests read `content[0]` as the summary, and they still
   pass).
2. `JSON.stringify({ data: envelope.data, sources: envelope.sources })`: compact JSON (no
   indentation, to save bytes), keys in the order `data`, `sources`, with no prefix or label. The
   summary is not repeated inside it.

`structuredContent` stays the whole envelope (`{ data, summary, sources }`).

### Decision: what the size guard counts

The guard keeps counting the envelope: `assertEnvelopeSize` in `invokeCapability`, unchanged, at
`MAX_RESULT_BYTES = 8192`. The reasoning, which goes in the doc comment and in AGENTS.md:

- `JSON.stringify(envelope)` is `{"data":D,"summary":S,"sources":R}` and block 2 is
  `{"data":D,"sources":R}`. The envelope is therefore block 2 plus `,"summary":` (11 bytes) plus
  the summary as a JSON string (its bytes plus 2 quotes plus escapes). So
  **text bytes = envelope bytes − 13 − (summary escape bytes) < envelope bytes.** Any envelope
  that passes the guard yields text content of at most 8179 bytes. The table above confirms this
  for every current tool.
- The output schemas declare no `.default()`/`.catch()` on output fields (checked: every `.default`
  in `src/core` is on an input schema). So the parse in `runCapability` after the guard can only
  remove keys, never add bytes, and the bound holds for what is actually sent.
- Counting the text blocks instead would make the guard depend on the MCP serialization, which
  `invokeCapability` (shared with REST) should not know about. It would also loosen the limit by
  13 bytes, a change of no value.
- Each representation (the REST body, `structuredContent`, the text content) is ≤ 8 KB on its own.
  A client that forwards both `structuredContent` and `content` to the model sees about twice that.
  That duplication comes from the MCP spec's SHOULD and is the client's choice. The rule is about
  what one representation carries.

No per-tool budget changes: the largest current text content is 5387 bytes.

### Files

```
src/envelope.ts                 + envelopeTextBlocks(); summary .describe() wording
src/transports/mcp.ts           success result content = envelopeTextBlocks(envelope) as text blocks
AGENTS.md                       Rules: the text-content rule, merged with the ~8 KB rule
test/envelope.test.ts           + describe('envelopeTextBlocks')
test/transports/mcp.test.ts     meta_ping / example_item assert both blocks; an error result has one block
test/transports/text-content.test.ts   NEW: every production tool's text carries its data, within the size limit
```

Nothing else changes. In particular `src/core/invoke.ts`, `src/transports/rest.ts` and every
`src/core/<module>/` file are untouched.

### `src/envelope.ts`

Add, after `envelopeBytes`:

```ts
/**
 * MCP text content for a successful result: the summary, then JSON of data and sources, so
 * clients that pass only text to the model see the same facts as structuredContent. Its UTF-8
 * size is envelopeBytes(envelope) − 13 − the summary's JSON escapes, so assertEnvelopeSize bounds it.
 */
export function envelopeTextBlocks(envelope: Envelope<unknown>): [summary: string, data: string] {
  return [envelope.summary, JSON.stringify({ data: envelope.data, sources: envelope.sources })];
}
```

Change the `summary` field's description in `envelopeSchema` from
`'One or two sentences answering the question; the MCP text content'` to
`'One or two sentences answering the question; the first MCP text content block'`.
(This string reaches `tools/list` output schemas and the OpenAPI document. No test snapshots it.)

`MAX_RESULT_BYTES`, `envelopeBytes` and `assertEnvelopeSize` are unchanged. Extend the
`assertEnvelopeSize` doc comment by one sentence: `It also bounds the MCP text content (see envelopeTextBlocks).`

### `src/transports/mcp.ts`

Import `envelopeTextBlocks` from `'../envelope'`. In the `registerTool` callback, the success branch
becomes:

```ts
? {
    content: envelopeTextBlocks(result.envelope).map((text) => ({ type: 'text' as const, text })),
    structuredContent: result.envelope,
  }
```

The error branch is unchanged. The server `instructions` string is unchanged.

### `AGENTS.md`

Under **Rules**, replace the bullet `- No tool returns more than ~8 KB of text.` with:

```
- MCP text content carries the data, not only the summary: a successful tool result's `content` is
  the summary, then `JSON.stringify({ data, sources })` (`envelopeTextBlocks` in src/envelope.ts),
  so clients that ignore `structuredContent` see the same facts. Never build `content` any other way.
- No tool returns more than ~8 KB of text. `assertEnvelopeSize` checks `JSON.stringify(envelope)`
  against `MAX_RESULT_BYTES` (8192), which is always larger than the MCP text content, so one
  check bounds REST, `structuredContent` and `content`.
```

In **Layout**, change the `envelope.ts` line to
`envelope.ts         result envelope: data + text summary + provenance; size limit; MCP text blocks`.

### Capabilities, schemas, routes, upstreams

None added or changed. Every existing capability's input schema, output schema, MCP tool name and
REST route stay as they are. No upstream is called differently and no fixture is recorded. The
tests use the existing fixtures through `pkgRoutes`, `bioconductorRoutes` and `githubRoutes()`.

## Acceptance criteria

- [ ] `envelopeTextBlocks(envelope)` returns `[envelope.summary, JSON.stringify({ data, sources })]`,
      exported from `src/envelope.ts` with the signature above.
- [ ] Every successful MCP `tools/call` result has `content` of exactly two `{ type: 'text' }`
      blocks: `content[0].text === structuredContent.summary` and
      `JSON.parse(content[1].text)` deep-equals `{ data: structuredContent.data, sources: structuredContent.sources }`.
      `structuredContent` is unchanged.
- [ ] `meta_ping`'s `content[1].text` is exactly `{"data":{"ok":true,"version":"<VERSION>"},"sources":[]}`.
- [ ] `pkg_status { package: 'trackViewer' }`: every `data.upstream.jobs[].job` id (10 of them, e.g.
      `109690330754`) appears in `content[1].text`, along with every `jobs[].url`.
- [ ] For every production tool (every capability in `modules` from `src/core/registry.ts`), the
      UTF-8 bytes of `content[0].text + content[1].text` are ≤ `MAX_RESULT_BYTES` and <
      `envelopeBytes(structuredContent)`.
- [ ] The every-tool test fails if a capability is added to `modules` without a row in its table.
- [ ] Error results (`isError: true`) still have exactly one text block starting `<code>:`.
- [ ] `result_too_large` behaviour is unchanged (existing `example_item repeat: 1000` test passes).
- [ ] REST responses are unchanged: the existing `body toEqual structuredContent` tests in
      `test/transports/pkg.test.ts` and `ops.test.ts` pass untouched.
- [ ] AGENTS.md carries the two Rules bullets and the Layout line above, verbatim.
- [ ] `npm test` and `npm run typecheck` pass. No file outside the Files list changes.

## Test plan

All tests run offline on existing fixtures.

### `test/envelope.test.ts`: add `describe('envelopeTextBlocks')`

- `returns the summary, then JSON of data and sources`: for
  `{ data: { a: 1 }, summary: 'S.', sources: [{ url: 'https://x.test/', as_of: '2026-10-22' }] }`
  the result `toEqual(['S.', '{"data":{"a":1},"sources":[{"url":"https://x.test/","as_of":"2026-10-22"}]}'])`.
- `is 13 bytes smaller than the envelope when the summary needs no escaping`: build an envelope
  with an ASCII summary, sum `new TextEncoder().encode(text).length` over both blocks, and expect
  `envelopeBytes(envelope) - 13`.
- `escapes in the summary widen the gap`: a summary containing `"` and `\n` gives a text size
  `< envelopeBytes(envelope) - 13`.
- `an envelope at the limit gives text under the limit`: `envelopeOfSize(MAX_RESULT_BYTES)` (the
  file's existing helper) gives text bytes `=== MAX_RESULT_BYTES - 13`.

### `test/transports/mcp.test.ts`

- Rename `meta_ping returns the envelope as structuredContent and the summary as text` to
  `meta_ping returns the envelope as structuredContent and the summary and data as text`, and add
  `expect(result.content).toEqual([{ type: 'text', text: \`bioc-mcp ${VERSION} is up.\` }, { type: 'text', text: JSON.stringify({ data: { ok: true, version: VERSION }, sources: [] }) }])`.
- `example_item returns data with provenance`: add
  `expect(JSON.parse((result.content as { text: string }[])[1]!.text)).toEqual({ data: …, sources: [{ url: ALPHA_URL, as_of: '2026-10-01T00:00:00Z' }] })`.
- In the `upstream %s becomes an isError result` test, add `expect(result.content).toHaveLength(1)`.

### `test/transports/text-content.test.ts` (new)

```ts
const CALLS: readonly [tool: string, args: Record<string, unknown>][] = [
  ['meta_ping', {}],
  ['pkg_status', { package: 'trackViewer' }],
  ['pkg_status', { package: 'edgeR', universe: 'bioc-release' }],
  ['pkg_check_output', { universe: 'bioc', job: '96299707840' }],
  ['pkg_check_output', { universe: 'bioc', job: '96299707840', full: true }],
  ['pkg_build_environment', { universe: 'bioc', job: '96299707840', dependencies: ['biomaRt', 'httr2'] }],
  ['pkg_release_info', {}],
  ['pkg_downloads', { package: 'edgeR' }],
  ['ops_activity', { kind: 'summary' }],
  ['ops_activity', { kind: 'issues' }],
  ['ops_activity', { kind: 'prs' }],
  ['ops_activity', { kind: 'workflows' }],
  ['ops_activity', { kind: 'failures' }],
];
```

App: `makeTestApp({ routes: { ...pkgRoutes, ...bioconductorRoutes, ...githubRoutes() }, extraModules: [pkgModule, opsModule], now: () => GITHUB_RECORDED_AT })`,
client via `connectClient(app, '/mcp/meta+pkg+ops')`. This exact app and every call above succeeded
in the verification run.

- `covers every production tool`: `new Set(CALLS.map(([tool]) => tool))` equals
  `new Set(modules.flatMap((m) => m.capabilities.map((c) => c.name)))` (production `modules` from
  `src/core/registry.ts`). Adding a module (e.g. #31's docs) fails this until rows are added.
- `test.each(CALLS)('%s %j: text content carries data and sources within the size limit')`:
  `isError` falsy; `content` has length 2, both `type: 'text'`; `content[0].text === structuredContent.summary`;
  `JSON.parse(content[1].text)` deep-equals `{ data, sources }` from `structuredContent`; UTF-8 bytes
  of both texts summed `<= MAX_RESULT_BYTES` and `< envelopeBytes(structuredContent)`.
- `pkg_status text names every job id and job URL` (the issue's regression): call
  `pkg_status { package: 'trackViewer' }`, take `structuredContent.data.upstream.jobs` (expect length
  10), and for each job expect `content[1].text` to contain `String(job.job)` and `job.url`.

Then run `npm test` and `npm run typecheck`.

## Risks

- **Clients that forward both representations** put roughly twice the result into the model's
  context (≤ 16 KB). That follows from the MCP spec's SHOULD and was accepted above. If a client
  study (#12) shows it hurts, the remedy is client-side or a later decision, not this change.
- **Text-only models get raw JSON.** Block 2 has no label. Models read compact JSON well, and the
  summary still comes first. A label (e.g. `Data:`) would make block 2 unparseable as JSON and is
  deliberately left out.
- **PR #31 conflicts.** #31 edits `src/transports/mcp.ts` near the same callback and was about to
  special-case `docs_read`. After this merges, #31 must rebase, drop its fallback, and add
  `docs_search`/`docs_read` rows to `CALLS` (the coverage test enforces this). Its `docs_read` text
  budget (`DOCS_READ_TEXT_BUDGET`) stays valid because the envelope guard bounds the text.
- **Proposal drift.** `proposal-mcp.qmd` still says "structuredContent + a short text summary".
  That line lives in bioc-infrastructure, so the main session should update it or file an issue
  there.
- **Bound depends on output schemas adding no bytes.** If a future output schema adds an output-side
  `.default()`, the parse after the guard could grow the envelope past what was checked. The
  every-tool size test would catch it for tools in `CALLS`.
