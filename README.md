# bioc-mcp

[![CI](https://github.com/seandavi/bioc-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seandavi/bioc-mcp/actions/workflows/ci.yml)
[![Deploy](https://github.com/seandavi/bioc-mcp/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/seandavi/bioc-mcp/actions/workflows/deploy.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**A public, read-only [Model Context Protocol](https://modelcontextprotocol.io) server, and the
equivalent REST API, for Bioconductor.** Connect an AI agent (Claude, Codex, Gemini, …) to one URL
and it can check a package's build and propagation state, read why a check failed, see release
dates and downloads, see what is happening across the `bioc-*` repos, and search the
infrastructure docs and ADRs for why it works that way, with every answer linked to the public
source it came from.

> **Status: pre-alpha.** Deploys from `main`; expect breaking changes. The REST API is unstable
> until v1. The design is in the
> [spec](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
> ([bioc-infrastructure#122](https://github.com/seandavi/bioc-infrastructure/pull/122)); progress is
> tracked in [#1](https://github.com/seandavi/bioc-mcp/issues/1).

## Endpoint

The hostname is temporary and will move to a Bioconductor domain. This block is the only place in
this README to change; every command below reads it.

```sh
export BIOC_MCP=https://bioc-mcp.seandavi.workers.dev
```

| Path | What |
|---|---|
| `$BIOC_MCP/mcp` | MCP, all modules (Streamable HTTP, no auth, no session) |
| `$BIOC_MCP/mcp/{module}` | one module, e.g. `/mcp/pkg` |
| `$BIOC_MCP/mcp/{a}+{b}` | several, e.g. `/mcp/pkg+ops` |
| `$BIOC_MCP/api/v1/…` | REST, same results as JSON |
| `$BIOC_MCP/api/openapi.json` | OpenAPI document |
| `$BIOC_MCP/api/v1/about` | modules, tools, upstream sources (MCP: resource `bioc://about`) |

## What is live today

| Module | Tool | Answers |
|---|---|---|
| `meta` | `meta_ping` | Is the server up? |
| `pkg` | `pkg_status` | Is this package propagated, and did its latest build and check pass? |
| `pkg` | `pkg_check_output` | Why did the check fail? The failing part of the log. |
| `pkg` | `pkg_build_environment` | What image, repositories and dependency versions did a build job use? |
| `pkg` | `pkg_release_info` | Which release and devel versions are current, on which R, and when was the release? |
| `pkg` | `pkg_downloads` | How many downloads, and from how many distinct IPs, did this package get each month of a year? |
| `pkg` | `pkg_repo_diff` | How many packages does the registry serve at the same version as bioconductor.org, and which differ? |
| `pkg` | `pkg_revdeps` | Which packages depend on this one, directly or transitively? What breaks downstream if it fails? |
| `pkg` | `pkg_missing_deps` | Which published packages have a hard dependency that is in neither the registry, CRAN nor the Bioconductor data repositories? |
| `ops` | `ops_activity` | What is open, failing or stale across the `bioc-*` repos? |
| `docs` | `docs_search` | Which sections of the infrastructure docs (site pages, ADRs, component docs) match these words? |
| `docs` | `docs_read` | The full text of one docs page or section, from a `docs_search` URL. |

The `docs` module also serves each page as an MCP resource (`bioc://docs/…`) and an
`explain-decision` prompt.
The `pkg` module serves a `triage-failing-package` prompt, which uses `pkg_status`,
`pkg_check_output` and the docs tools, so it is offered only where both modules are (`/mcp`,
`/mcp/pkg+docs`).

## Connect

Run the `export` above first. Each client below was run against the live server on the date shown.

### Claude Code

```sh
claude mcp add --transport http --scope user bioc "$BIOC_MCP/mcp"
```

Drop `--scope user` to add it to the current project only; `claude mcp remove bioc` removes it.

Tested: Claude Code 2.1.302, 2026-10-22.

### Claude Desktop and claude.ai

Settings → Connectors → Add custom connector. Name it `Bioconductor`, set the URL to the URL above
followed by `/mcp`, and leave the OAuth fields empty.

Not tested.

### Codex CLI

```sh
codex mcp add bioc --url "$BIOC_MCP/mcp"
```

This writes a `[mcp_servers.bioc]` table with `url` to `~/.codex/config.toml` (Streamable HTTP);
edit or delete it there.

Tested: Codex CLI 0.146.0, 2026-10-22.

### Gemini CLI

```sh
gemini mcp add --scope user --transport http bioc "$BIOC_MCP/mcp"
```

Without `--scope user` it goes to `./.gemini/settings.json`.

Tested: Gemini CLI 0.38.2, 2026-10-22.

### R (ellmer + mcptools)

```r
install.packages("mcptools", repos = c("https://posit-dev.r-universe.dev", getOption("repos")))
```

CRAN mcptools 1.0.3 and earlier fail on any tool result containing `null`
([posit-dev/mcptools#135](https://github.com/posit-dev/mcptools/issues/135)); use the r-universe
build until the next CRAN release.

```r
# BIOC_MCP comes from the shell; if R was not started there, run
# Sys.setenv(BIOC_MCP = "<the URL above>") first.
config <- tempfile(fileext = ".json")
jsonlite::write_json(
  list(mcpServers = list(bioc = list(url = paste0(Sys.getenv("BIOC_MCP"), "/mcp")))),
  config, auto_unbox = TRUE
)
chat <- ellmer::chat_google_gemini()   # any ellmer chat_*() works
chat$set_tools(mcptools::mcp_tools(config))
chat$chat("Is edgeR passing check in Bioconductor release? Cite the source URL.")
```

For a permanent setup, put the same JSON in `~/.config/mcptools/config.json` and call
`mcptools::mcp_tools()` with no argument.

Tested: ellmer 0.4.2 with mcptools 1.0.3.9000, 2026-10-22.

### Any Streamable HTTP client

`POST $BIOC_MCP/mcp` with JSON-RPC. No auth, no session.

```sh
curl -s -X POST "$BIOC_MCP/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Load one module only

Point any of the above at `$BIOC_MCP/mcp/pkg` (or `/mcp/docs`, `/mcp/ops`, `/mcp/pkg+docs`) instead of `/mcp`.
The client loads fewer tools into its context.

### First questions to ask

- "Is edgeR propagated in Bioconductor release, and did its last check pass?" (`pkg_status`)
- "Why is *package* failing check on devel? Show the failing part of the log." (`pkg_status`, then
  `pkg_check_output`)
- "What image and dependency versions did that check run with?" (`pkg_build_environment`)
- "Which Bioconductor versions are current release and devel, and which R does each use?" (`pkg_release_info`)
- "How many downloads did edgeR have this year?" (`pkg_downloads`)
- "Which release packages does the registry serve at a different version from bioconductor.org, and why?" (`pkg_repo_diff`)
- "Which bioc-* workflows are failing right now?" (`ops_activity`)
- "Why does the registry poll r-universe instead of receiving webhooks? Cite the page." (`docs_search`,
  then `docs_read`)

## REST quickstart

```sh
curl -s "$BIOC_MCP/api/v1/meta/ping"
curl -s "$BIOC_MCP/api/v1/pkg/status?package=edgeR&universe=bioc-release"
curl -s "$BIOC_MCP/api/v1/ops/activity?kind=failures"
curl -s "$BIOC_MCP/api/v1/docs/search?query=propagation+gate"
curl -s -G "$BIOC_MCP/api/v1/docs/read" --data-urlencode 'id_or_url=https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls'
```

Every body is `{ data, summary, sources }`. `sources` is a list of `{ url, as_of }`: the upstream
URL and when its data was current. MCP returns the same object as `structuredContent` (and as
text). Trimmed from the edgeR call:

```json
{
  "data": { "package": "edgeR", "universe": "bioc-release", "…": "…" },
  "summary": "edgeR (bioc-release) is propagated at 4.10.7 …",
  "sources": [
    { "url": "https://bioc-release.r-universe.dev/api/packages/edgeR", "as_of": "2026-10-22T23:07:08.000Z" }
  ]
}
```

Rate limit: 120 requests per minute per client address (an IPv6 /64 counts as one address;
approximate, per Cloudflare location). Over it, the server answers HTTP 429 with `retry-after: 60`
and error code `rate_limited`. This applies to `/mcp` too.

## Principles

- **Public data only.** Every tool is a thin adapter over an endpoint anyone can `curl`. No
  secrets, no private logs, no writes.
- **Provenance on every answer.** Results carry the upstream URL and its freshness.
- **Small results.** Check logs are cut to their failing sections; lists are capped or paginate.

## Run it locally

With Node ≥ 22.12:

```sh
npm ci
npm run dev
```

`npm run dev` serves the Worker at http://127.0.0.1:8787. Point an MCP client that speaks
Streamable HTTP at `http://127.0.0.1:8787/mcp` (or `/mcp/<module>` for one module), or call the
REST API: `curl http://127.0.0.1:8787/api/v1/meta/ping`.

`ops_activity` reads the GitHub API. Without a token GitHub allows 60 requests an hour, and one
all-repo summary uses about 49. Put `GITHUB_TOKEN=<a GitHub token with no repository permissions>`
in `.dev.vars` (gitignored), restart `npm run dev`, and try
`curl 'http://127.0.0.1:8787/api/v1/ops/activity?kind=workflows&repo=bioc-website'`.

More commands are in [AGENTS.md](AGENTS.md#commands).

## Contributing

New modules, docs sources and evaluation questions are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); report problems with the
[issue forms](https://github.com/seandavi/bioc-mcp/issues/new/choose), and security issues as
described in [SECURITY.md](SECURITY.md). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

Cite it: see [CITATION.cff](CITATION.cff).

## License

Apache 2.0, see [LICENSE](LICENSE).
