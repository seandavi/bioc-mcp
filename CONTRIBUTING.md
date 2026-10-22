# Contributing

Thanks for helping. The most useful contributions, roughly in order:

1. **Questions it answers badly.** Open an issue with the question, what the server returned, and
   where the right answer lives. These become evaluation cases.
2. **Docs sources.** A public page that should be searchable through `docs_search`.
3. **New tools or modules.** Open an issue first with the question the tool answers and the public
   endpoint behind it. A tool that needs non-public data does not belong here.
4. **Fixes** to existing tools.

## Ground rules

- **Read-only, public upstreams only.** Every tool wraps an endpoint reachable without credentials
  (a GitHub read token for rate limits is the one exception).
- **Every result carries provenance:** the upstream URL(s) and their freshness.
- **Tests run against recorded fixtures,** never live upstreams.
- **Keep results small** (about 8 KB of text at most); paginate or excerpt.

## Development

Setup and commands are in [AGENTS.md](AGENTS.md), which humans and coding agents both follow.

## How work is done here

Issues are implemented through a spec → implement → review → revise → PR loop, described in
[`.pi/factory.md`](.pi/factory.md). Human contributions do not need to follow it; a focused PR
with tests is welcome.
