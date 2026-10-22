# bioc-harnesses

Agentic coding harnesses for [Bioconductor](https://bioconductor.org), built as
[pi](https://github.com/badlogic/pi-mono) extensions.

Three personas need three different harnesses. They share a little substrate and almost nothing
else:

| | who | verification | shape |
|---|---|---|---|
| `pi-bioc-dev` | package maintainers | `R CMD build` → `check` → `BiocCheck` | one agent |
| `pi-bioc-analysis` | scientists analyzing data | contract checks + reproducibility diff | one agent, two modes |
| `pi-bioc-infra` | Bioconductor core team | partial — build status is objective, triage priority isn't | a fleet |

**Status: specification.** No implementation yet. The specs are grounded in fetched primary sources
rather than recall — every Bioconductor rule cited traces to a URL in `research/`.

## Why three

A maintainer with a failing check and a scientist with a `SummarizedExperiment` are not the same
user, and the difference shows up in verification. `R CMD check` is a real oracle: the dev harness
can be built as a maker/checker loop with a definition of done. Analysis has no such oracle —
which is the hard part of this project, and the reason `pi-bioc-analysis` is organized around
making its own reasoning auditable rather than around asserting correctness.

## Layout

```
research/   primary-source reference, fetched not recalled
specs/      what to build, and what deliberately not to
eval/       personas for UI/UX evaluation
```

| Document | |
|---|---|
| [`DESIGN.md`](DESIGN.md) | the three harnesses and why they're separate |
| [`research/bioconductor-developer-landscape.md`](research/bioconductor-developer-landscape.md) | BiocCheck, version rules, git footguns, submission state machine, build reports, AI policy |
| [`research/s7-classes.md`](research/s7-classes.md) | S7 API, validators, S4 interop, Bioconductor's position |
| [`research/existing-repos.md`](research/existing-repos.md) | what already exists; reuse candidates and gaps |
| [`specs/00-shared-tools.md`](specs/00-shared-tools.md) | R session, registry client, docs lookup |
| [`specs/01-dev.md`](specs/01-dev.md) | maintainer harness |
| [`specs/02-analysis.md`](specs/02-analysis.md) | analyst harness |
| [`specs/03-infra.md`](specs/03-infra.md) | core-team harness |
| [`specs/04-kernel.md`](specs/04-kernel.md) | shared kernel + attributed event ledger |
| [`eval/personas.md`](eval/personas.md) | six personas, each testing one UX hypothesis |

## Two things that shaped the design

**Bioconductor has a binding AI policy.**
[§19](https://contributions.bioconductor.org/ai-policy-third-party.html) permits AI-assisted
contributions but requires provenance disclosure in the tracker issue, in the PR description
(`Assisted-by: …`), and in the code itself — and states that the human maintainer "will still be
responsible for this code, its reliability and maintenance." So `pi-bioc-dev` emits provenance by
construction and never lands code without human review. That is compliance, not preference.

**Build on what exists.** [`bioc-registry`](https://bioc-registry.seandavi.workers.dev) already
serves build, check, and propagation history over unauthenticated HTTP plus a DuckDB-queryable
Parquet archive. The harnesses call it; they do not grow a second data layer.

## Working on this repo

pi keeps global settings in `~/.pi/agent/` and project-local overrides in `.pi/settings.json`. That
project-local file is per-directory, so **each git worktree gets its own extension set for free**:

```bash
pi install -l ./ext/pi-bioc-dev      # project-local, this worktree only
pi config -l                         # edit project overrides (Tab switches scope)
```

Keep sessions out of the way with `--session-dir .pi/sessions/<name>` (gitignored), or
`--no-session` for one-shot runs.

For full isolation — separate extensions, model defaults, and settings — override `HOME`:

```bash
export PIHOME=$PWD/.pi-sandbox
mkdir -p $PIHOME/.pi/agent
ln -s ~/.pi/agent/auth.json $PIHOME/.pi/agent/auth.json   # reuse creds, isolate the rest
HOME=$PIHOME pi ...
```

Scripted runs against project-local settings need `--approve`, or pi's trust prompt will block.

## License

MIT
