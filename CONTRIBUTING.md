# Contributing

Thanks for helping. The most useful contributions, roughly in order:

1. **Questions it answers badly.** Open a
   [wrong or stale answer](https://github.com/seandavi/bioc-mcp/issues/new?template=wrong-answer.yml)
   issue with the question, what the server returned, and where the right answer lives. These
   become evaluation cases. The cases live in
   [`eval/docs-questions.yaml`](eval/docs-questions.yaml); a PR adding a question with the URL of
   the section that answers it is welcome too.
2. **Docs sources.** A public page that should be searchable through `docs_search`. Use the
   [new tool or docs source](https://github.com/seandavi/bioc-mcp/issues/new?template=new-tool-or-source.yml)
   form.
3. **New tools or modules.** Open the same form first, with the question the tool answers and the
   public endpoint behind it. A tool that needs non-public data does not belong here.
4. **Fixes** to existing tools. Broken behaviour goes in the
   [bug](https://github.com/seandavi/bioc-mcp/issues/new?template=bug.yml) form.

## Questions

Questions about Bioconductor packages and their use belong on the
[Bioconductor support site](https://support.bioconductor.org); for chat, use the
[community Slack](https://slack.bioconductor.org). Security issues go through
[SECURITY.md](SECURITY.md), not a public issue.

## Ground rules

- **Read-only, public upstreams only.** Every tool wraps an endpoint reachable without credentials
  (a GitHub read token for rate limits is the one exception).
- **Every result carries provenance:** the upstream URL(s) and their freshness.
- **Tests run against recorded fixtures,** never live upstreams.
- **Keep results small** (about 8 KB of text at most); paginate or excerpt.

## Development

Setup and commands are in [AGENTS.md](AGENTS.md), which humans and coding agents both follow.

### Adding a capability

1. Define it with `defineCapability` in `src/core/<module>/`.
2. Add it to the module's `capabilities`.
3. Add the module to `modules` in `src/core/registry.ts`, if it is new.
4. Record the upstream responses under `test/fixtures/<upstream>/` and write the tests against them.

MCP and REST both pick it up. `validateRegistry` enforces tool naming and REST-compatible input.
The rest (schemas, provenance, `pathSegment` and `fetchUpstream` for upstream calls, the 8 KB
limit) is in the Rules section of [AGENTS.md](AGENTS.md#rules).

### Tests never hit the network

Upstream calls go through an injected `deps.fetch`, fed from `test/fixtures/`. `npm test` and
`npm run typecheck` must pass. Never commit secrets or tokens in fixtures.

## How work is done here

Issues are implemented through a spec → implement → review → revise → PR loop, described in
[`.pi/factory.md`](.pi/factory.md). Human contributions do not need to follow it; a focused PR
with tests is welcome. Issues and PRs waiting on a maintainer carry the `needs:human` label
(`gh issue list -l needs:human`).
