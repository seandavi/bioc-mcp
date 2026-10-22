# bioc-manifest

[![validate](https://github.com/seandavi/bioc-manifest/actions/workflows/validate.yml/badge.svg)](https://github.com/seandavi/bioc-manifest/actions/workflows/validate.yml)

The governance trust root for [bioc-build](https://github.com/seandavi/bioc-build):
one YAML file per package the build system is authorized to build, plus the
policy it builds under. Changes here are **human pull requests only** — no
automated writer, no secrets, no code runs except the validator that checks a
PR is well formed. This list is "the manifest"; "the registry" is a different
repo, [bioc-registry](https://github.com/seandavi/bioc-registry), the trusted
data plane that serves built packages.

The build system pins a commit of this repo (`manifest_ref`) and refuses to
build a package that isn't listed here as `state: active` for the stream it's
building.

## Entry format

`packages/<name>.yaml`:

```yaml
name: msdata
git_url: https://git.bioconductor.org/packages/msdata
component: data-experiment        # data-experiment | workflows
profile: data-experiment          # key in policy.yaml
streams: [release, devel]         # which admin/manifest branches list it
state: active                     # active | deprecated
since: "2026-09-03"
```

`policy.yaml` holds the build settings per `profile` (check args, BioCheck
strictness) and a `policy_version` the build records against every attempt.

`versions.yaml` is the single source for the current Bioconductor release and
devel version pair; it drives which `RELEASE_<X_Y>` branch `scripts/import.py`
reads and which git branch and container tag (`bioconductor/bioconductor_docker:RELEASE_<X_Y>`
/ `:devel`) consumers of this repo build against. Nothing here or in
consuming repos fetches bioconductor.org for this — a release roll is a PR
bumping `versions.yaml`.

## Adding a package

Open a PR adding `packages/<name>.yaml` in the format above. It must pass
`.github/workflows/validate.yml`.

## Deprecating a package

Open a PR setting `state: deprecated` on its file and say why in the PR
description. The build system stops building it once the PR merges and the
build system's pinned commit moves.

## Regenerating from upstream

`packages/*.yaml` was seeded by `scripts/import.py`, which reads
`data-experiment.txt` and `workflows.txt` from Bioconductor's own
[admin/manifest](https://git.bioconductor.org/admin/manifest) on the `devel`
and current `RELEASE_<X_Y>` branches. It's idempotent and safe to rerun — it
refreshes `streams` but never touches `state` or `since` on an existing file.

```sh
python3 scripts/import.py
```

## Validating

```sh
python3 scripts/validate.py            # checks packages/*.yaml + policy.yaml
python3 scripts/validate.py --selftest # proves the validator rejects a broken fixture
```

Both are stdlib-only, no dependencies.
