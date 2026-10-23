# AGENTS.md

Conventions for anyone (human or agent) changing this repo.

## What this is

A remote MCP server **and an equivalent REST API** on one Cloudflare Worker. Each capability is one
core function with zod input/output schemas; MCP (`/mcp`) and REST (`/api/v1/…`, OpenAPI at
`/api/openapi.json`) are thin transports over it. Design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/main/proposal-mcp.qmd) in
bioc-infrastructure (PR #122 until merged). Read it before structural changes.

## Stack (decided; do not substitute)

- TypeScript, strict mode. Node ≥ 22 for tooling.
- **Hono** for HTTP (keeps the server portable to Node/Bun).
- **MCP TypeScript SDK v2:** `@modelcontextprotocol/server` + `@modelcontextprotocol/hono`
  (`createMcpHandler`, `createMcpHonoApp`), protocol revision `2026-07-28` (stateless, no sessions).
  Not the v1 `@modelcontextprotocol/sdk` package, not `@hono/mcp`, not the Cloudflare `agents`
  package / Durable Objects.
- **zod v4** for input and output schemas; **`@hono/zod-openapi`** for the REST routes and the
  OpenAPI document, generated from the same schemas.
- **Wrangler** to build and deploy; **Vitest** for tests; npm (commit `package-lock.json`).
- **MiniSearch** for the docs index (built in CI, loaded in the Worker).

## Layout (target)

```
src/
  index.ts            Hono app: mounts /mcp, /mcp/:toolset, /api/v1, /api/openapi.json
  core/<module>/      one capability per file: zod schemas + a pure-ish function (deps injected)
  core/registry.ts    the list of modules and capabilities; both transports read it
  transports/mcp.ts   builds an McpServer from a set of modules (tools, resources, prompts)
  transports/rest.ts  builds OpenAPI routes from the same capabilities
  upstreams/<name>.ts one adapter per upstream (fetch + cache + shape)
  docs-index/         docs index schemas and loader; bundled.ts imports generated/docs-index
  envelope.ts         result envelope: data + text summary + provenance; size limit; MCP text blocks
  usage.ts            usage events → Analytics Engine (the usage metric)
  rate-limit.ts       per-address rate limit on /mcp and /api
scripts/              build-time Node code (never bundled); build-docs-index.ts builds the index; eval-docs.ts runs the docs evaluation
generated/            build output, gitignored: docs-index.js + docs-index.d.ts
docs-sources.yaml     the docs corpus: site URL, repos and files, size limit
eval/                 docs-questions.yaml: the docs search evaluation set (npm run eval:docs)
docs/deploy.md        deploy runbook: secrets, first deploy, dispatch, usage queries
test/
  fixtures/<upstream>/  recorded upstream responses
  fixtures/docs/<host>/<path>  recorded docs inputs, one file per URL
```

## Rules

- **One capability, two transports.** Never put logic in a transport. A capability added to
  `core/` appears in MCP and REST, or the PR explains why not (MCP prompts, for example, have no
  REST form).
- Capability input schemas must accept their own output: MCP parses input twice (the SDK, then
  invokeCapability). No .transform(), no .pipe() to another type, no z.stringbool(); transform in
  the handler. validateRegistry rejects type-changing input; .overwrite() and z.preprocess() must
  be idempotent by construction.
- REST: `GET /api/v1/<module>/<capability>` with query params mirroring the input schema; the JSON
  body is the same envelope MCP returns as `structuredContent`. The REST API is unstable until v1.
- Tool names are `<module>_<verb_or_noun>`, snake_case. Descriptions say what the tool answers and
  which tool to use instead when it does not fit.
- Every tool declares `inputSchema` and `outputSchema` and returns the provenance block
  (`sources: [{ url, as_of }]`).
- Upstream adapters build every path through `pathSegment()` (`src/upstreams/http.ts`) for each
  caller-supplied value and fetch only through `fetchUpstream`, which refuses redirects that leave
  the upstream's base URL. Upstream `baseUrl`s are `https:`, carry no credentials and end with `/`;
  `ttlSeconds` is a positive integer, `timeoutMs` (at most 60000) and `maxBytes` positive integers
  when set (`assertUpstream` enforces this). `fetchUpstream` stops reading a body past `maxBytes`
  (default 2 MiB) and fails with `upstream_error`.
- The docs index is built, never fetched at runtime: `scripts/build-docs-index.ts` reads
  `docs-sources.yaml`, and the Worker imports the result from `generated/`. The build also fetches each
  site page's HTML, only to split h2 records at their h3 headings; those fixtures sit next to
  `search.json` and are not `meta.inputs` entries. It also records each
  input's source commit (a repo's branch head; the site's live Pages deployment) through the GitHub
  adapter; those responses are fixtures under `test/fixtures/docs/api.github.com/`. Adding a docs source
  means editing `docs-sources.yaml`, running `npm run docs:record`, and committing the new
  fixtures and the updated snapshot (`npx vitest run -u test/docs-index`). Re-recording can drop a
  section an eval question names; `test/docs-eval` then fails until `eval/docs-questions.yaml` is
  updated in the same PR.
- The docs evaluation (`eval/docs-questions.yaml`) holds real questions, each with every section URL
  that answers it on its own. Questions go to `docs_search` verbatim. Never reword a question or
  narrow its answers to improve a score. A ranking change reports `npm run eval:docs` before and
  after in its PR.
- MCP text content carries the data, not only the summary: a successful tool result's `content` is
  the summary, then `JSON.stringify({ data, sources })` (`envelopeTextBlocks` in src/envelope.ts),
  so clients that ignore `structuredContent` see the same facts. Never build `content` any other way.
- No tool returns more than ~8 KB of text. `invokeCapability` runs `assertEnvelopeSize` on the
  envelope after the output schema parse (what the transports send), checking
  `JSON.stringify(envelope)` against `MAX_RESULT_BYTES` (8192), which is always larger than the
  MCP text content, so one check bounds REST, `structuredContent` and `content`.
- Usage events carry no argument values and no client addresses; the Analytics Engine layout in
  src/usage.ts is append-only, and a layout change needs a new dataset name.
- Tests never hit the network: upstream calls go through an injectable `fetch`, fed from
  `test/fixtures/`.
- No secrets in code, fixtures or CI logs. The Worker's only secret is a GitHub token with no
  repository permissions.
- CI on `pull_request` runs tests only and never sees secrets. The Deploy workflow runs only from
  main (push, the daily docs rebuild, the docs-updated dispatch, by hand) in the production
  environment. Secrets live in GCP Secret Manager (cdsci-infra); GitHub and Cloudflare hold
  copies (docs/deploy.md).

## Commands

Node ≥ 22.12 (CI uses 24).

- `npm ci`: install exactly what `package-lock.json` pins.
- `npm test`: Vitest in Node. Network is disabled; upstreams come from `test/fixtures/` via
  `deps.fetch`.
- `npm run typecheck`: `tsc` (TypeScript 7) against the Workers runtime types in
  `worker-configuration.d.ts`.
- `npm run dev`: `wrangler dev` on http://127.0.0.1:8787. Check it with
  `curl -s -X POST http://127.0.0.1:8787/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
- `npm run build`: bundle with `wrangler deploy --dry-run --outdir dist` (no deploy, no
  credentials).
- `npm run docs:fixtures`: build `generated/docs-index.js` from `test/fixtures/docs/` (no network).
  `npm test`, `typecheck`, `dev` and `build` do this first when the file is missing. Bare
  `npx vitest` or `npx tsc` on a fresh clone fail with "Cannot find module '../../generated/docs-index'"
  until `npm run docs:fixtures` has run once.
- `npm run docs:build`: build it from the live docs (network). `npm run docs:record` does the same
  and re-records `test/fixtures/docs/`. Both call the GitHub API (about 14 requests); export
  `GITHUB_TOKEN` (e.g. `GITHUB_TOKEN=$(gh auth token) npm run docs:record`) to avoid the 60-per-hour
  anonymous limit. The build reads the token from the shell, not from `.dev.vars`.
- `npm run eval:docs`: recall@1, recall@5 and MRR@10 of `docs_search` on
  `eval/docs-questions.yaml`, over an index built in memory from `test/fixtures/docs/` (no
  network). Add `-- --network` to use the live docs. It fails only when an answer URL is not in
  the index; scores never fail it.
- `npm run cf-typegen`: regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`.
- Deploying: see docs/deploy.md. Never run wrangler deploy from a branch.

Adding a capability: define it with `defineCapability` in `src/core/<module>/`, add it to the
module's `capabilities`, add the module to `modules` in `src/core/registry.ts`. MCP and REST pick
it up; `validateRegistry` enforces naming and REST-compatible input.

MCP resources and prompts belong to a module too: `resources` (a `ResourceTemplateDef` under
`bioc://<module>/`) and `prompts` (`definePrompt`, listing every tool its text names in `tools`).
Both are MCP only; a prompt is offered only on toolsets that include all of its tools, and a prompt
that names another module's tools makes that module a registration dependency (`validateRegistry`
rejects unknown tools; test apps must register both). Bundled,
build-time data (like the docs index) is reported to `bioc://about` through `datasets`.

## Git

- Branch per issue: `issue-<n>-<slug>`. PRs say `Closes #<n>`.
- Small, well-described commits. Code commits carry a `Co-Authored-By` trailer when an agent wrote
  them.
- Never `git stash` (parallel worktrees share the stash). Never force-push `main`.
