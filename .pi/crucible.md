# pi-crucible

Issues here run through the shared [pi-crucible](https://github.com/seandavi/pi-crucible) engine:
spec (Opus) → implement (Sonnet) → parallel review lenses (Opus) → up to two revise rounds → PR,
which a person merges. How it works and every config field: its
[docs/crucible.md](https://github.com/seandavi/pi-crucible/blob/main/docs/crucible.md).

- **Config:** [`crucible.json`](crucible.json): the design spec URL, lenses (`code` always; `ux`,
  `security` by label `review:ux` / `review:security`), the `workers-best-practices` skill, checks
  (`npm run typecheck`, `npm test`). [`../AGENTS.md`](../AGENTS.md) is what every stage reads first.
- **Install** (once per machine): `pi install git:github.com/seandavi/pi-crucible`;
  update with `pi update --extensions`.
- **Run:** in pi, inside this repo: `/crucible <issue>` (`--dry-run` to preview,
  `--start-at review` to re-review a branch). The queue: `gh issue list -l needs:human` and
  `gh pr list -l needs:human`.
- Label `no-factory` marks issues to do by hand.

Until 2026-10-24 this repo kept its own copy, `.pi/workflows/factory.js`; it ran about 25 issues
and is the seed of the shared engine (seandavi/pi-crucible#1). Its history stays in git.
