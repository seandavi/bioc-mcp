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
  envelope.ts         result envelope: data + text summary + provenance
test/
  fixtures/<upstream>/  recorded upstream responses
```

## Rules

- **One capability, two transports.** Never put logic in a transport. A capability added to
  `core/` appears in MCP and REST, or the PR explains why not (MCP prompts, for example, have no
  REST form).
- REST: `GET /api/v1/<module>/<capability>` with query params mirroring the input schema; the JSON
  body is the same envelope MCP returns as `structuredContent`. The REST API is unstable until v1.
- Tool names are `<module>_<verb_or_noun>`, snake_case. Descriptions say what the tool answers and
  which tool to use instead when it does not fit.
- Every tool declares `inputSchema` and `outputSchema` and returns the provenance block
  (`sources: [{ url, as_of }]`).
- No tool returns more than ~8 KB of text.
- Tests never hit the network: upstream calls go through an injectable `fetch`, fed from
  `test/fixtures/`.
- No secrets in code, fixtures or CI logs. The Worker's only secret is a GitHub token with no
  repository permissions.
- CI on `pull_request` runs tests only and never sees secrets; deploy runs only on push to `main`.

## Commands

Filled in by the scaffold issue (#2): `npm ci`, `npm test`, `npm run typecheck`, `npm run dev`.

## Git

- Branch per issue: `issue-<n>-<slug>`. PRs say `Closes #<n>`.
- Small, well-described commits. Code commits carry a `Co-Authored-By` trailer when an agent wrote
  them.
- Never `git stash` (parallel worktrees share the stash). Never force-push `main`.
