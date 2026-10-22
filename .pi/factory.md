# The factory: spec → implement → review → revise → PR

An experiment in running issues through a fixed loop of
[pi-subagents](https://github.com/nicobailon/pi-subagents), with the strong model where judgment
matters and the fast model where volume does. The script is
[`.pi/workflows/factory.js`](workflows/factory.js).

| Stage | Model | Agent | Writes | Output |
|---|---|---|---|---|
| Spec | Opus | `worker` | `docs/specs/<issue>-<slug>.md`, one commit | `{status, spec_path, blocking_questions}` |
| Implement | Sonnet | `worker` | code + tests, small commits | `{status, summary, changed_files, checks}` |
| Review | Opus | `reviewer` (read-only), one per lens, in parallel | nothing | `{verdict, findings[]}` |
| Revise | Sonnet | `worker` | fixes for blocker/major findings | `{status, responses[], checks}` |
| PR | Sonnet | `worker` | push + `gh pr create` | `{pr_url, draft}` |

**Review lenses** (chosen per issue from labels):

- `code` (always): correctness against the spec, tests that would catch a regression, the
  one-capability-two-transports rule, Ousterhout-style deep modules with clear seams, no
  network in tests.
- `ux` (label `review:ux`): the agent and developer experience. Tool names, descriptions that
  say when *not* to use the tool, input/output schemas, error messages an agent can act on,
  result size, provenance; REST paths and OpenAPI; README and connection instructions.
- `security` (label `review:security`): SSRF (no tool fetches a caller-supplied URL), input
  validation, secret handling, fork-PR CI safety, rate limiting, nothing non-public returned.

**Seams** (label `seam`, arg `seam: true`): for shared foundations that later issues build on, the
reviewers are told to rate inherited defects by blast radius, so a bypassable guard is `major`
even when nothing calls it yet. Added after #2, where four such findings came back as `minor`.

**Finding ids** are `<lens>-r<round>-<n>`, unique across rounds.

**Revise rounds:** at most two. Only `blocker` and `major` findings trigger a round, and only the
lenses that asked for changes review again. If findings remain after round two, the PR opens as a
**draft** listing them. `minor` and `nit` findings go into the PR body as a follow-up checklist.

**Stops:** a spec with blocking questions stops the run before any code is written; an
implementation reporting `blocked` stops before review. Both return to the human.

**Never automated:** merging. A human merges, from the main session.

## Running it

Prepare an isolated worktree for the issue (the workflow sandbox has no shell), then launch:

```sh
git -C ~/Documents/git/bioc-mcp fetch origin
git -C ~/Documents/git/bioc-mcp worktree add -b issue-2-scaffold \
  ~/Documents/git/bioc-mcp-worktrees/issue-2 origin/main
```

```js
subagent({
  workflow: "./.pi/workflows/factory.js",
  cwd: "~/Documents/git/bioc-mcp",
  args: {
    repo: "seandavi/bioc-mcp", issue: 2, slug: "scaffold",
    worktree: "/Users/<you>/Documents/git/bioc-mcp-worktrees/issue-2",
    branch: "issue-2-scaffold", lenses: ["code", "ux", "security"], seam: true
  }
})
```

## What to watch while it is an experiment

- Do the reviews find real problems, or restate the spec? (Count findings that led to a change.)
- Does round two ever happen, and does it converge?
- Time and tokens per stage, from the run receipts.
