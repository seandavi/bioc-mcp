# bioc-build

Bioconductor's standalone package build system on GitHub Actions: one
configuration-driven build-and-check pipeline for every package type, starting
with the experiment-data and workflow packages that r-universe does not build.

It is the **build** component of a modular estate. It produces staged artifacts
and events; it never publishes. What is fit to publish, and where it is served,
is [bioc-registry](https://github.com/seandavi/bioc-registry)'s job. Which
packages are authorized, and under which policy, is the manifest's job. The
map of components and the decisions behind them live in
[bioc-infrastructure](https://github.com/seandavi/bioc-infrastructure)
(see [ADR 0010](https://github.com/seandavi/bioc-infrastructure/blob/main/adr/0010-two-new-repos-for-the-build-system-and-the-manifest-name.md)).

## Status

Phase 1 (see [`specs/014-phase1-realization.md`](specs/014-phase1-realization.md)).
`build.yml` (the r-universe engine), `build-package.yml` (our resolve +
call entry point) and `dispatch.yml` are live. The component specs are in
[`specs/`](specs/), starting with [`000-overview.md`](specs/000-overview.md).

## Relationship to r-universe

`build.yml` starts from a verbatim, sha-pinned copy of
[r-universe-org/workflows](https://github.com/r-universe-org/workflows)'
reusable `build.yml` -- same `build-source`/`linux-*`/`bioc-check` actions,
same `check.Renviron`/`getdeps.R`. We only diverge where our own constraints
force it: `actions/build-source/` is a local fork with the packaging-source
100MB cap turned into a policy-driven env var (SPEC-014's whole reason to
exist is packages too large for r-universe's own limit); our own `resolve`
job reads `seandavi/bioc-manifest` and clones `git.bioconductor.org`
directly instead of r-universe's sync mechanism; dependencies resolve
against `bioc-registry`'s served repo instead of a `*.r-universe.dev`
universe; and our output is `staged.json`/`events.ndjson`/attestation
instead of r-universe's store-package/deploy. Run
`scripts/upstream-diff.sh` to see exactly how far `build.yml` has drifted
from upstream at any point.

Not a divergence, but worth knowing: `MY_UNIVERSE` (`https://<universe>.r-universe.dev`)
is still set, because it's derived from `inputs.universe` in upstream's own
workflow-level `env:` block, which we didn't touch. There's no per-job way
to override a workflow-level `env:` value, so unsetting it would mean
editing that verbatim block -- a real divergence, not currently made. Two
visible effects: `entrypoint.sh` prepends `MY_UNIVERSE`'s binary repo ahead
of ours (harmless -- it's checked first, falls through to bioc-registry/CRAN
for anything it doesn't have), and for the `devel` stream (no `RELEASE_`
branch special-case in `entrypoint.sh`) the built package's DESCRIPTION gets
a `Repository:` field pointing at that r-universe URL even though nothing
is actually published there.

## Reproducing a build locally

There's no bespoke script to run by hand any more -- the actual build/check
steps are r-universe's own `linux-*` actions, running inside
`ghcr.io/r-universe-org/base-image`. Two ways to reproduce a run:

- **One package, by hand**: run `build-package.yml`'s `workflow_dispatch`
  from the Actions tab with a `package` and `stream`, or call it from
  another workflow:
  ```yaml
  jobs:
    build:
      uses: seandavi/bioc-build/.github/workflows/build-package.yml@main
      with:
        package: msdata
        stream: devel   # release | devel
  ```
- **Reproduce r-universe's own steps locally**: since `build.yml` is a
  sha-pinned copy of r-universe's reusable workflow (see below), running it
  under [`act`](https://github.com/nektos/act) reproduces the same
  `build-source`/`linux-deps`/`linux-build`/`linux-check` steps a real run
  uses, against `ghcr.io/r-universe-org/base-image` directly.

## Runbook

**Dispatch.** `gh workflow run dispatch.yml -R seandavi/bioc-build -f mode=<mode> [-f packages=a,b] [-f stream=release|devel]`.

- `single`: exactly the given packages and stream (stream required), no change check.
- `backfill`: every active `(package, stream)` in bioc-manifest, optionally filtered by `packages`/`stream`. This is how a new package first enters; run it with an explicit `packages=` list.
- `changed`: what the 6-hourly cron runs. Curated: only pairs already in `attempts.json` (see below).

**Reading `attempts.json`.** `https://bioc-registry.seandavi.workers.dev/data/state/bioc-build/attempts.json`, shape `{pkg: {stream: {commit, status, run_id, run_url, ts, attempts}}}`, written by the publisher. A `failed:*` status is retried by the cron up to 3 times at the same commit. `rejected:<rule>` is not retried until the remote head moves. Pairs that were never attempted are never rebuilt by the cron. The publisher sweeps every 4-6 h, so a finished run shows up there with that delay.

**Which packages can be published.** A rebuild at the same version as an `origin: r-universe` entry in `prop/<u>/index.json` is `rejected:version-gate` by design (see SPEC-014 § PoC exit). Check the index before backfilling a package; the ones absent from it are the candidates.

**Many pairs in one run.** `dispatch.yml` fans every pair into one run, so any artifact name shared across pairs collides. Intermediate artifacts are named `package-source-<pkg>-<stream>` and `bioc-checks-<pkg>-<stream>`; keep new ones per pair.

**Rolling back an index entry.**

1. Fetch the prior record from R2 `prop/<u>/log/<ts>-<pkg>_<ver>.json` and drop its `package` and `run_id` keys.
2. Write that record into `state/bioc-build/published.json` at `[<u>][<pkg>]` with `aws s3 cp` (R2 endpoint, GSM `cdsci-r2-*` keys).
3. On the next publish.yml sweep, the self-heal re-POST upserts it into `prop/<u>/index.json`. The route accepts an entry without `staged` only if it is byte-identical to the `published.json` record.
4. To remove an entry entirely, delete the key from both `published.json` and `prop/<u>/index.json`. To stop future rebuilds, set `state: deprecated` in bioc-manifest via a PR.

**The cron can switch itself off.** GitHub disables `schedule:` workflows after 60 days with no commits to the repo. Re-enable with `gh workflow enable dispatch.yml -R seandavi/bioc-build`. There is no keepalive commit, because it would need `contents: write`.

## Trust model

This repo is public and holds no secrets. Workflow permissions are exactly
`id-token: write, contents: read, attestations: write`. Phase 1 stages a
build's output as a `retention-days: 14` GitHub Actions artifact rather than
through a separate presigned-upload service; `actions/attest-build-provenance`
binds the tarball's digest to this repo's identity, which is what the trusted
`bioc-registry` publisher verifies before it will touch the artifact. See
`specs/014-phase1-realization.md` (normative for phase 1) and
`specs/004-build-workflows.md` / `specs/005-staging-upload-service.md` (the
target architecture phase 1 approximates).
