# Spec #38: README refresh, client connection guide and community files

Issue: [seandavi/bioc-mcp#38](https://github.com/seandavi/bioc-mcp/issues/38).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md). Client quirks and the compatibility matrix stay in
[#12](https://github.com/seandavi/bioc-mcp/issues/12).

The following was checked on 2026-10-22 against `main` at `4264422` and the live Worker.
**Verified** marks what was observed:

- **Verified:** live `tools/list` on `https://bioc-mcp.seandavi.workers.dev/mcp` returns 7 tools:
  `meta_ping`, `pkg_status`, `pkg_check_output`, `pkg_build_environment`, `pkg_release_info`,
  `pkg_downloads`, `ops_activity`. `/mcp/pkg+ops` returns the 6 `pkg_*`/`ops_*` tools. The
  `docs` module is PR #31 (open, not deployed).
- **Verified:** REST routes from the live `/api/openapi.json`: `/api/v1/meta/ping`,
  `/api/v1/pkg/status` (`package`, `universe` ∈ `bioc` (devel, default) | `bioc-release`),
  `/api/v1/pkg/check_output`, `/api/v1/pkg/build_environment`, `/api/v1/pkg/release_info`,
  `/api/v1/pkg/downloads` (`package`, `year`), `/api/v1/ops/activity` (`repo`, `kind` ∈
  `summary|issues|prs|workflows|failures`), `/api/v1/about`. `GET /` is a 404 JSON error.
  `GET /api/v1/pkg/status?package=edgeR` returns `{data, summary, sources}` with
  `sources[] = {url, as_of}` (e.g. `https://bioc.r-universe.dev/api/packages/edgeR`).
- **Verified:** rate limit is 120 requests / 60 s per client address (`wrangler.jsonc`
  `RATE_LIMITER`, applied to `/mcp/*` and `/api/*` in `src/index.ts`); over it the server answers
  429, `retry-after: 60`, body `{"error":{"code":"rate_limited",…}}` (`src/rate-limit.ts`).
- **Verified:** `LICENSE` is Apache 2.0; the README already says "Apache 2.0" (keep, link it).
  The README's spec link (`bioc-infrastructure/blob/main/proposal-mcp.qmd`) is a 404: PR
  bioc-infrastructure#122 is unmerged, the file lives on branch `spec/mcp`. The README says
  "Today the only tool is `meta_ping`": stale.
- **Verified client syntax** (help output and temp-dir runs, no user config touched):
  - `claude` 2.1.302: `claude mcp add [--transport http] [--scope local|user|project] <name> <url>`;
    `claude -p --strict-mcp-config --mcp-config <file>` loads only the given servers.
  - `codex` 0.146.0: `codex mcp add <name> --url <url>`. With `CODEX_HOME=<tmp>` it wrote
    `[mcp_servers.bioc]` / `url = "https://bioc-mcp.seandavi.workers.dev/mcp"` to
    `<tmp>/config.toml`; `codex exec` accepts `-c key=value` overrides, `--skip-git-repo-check`,
    `--ephemeral`.
  - `gemini` 0.38.2: `gemini mcp add [-s user|project] [-t http] [--trust] <name> <url>`;
    default scope is `project` (writes `./.gemini/settings.json`, verified in a temp dir:
    `{"mcpServers":{"bioc":{"url":"…/mcp","type":"http"}}}`). `-p` is headless;
    `--allowed-mcp-server-names` restricts servers.
  - R: ellmer 0.4.2, mcptools 1.0.1. `mcptools::mcp_tools(config)` takes a path to a Claude
    Desktop-format JSON file; a remote server is `{"mcpServers":{"<name>":{"url":"https://…"}}}`
    (Streamable HTTP, HTTPS required). So **`mcp-remote` is not needed** for R.
- **Verified bug (R):** with mcptools 1.0.1, `mcp_tools()` lists our tools and `meta_ping()`
  works, but `pkg_status(package = "edgeR")` fails with `Error in x[[i]] : subscript out of bounds`
  in `mcp_redact_secrets()` (client debug logging), because the result contains JSON `null`
  (`"distro":null`, …). This is [posit-dev/mcptools#135](https://github.com/posit-dev/mcptools/issues/135),
  fixed by commit `714803b` on 2026-10-20, **after** the latest CRAN release (1.0.3, 2026-09-18).
  The fixed build is `1.0.3.9000` on `https://posit-dev.r-universe.dev` (verified: r-universe
  reports `1.0.3.9000`, `RemoteSha 714803b`). Any tool result containing a `null` fails on CRAN
  mcptools ≤ 1.0.3.
- **Verified:** in this environment `GEMINI_API_KEY` is set, `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY` are not; `ellmer::chat_google_gemini()` exists in 0.4.2.
- **Verified:** repo description, topics (`bioconductor`, `cloudflare-workers`, `mcp`,
  `model-context-protocol`, `u24ca289073`), homepage empty; private vulnerability reporting is
  **disabled** (`gh api repos/seandavi/bioc-mcp/private-vulnerability-reporting` →
  `{"enabled":false}`). Labels `bug`, `enhancement`, `module:docs`, `needs:human` exist.
- **Verified:** `https://support.bioconductor.org` and `https://slack.bioconductor.org` answer 200.
- **Verified:** `uvx --from cffconvert cffconvert --validate -i CITATION.cff` works on this Mac.

No code, schema, upstream or fixture changes. No npm package is added.

## Goal

A first-time user can read the README, copy one URL, connect Claude Code, Codex, Gemini CLI or
R (ellmer + mcptools) to the live server, and ask a first question; a contributor finds how to
report problems, propose tools and docs sources, and what a PR must check. Every documented client
command was actually run against the live server, and the PR records the evidence.

## Non-goals

- Any change under `src/`, `test/`, `scripts/`, `wrangler.jsonc`, `package.json`.
- The real-client compatibility matrix and quirks (#12). The README states only what a user
  needs to connect, plus the mcptools version floor (a user-facing blocker, one line).
- Documenting the `docs` tools as live. They appear under "Coming", pointing at #31.
- `AGENTS.md` and `docs/deploy.md` (they also name the hostname; the "one place" rule is for the
  README, see Decisions).
- Testing Claude Desktop or claude.ai (labelled "not tested").
- Server-side workarounds for the mcptools null bug (the fix is upstream; we document the floor).
- Updating `proposal-mcp.qmd` in bioc-infrastructure.

## Design

### Decisions

1. **The hostname appears exactly once in `README.md`**, in a single fenced block near the top:

   ```sh
   export BIOC_MCP=https://bioc-mcp.seandavi.workers.dev
   ```

   directly under one sentence saying the hostname is temporary and will move to a
   Bioconductor domain, and that this block is the only place to change. Every shell command in the
   README uses `"$BIOC_MCP/…"`; the R snippet reads `Sys.getenv("BIOC_MCP")`; UI-only clients
   (Claude Desktop, claude.ai) say "the URL above followed by `/mcp`". Badge URLs point at
   github.com/img.shields.io, not the hostname. Checked by `grep -c` (Acceptance).
2. **R uses mcptools directly over Streamable HTTP**, no `mcp-remote`. The README requires an
   mcptools build with the #135 fix and installs it from r-universe:
   `install.packages("mcptools", repos = c("https://posit-dev.r-universe.dev", getOption("repos")))`,
   with one sentence: "CRAN mcptools 1.0.3 and earlier fail on any tool result containing `null`
   (posit-dev/mcptools#135); use the r-universe build until the next CRAN release."
3. **Security reports go through GitHub private vulnerability reporting.** The implementer enables
   it (`gh api -X PUT repos/seandavi/bioc-mcp/private-vulnerability-reporting`) and `SECURITY.md`
   links `https://github.com/seandavi/bioc-mcp/security/advisories/new`. No email address in the
   repo.
4. **Repo homepage** is `https://bioc-mcp.seandavi.workers.dev/api/v1/about` (the server has no
   `/` page; `about` lists modules, tools and endpoints).
5. **Verification uses one-off configuration only** and the user's config files are checksummed
   before and after (Verification protocol). Each README client subsection ends with a
   "Tested:" line carrying client version and date, or "Not tested."
6. Issue templates are GitHub **issue forms** (YAML), using existing labels only.

### Files

| File | Change |
|---|---|
| `README.md` | rewrite (structure below) |
| `CONTRIBUTING.md` | refresh (structure below) |
| `SECURITY.md` | new |
| `CITATION.cff` | new |
| `.github/ISSUE_TEMPLATE/bug.yml` | new |
| `.github/ISSUE_TEMPLATE/wrong-answer.yml` | new |
| `.github/ISSUE_TEMPLATE/new-tool-or-source.yml` | new |
| `.github/ISSUE_TEMPLATE/config.yml` | new |
| `.github/pull_request_template.md` | new |
| repo settings | `gh repo edit` + enable private vulnerability reporting (below) |

No other file changes.

### `README.md`

Sections in this order. Keep the existing voice (short declarative sentences); keep the
"Principles" bullets unchanged.

1. **Title + badges** (one line under `# bioc-mcp`):
   ```md
   [![CI](https://github.com/seandavi/bioc-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seandavi/bioc-mcp/actions/workflows/ci.yml)
   [![Deploy](https://github.com/seandavi/bioc-mcp/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/seandavi/bioc-mcp/actions/workflows/deploy.yml)
   [![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
   ```
2. **One-paragraph description** (existing bold lead, edited so it does not claim docs search is
   live: "check a package's build and propagation state, read why a check failed, see release
   dates and downloads, and see what is happening across the `bioc-*` repos; infrastructure docs
   search is coming").
3. **Status** callout: pre-alpha, deploys from `main`, expect breaking changes, REST API unstable
   until v1; spec link fixed to `https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd`
   (bioc-infrastructure#122); tracking issue #1.
4. **Endpoint**: the temporary-hostname sentence, the single `export BIOC_MCP=…` block
   (Decision 1), then a table:

   | Path | What |
   |---|---|
   | `$BIOC_MCP/mcp` | MCP, all modules (Streamable HTTP, no auth, no session) |
   | `$BIOC_MCP/mcp/{module}` | one module, e.g. `/mcp/pkg` |
   | `$BIOC_MCP/mcp/{a}+{b}` | several, e.g. `/mcp/pkg+ops` |
   | `$BIOC_MCP/api/v1/…` | REST, same results as JSON |
   | `$BIOC_MCP/api/openapi.json` | OpenAPI document |
   | `$BIOC_MCP/api/v1/about` | modules, tools, upstream sources (MCP: resource `bioc://about`) |

5. **What is live today** — table with the 7 live tools (module, tool, answers), from the
   verified list. Then **Coming**: `docs` module (`docs_search`, `docs_read`) in #31, not
   deployed.
6. **Connect** — one `###` subsection per client, in this order. Commands verbatim:
   - **Claude Code**
     ```sh
     claude mcp add --transport http --scope user bioc "$BIOC_MCP/mcp"
     ```
     One sentence: drop `--scope user` to add it to the current project only; `claude mcp remove
     bioc` removes it.
   - **Claude Desktop and claude.ai**: Settings → Connectors → Add custom connector; name
     `Bioconductor`, URL = the URL above followed by `/mcp`; no OAuth fields. Ends with
     "Not tested."
   - **Codex CLI**
     ```sh
     codex mcp add bioc --url "$BIOC_MCP/mcp"
     ```
     One sentence: this writes a `[mcp_servers.bioc]` table with `url` to
     `~/.codex/config.toml` (Streamable HTTP); edit or delete it there.
   - **Gemini CLI**
     ```sh
     gemini mcp add --scope user --transport http bioc "$BIOC_MCP/mcp"
     ```
     One sentence: without `--scope user` it goes to `./.gemini/settings.json`.
   - **R (ellmer + mcptools)**: the install line from Decision 2 plus its one-sentence reason, then:
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
     One sentence: for a permanent setup, put the same JSON in
     `~/.config/mcptools/config.json` and call `mcptools::mcp_tools()` with no argument.
     If verification shows `chat_google_gemini()` needs a different call, change the snippet to
     what was run (the snippet must be the verified one).
   - **Any Streamable HTTP client**: `POST $BIOC_MCP/mcp` JSON-RPC, no auth, stateless; the
     existing `curl … tools/list` example from AGENTS.md rewritten with `"$BIOC_MCP/mcp"`.
   - **Load one module only**: point any of the above at `$BIOC_MCP/mcp/pkg` (or `/mcp/ops`,
     `/mcp/pkg+ops`) instead of `/mcp`; fewer tools in the client's context.
   - **First questions to ask** (bullets, each answerable by live tools):
     "Is edgeR propagated in Bioconductor release, and did its last check pass?" (`pkg_status`);
     "Why is <package> failing check on devel? Show the failing part of the log."
     (`pkg_status` → `pkg_check_output`); "What R and OS did that check run on?"
     (`pkg_build_environment`); "When is the next Bioconductor release?" (`pkg_release_info`);
     "How many downloads did edgeR have this year?" (`pkg_downloads`);
     "Which bioc-* workflows are failing right now?" (`ops_activity`).
7. **REST quickstart**:
   ```sh
   curl -s "$BIOC_MCP/api/v1/meta/ping"
   curl -s "$BIOC_MCP/api/v1/pkg/status?package=edgeR&universe=bioc-release"
   curl -s "$BIOC_MCP/api/v1/ops/activity?kind=failures"
   ```
   Then: every body is `{ data, summary, sources }`; `sources` is a list of `{ url, as_of }`, the
   upstream URL and when its data was current; MCP returns the same object as
   `structuredContent` (and as text). A short trimmed example of `sources` from the edgeR call.
   Rate limit: 120 requests per minute per client address (approximate, per Cloudflare location);
   over it, HTTP 429 with `retry-after: 60` and error code `rate_limited`. Applies to `/mcp` too.
8. **Principles** (unchanged).
9. **Run it locally**: existing "Try it locally" text, with the stale "Today the only tool is
   `meta_ping`" sentence removed.
10. **Contributing**: link CONTRIBUTING.md, SECURITY.md, Code of Conduct, the issue forms;
    "Cite it: see CITATION.cff."
11. **License**: "Apache 2.0, see [LICENSE](LICENSE)."

### `CONTRIBUTING.md`

Keep the "most useful contributions" list and "Ground rules"; point items 1–3 at the matching
issue forms. Add sections:

- **Questions** → Bioconductor support site and Slack (same links as `config.yml`); security →
  SECURITY.md.
- **Adding a capability**: the four steps from AGENTS.md (`defineCapability` in
  `src/core/<module>/`, add to the module's `capabilities`, add the module to `modules` in
  `src/core/registry.ts`, record fixtures under `test/fixtures/<upstream>/`); MCP and REST pick it
  up; `validateRegistry` enforces naming and REST-compatible input; link AGENTS.md Rules for the
  rest (schemas, provenance, `pathSegment`/`fetchUpstream`, 8 KB).
- **Tests never hit the network**: upstream calls go through injected `deps.fetch` fed from
  `test/fixtures/`; `npm test` and `npm run typecheck` must pass; never commit secrets or tokens in
  fixtures.
- **How work is done here** (existing factory paragraph, kept) plus: issues and PRs waiting on a
  maintainer carry the `needs:human` label; `gh issue list -l needs:human`; human contributors
  never need the factory.

### `SECURITY.md`

- **Scope:** a public, read-only server over public data; no accounts, no writes, one secret (a
  GitHub token with no repository permissions). In scope: anything that lets a caller reach
  non-public data or hosts (SSRF), make the Worker fetch caller-chosen URLs, leak the token,
  bypass the rate limit at scale, or get the server to return non-public data. Out of scope:
  volumetric DoS, findings in upstream services (report those to their owners), wrong answers
  (use the wrong-answer issue form).
- **Report privately** via `https://github.com/seandavi/bioc-mcp/security/advisories/new`; do not
  open a public issue. Expect an acknowledgement within a week (no stronger promise).
- **Supported version:** only what is deployed from `main`.

### `CITATION.cff`

```yaml
cff-version: 1.2.0
message: "If you use bioc-mcp, please cite it as below."
type: software
title: "bioc-mcp: a read-only MCP server and REST API for Bioconductor"
authors:
  - family-names: "Davis"
    given-names: "Sean"
    affiliation: "University of Colorado Anschutz School of Medicine"
    orcid: "https://orcid.org/0000-0002-8991-6458"
abstract: >-
  A public, read-only Model Context Protocol server, and the equivalent REST API, over public
  Bioconductor infrastructure data: package build, check and propagation state, release
  information, downloads and activity across the bioc-* repositories. Every result carries the
  upstream URL and its freshness.
keywords:
  - Bioconductor
  - Model Context Protocol
  - MCP
  - REST API
  - bioinformatics
license: Apache-2.0
repository-code: "https://github.com/seandavi/bioc-mcp"
```

(Author fields copied from the user's other CITATION.cff files, e.g. `commonplace`; no email, no
version or release date until there is a release.)

### `.github/ISSUE_TEMPLATE/`

All forms: `name`, `description`, `title` prefix, `labels`, `body`. Required fields marked.

- `bug.yml` — name "Bug", title "bug: ", labels `[bug]`. Fields: what you did (textarea,
  required: client or `curl`, tool/route, arguments); what happened (textarea, required: error
  text or response); what you expected (textarea, required); client and version (input).
- `wrong-answer.yml` — name "Wrong or stale answer", title "wrong answer: ", labels `[bug]`.
  Intro markdown: these become evaluation cases. Fields: the question you asked (textarea,
  required); tool and arguments, or REST URL (input, required); what the server returned,
  including `sources` and `as_of` (textarea, required); where the right answer lives (URL)
  (input, required); client (input).
- `new-tool-or-source.yml` — name "New tool or docs source", title "proposal: ", labels
  `[enhancement]`. Fields: kind (dropdown: New tool / New docs source / New module, required);
  the question it answers (textarea, required); public endpoint or page URL (input, required,
  description: must be reachable without credentials); example call and answer (textarea).
- `config.yml`:
  ```yaml
  blank_issues_enabled: true
  contact_links:
    - name: Bioconductor support site
      url: https://support.bioconductor.org
      about: Questions about Bioconductor packages and their use.
    - name: Bioconductor community Slack
      url: https://slack.bioconductor.org
      about: Chat with the Bioconductor community.
    - name: Report a security issue
      url: https://github.com/seandavi/bioc-mcp/security/advisories/new
      about: Report privately; see SECURITY.md.
  ```

### `.github/pull_request_template.md`

```md
Closes #

## What changed

## What I checked
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] New or changed upstream calls have recorded fixtures; no test hits the network
- [ ] Results stay under ~8 KB and carry `sources`
- [ ] Tried it against `npm run dev` or a client (say which, and what you asked)
- [ ] README / AGENTS.md / docs updated if behaviour or commands changed
- [ ] No secrets, tokens or personal data in code, fixtures or logs
```

### Repo settings (implementer runs these; record output in the PR)

```sh
gh repo edit seandavi/bioc-mcp \
  --description "Read-only MCP server and REST API for Bioconductor: package build, check and propagation state, release info, downloads and ops activity. Docs search coming." \
  --homepage "https://bioc-mcp.seandavi.workers.dev/api/v1/about" \
  --add-topic mcp-server --add-topic bioinformatics --add-topic rest-api --add-topic openapi --add-topic r
gh api -X PUT repos/seandavi/bioc-mcp/private-vulnerability-reporting
gh api repos/seandavi/bioc-mcp/private-vulnerability-reporting   # expect {"enabled":true}
```

Existing topics stay.

### Verification protocol (required)

Before and after all client runs, record
`shasum ~/.claude/settings.json ~/.codex/config.toml ~/.gemini/settings.json ~/.Rprofile ~/.config/mcptools/config.json 2>&1`
(missing files show as errors; the output must be identical). `~/.claude.json` is rewritten by
Claude Code on every run and is not compared; never run `claude mcp add` against the real config.
Work in `T=$(mktemp -d)`. Use `/mcp/pkg` so only package tools load. Reference answer:
`curl -s "https://bioc-mcp.seandavi.workers.dev/api/v1/pkg/status?package=edgeR&universe=bioc-release"`.
The prompt for every client:

> Use the bioc pkg_status tool for package edgeR with universe bioc-release. Reply with the
> package version, whether the latest check passed, and one source URL from the result.

"Model saw the data" = the reply's version and source URL match the reference answer.

1. **Claude Code:** `$T/bioc.json` =
   `{"mcpServers":{"bioc":{"type":"http","url":"https://bioc-mcp.seandavi.workers.dev/mcp/pkg"}}}`;
   `claude -p --strict-mcp-config --mcp-config "$T/bioc.json" --allowedTools mcp__bioc__pkg_status "<prompt>"`.
   The README's `claude mcp add` line is checked against `claude mcp add --help` only.
2. **Codex:** in `$T`: `CODEX_HOME=$T/codex codex mcp add bioc --url https://bioc-mcp.seandavi.workers.dev/mcp`
   then `cat $T/codex/config.toml` (checks the README command). Model run with the real home
   (for auth) and an override, which writes nothing:
   `codex exec --skip-git-repo-check --ephemeral -c 'mcp_servers.bioc.url="https://bioc-mcp.seandavi.workers.dev/mcp/pkg"' "<prompt>"`.
   If Codex asks for or denies MCP tool approval, record that verbatim; do not use
   `--dangerously-bypass-approvals-and-sandbox`.
3. **Gemini:** in `$T/gem`: `gemini mcp add --scope project --transport http --trust bioc https://bioc-mcp.seandavi.workers.dev/mcp/pkg`
   then `gemini -p "<prompt>" --allowed-mcp-server-names bioc`. Do not use `--yolo`.
4. **R:** install the r-universe mcptools into `$T/rlib` only
   (`Rscript -e 'install.packages("mcptools", lib = Sys.getenv("RLIB"), repos = c("https://posit-dev.r-universe.dev", "https://cloud.r-project.org"))'`
   with `RLIB=$T/rlib`), then run the README R snippet via `R_LIBS="$T/rlib" BIOC_MCP=https://bioc-mcp.seandavi.workers.dev Rscript <file>`
   with the URL changed to `/mcp/pkg` and the prompt above. Confirm `packageVersion("mcptools")`
   is `1.0.3.9000` or later. Also record the failure with the installed 1.0.1 (same script without
   `R_LIBS`) as the evidence for the version floor.

The implementer returns, per client: version, the exact command, pass/fail, and whether the model
saw the data (with the version and URL it reported). The PR body carries that table verbatim. A
client that cannot be exercised is "Not tested" in the README with the reason in the PR.

### Capabilities, schemas, routes, upstreams

None. No capability, zod schema, MCP tool, REST route, upstream call or fixture changes.

## Acceptance criteria

- [ ] `grep -c 'bioc-mcp.seandavi.workers.dev' README.md` prints `1`, and that line is the
      `export BIOC_MCP=…` block; the temporary-hostname sentence is directly above it.
- [ ] README no longer contains "Today the only tool is"; the spec link is
      `…/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd`; it lists exactly the 7 live tools as
      live and `docs_search`/`docs_read` only under "Coming" with #31.
- [ ] README has CI, Deploy and Apache 2.0 license badges as specified; the license line links
      `LICENSE`.
- [ ] README Connect has subsections for Claude Code, Claude Desktop and claude.ai, Codex CLI,
      Gemini CLI, R, any Streamable HTTP client, one-module loading, and first questions; each
      client subsection ends with "Tested: <client> <version>, 2026-MM-DD" or "Not tested."
      Claude Desktop/claude.ai say "Not tested."
- [ ] Every README client command is the one that was run in the Verification protocol (modulo
      the `$BIOC_MCP` substitution, `/mcp` vs `/mcp/pkg`, and `--scope`).
- [ ] README REST section has the three `curl` calls, describes `sources`/`as_of`, and states
      120 requests/min per address, 429, `retry-after: 60`, `rate_limited`.
- [ ] R section has the r-universe install line and the posit-dev/mcptools#135 sentence; no
      `mcp-remote`.
- [ ] `SECURITY.md`, `CITATION.cff`, the four `.github/ISSUE_TEMPLATE/*.yml` files and
      `.github/pull_request_template.md` exist with the content above.
- [ ] `uvx --from cffconvert cffconvert --validate -i CITATION.cff` reports valid.
- [ ] Every `.github/ISSUE_TEMPLATE/*.yml` parses:
      `node --input-type=module -e "import {parse} from 'yaml'; import fs from 'node:fs'; for (const f of fs.readdirSync('.github/ISSUE_TEMPLATE')) parse(fs.readFileSync('.github/ISSUE_TEMPLATE/'+f,'utf8'))"`.
      Labels used are only `bug` and `enhancement`.
- [ ] Every relative link in README.md, CONTRIBUTING.md and SECURITY.md resolves to an existing
      file in the repo.
- [ ] CONTRIBUTING.md has the Questions, Adding a capability, Tests never hit the network and
      `needs:human` content above.
- [ ] `gh repo view seandavi/bioc-mcp --json description,homepageUrl,repositoryTopics` shows the
      new description, homepage and added topics (old topics kept);
      `gh api repos/seandavi/bioc-mcp/private-vulnerability-reporting` → `{"enabled":true}`.
- [ ] The Verification protocol's before/after `shasum` outputs are identical, and per-client
      results (version, command, pass/fail, model saw data) are in the implementer's output for
      the PR body.
- [ ] `npm test` and `npm run typecheck` pass (sanity: no code changed). No file outside the Files
      table changes.

## Test plan

No automated tests are added: nothing executable changes. The checks are the Acceptance commands
(grep count, cffconvert, YAML parse, relative-link check, `gh` reads) plus the manual Verification
protocol, whose results go in the PR. `npm test` and `npm run typecheck` run once as a sanity check.

## Risks

- **mcptools floor may go stale quickly.** When CRAN gets a release after 1.0.3 with the #135 fix,
  the r-universe install line becomes unnecessary. The sentence names the issue so a reader can
  check; #12 should track removing it.
- **Hostname move.** README is one edit; `gh repo edit --homepage`, `AGENTS.md`, `docs/deploy.md`,
  `wrangler.jsonc` (`ALLOWED_HOSTS`/`ALLOWED_ORIGINS`) and the deploy workflow's environment URL
  also name it. Out of scope here; listed so the move is not surprised.
- **Enabling private vulnerability reporting** is a repo setting the issue did not name
  explicitly (it asks for `SECURITY.md` "how to report"). It is reversible
  (`gh api -X DELETE …/private-vulnerability-reporting`). The alternative, an email address in
  `SECURITY.md`, puts a personal address in the repo.
- **Model runs are non-deterministic.** A client may answer without calling the tool or fail on
  approval prompts; the implementer records what happened rather than retrying until it passes,
  and labels a client "Not tested" only if it could not be exercised at all.
- **Codex/Gemini model runs read the user's real home** (for auth) with overrides only; the
  checksum step catches any accidental write to their config files.
- **Merge conflict with PR #31**, which may also touch README. Whichever lands second updates the
  live/coming tables.
- **Unverified UI path:** the Claude Desktop/claude.ai connector steps come from the product's
  public UI, not a test; they are labelled "Not tested."
