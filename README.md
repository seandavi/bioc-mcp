# bioc-mcp

**A public, read-only [Model Context Protocol](https://modelcontextprotocol.io) server, and the
equivalent REST API, for Bioconductor.** Connect an AI agent (Claude, Codex, Gemini, …) to one URL and it can search the
Bioconductor infrastructure docs, check a package's build and propagation state, read why a check
failed, and see what is happening across the stack, with every answer linked to the public source
it came from.

> **Status: pre-alpha.** Nothing is deployed yet. The design is in the
> [spec](https://github.com/seandavi/bioc-infrastructure/blob/main/proposal-mcp.qmd)
> ([bioc-infrastructure#122](https://github.com/seandavi/bioc-infrastructure/pull/122)); progress is
> tracked in [#1](https://github.com/seandavi/bioc-mcp/issues/1).

## What it will offer (v0)

| Module | Tools | Answers |
|---|---|---|
| `docs` | `docs_search`, `docs_read` | Why does the infrastructure work this way? (ADRs, runbooks, plans) |
| `pkg` | `pkg_status`, `pkg_check_output`, `pkg_build_environment`, `pkg_release_info`, `pkg_downloads` | Is this package propagated, did it pass check, why not, who downloads it? |
| `ops` | `ops_activity` | What is open, failing or stale across the `bioc-*` repos? |

Every capability is also a REST endpoint under `/api/v1/` (OpenAPI at `/api/openapi.json`).
Every module is served at `/mcp`; a subset is served at `/mcp/{module}` or
`/mcp/{module}+{module}` so clients only load the tools they need.

## Principles

- **Public data only.** Every tool is a thin adapter over an endpoint anyone can `curl`. No
  secrets, no private logs, no writes.
- **Provenance on every answer.** Results carry the upstream URL and its freshness.
- **Small results.** Check logs are cut to their failing sections; lists paginate.

## Contributing

New modules, docs sources and evaluation questions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Apache 2.0.
