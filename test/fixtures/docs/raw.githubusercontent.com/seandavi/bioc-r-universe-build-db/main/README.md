# Bioconductor R-Universe Build Tracker

[![Sync Bioconductor Builds](https://github.com/seandavi/bioc-r-universe-build-db/actions/workflows/sync.yml/badge.svg)](https://github.com/seandavi/bioc-r-universe-build-db/actions/workflows/sync.yml)

The [r-universe bioconductor build system](https://bioc.r-universe.dev/builds) tracks the most recent build of each package and makes it available via an [API](https://bioc.r-universe.dev/apis).
However, historical tracking of build results is not directly available. 
This package and the automation in the associated github actions workflow builds that historical database. 
For most folks coming to this repo, the most valuable feature will be the "data" that are captured. 

## The data

Currently, data are tracked in the [data branch](https://github.com/seandavi/bioc-r-universe-build-db/tree/data).

Each file/build combination is captured as a single file. See the Storage Format section below. 

To get a copy of the data locally, use this cloning command line:

```bash
git clone -b data --single-branch https://github.com/seandavi/bioc-r-universe-build-db
```


## Storage Format

Builds are stored as JSON files organized by date and package:

```
data/
  builds/
    2026/
      02/
        GEOquery/
          GEOquery_21698513671.json
        AnVIL/
          AnVIL_21698515771.json
        RbowtieCuda/
          RbowtieCuda_20865985987.json  # failed build
  cursor.json
```

**Filename format:** `{Package}_{RunID}.json`

The run ID is the GitHub Actions workflow run number, which uniquely identifies each build attempt. This allows tracking:
- Multiple builds of the same version (e.g., retries)
- Failed builds (stored with `_type: "failure"` in the JSON)

Here is an example build output result file: https://github.com/seandavi/bioc-r-universe-build-db/blob/data/builds/2026/02/BiocPkgTools/BiocPkgTools_21560086190.json

## GitHub Actions

The included workflow (`.github/workflows/sync.yml`) runs every 30 minutes to sync new builds to a separate `data` branch.

### Manual Triggers

- **Sync:** Run incremental sync
- **Backfill:** Download all current packages (with optional limit)

### Setup

1. Push this repo to GitHub
2. The workflow will automatically create the `data` branch on first run
3. Builds accumulate in the `data` branch, keeping `main` clean

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `https://bioc.r-universe.dev/feed.xml` | RSS feed of recent builds |
| `https://bioc.r-universe.dev/api/packages/{name}` | Single package JSON |
| `https://bioc.r-universe.dev/api/packages?stream=1` | All packages (NDJSON stream) |

## Dependencies

- `universal-pathlib` - Cloud-ready file paths
- `httpx` - HTTP client
- `pydantic` - Data validation
- `click` - CLI framework
- `feedparser` - RSS parsing
- `tenacity` - Retry logic

## Installation

Requires Python 3.10+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
```

## Usage

### Incremental Sync (RSS Feed)

Fetch new builds since the last sync:

```bash
uv run bioc-tracker sync
```

The sync command:
- Loads the cursor (last processed timestamp)
- Fetches the RSS feed
- Downloads full package JSON for each new item
- Saves to storage and updates cursor

### Backfill (All Current Packages)

Download all current packages from the NDJSON endpoint:

```bash
uv run bioc-tracker backfill
```

Use `--limit N` for testing:

```bash
uv run bioc-tracker backfill --limit 10
```

### Check Status

View cursor state and storage statistics:

```bash
uv run bioc-tracker status
```

### Options

All commands support:
- `--data-dir PATH` - Custom data directory (default: `data/`)
- `--dry-run` - Show what would happen without saving
- `-v, --verbose` - Enable debug logging

