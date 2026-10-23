# Deploying bioc-mcp

The Worker runs at `https://bioc-mcp.seandavi.workers.dev`. This is the runbook for the secrets,
the first deploy, the docs-rebuild trigger, the usage metric and rollback. Design and reasoning:
[spec #11](specs/11-deploy.md).

## 1. What runs where

| Workflow | Runs on | What it does | Secrets |
|---|---|---|---|
| `ci.yml` | pull requests and pushes to `main` | typecheck, tests | none |
| `deploy.yml` | push to `main`, the daily schedule, `repository_dispatch` `docs-updated`, `workflow_dispatch` | builds the docs index from the live site, typechecks, tests, then `wrangler deploy`; environment `production` (admits only `main`) | `CLOUDFLARE_API_TOKEN` |

Live endpoints: `https://bioc-mcp.seandavi.workers.dev/mcp` (MCP),
`https://bioc-mcp.seandavi.workers.dev/api/v1` (REST) and
`https://bioc-mcp.seandavi.workers.dev/api/openapi.json`.

## 2. Secrets

GCP Secret Manager, project `cdsci-infra`, is the source of truth. The copies in GitHub and
Cloudflare are derived from it and never edited by hand.

| GSM secret | What | Copy lives in |
|---|---|---|
| `cdsci-bioc-mcp-cloudflare-deploy-token` | Cloudflare **Account** API token for the one account that owns `seandavi.workers.dev`, with exactly **Account › Workers Scripts: Edit** and **Account › Account Settings: Read**. Do not start from the "Edit Cloudflare Workers" template, or remove everything else it adds: Workers KV Storage, Workers R2 Storage, Workers Tail, and the zone-level Workers Routes (no routes are used), plus User Details and Memberships if offered | GitHub environment `production`, secret `CLOUDFLARE_API_TOKEN` |
| `cdsci-bioc-mcp-github-token` | GitHub fine-grained token, "Public repositories (read-only)", no permissions; rate limit only | Worker secret `GITHUB_TOKEN` |
| `cdsci-bioc-mcp-analytics-token` | Cloudflare Account API token with only **Account › Account Analytics: Read**, for the usage query (§8). The deploy token does not have this permission and must not be given it | nowhere: exported in a local shell when querying; never in GitHub or the Worker |

Every endpoint `wrangler deploy` uses here (script upload, versions, deployments, the workers.dev
subdomain, the required-secrets check) accepts Workers Scripts: Edit; Account Settings: Read is kept
from the template.

Each GSM secret gets labels `repo=bioc-mcp`, `managed-by=manual` and annotations `consumed-by`,
`scopes` and `rotated` (the convention already used in `cdsci-infra`). The account ID is not a
secret: it is the GitHub environment **variable** `CLOUDFLARE_ACCOUNT_ID` (find it with
`npx wrangler whoami`).

## 3. One-time setup

Done once, by a person with admin rights on the repo and access to `cdsci-infra`:

```sh
gh api -X PUT repos/seandavi/bioc-mcp/environments/production \
  --input - <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST repos/seandavi/bioc-mcp/environments/production/deployment-branch-policies -f name=main -f type=branch
gcloud secrets versions access latest --secret=cdsci-bioc-mcp-cloudflare-deploy-token --project=cdsci-infra \
  | gh secret set CLOUDFLARE_API_TOKEN --env production -R seandavi/bioc-mcp
gh variable set CLOUDFLARE_ACCOUNT_ID --env production -R seandavi/bioc-mcp --body <account-id>
```

The first command creates the `production` environment and turns on custom deployment branch
policies; the second admits `main` only. The environment has no required reviewers, so merges
and the daily rebuild deploy unattended.

## 4. First deploy

By hand, because the Worker does not exist yet and `GITHUB_TOKEN` is a required secret
(`wrangler.jsonc` `secrets.required`), which blocks a CI deploy until the Worker has it. From a
clean checkout of `main`, with `CLOUDFLARE_API_TOKEN` exported from GSM
(`cdsci-bioc-mcp-cloudflare-deploy-token`) and `CLOUDFLARE_ACCOUNT_ID` (from
`npx wrangler whoami`):

```sh
npm ci && npm run docs:build && npm test
npx wrangler deploy --secrets-file <(printf 'GITHUB_TOKEN=%s\n' "$(gcloud secrets versions access latest --secret=cdsci-bioc-mcp-github-token --project=cdsci-infra)")
```

After that, every deploy runs from `deploy.yml` and keeps the Worker's secrets. Never run
`wrangler deploy` from a branch.

## 5. Rotating

Add a new GSM version, then re-run the matching copy command: the `gh secret set` line in
section 3 for the Cloudflare token, or

```sh
gcloud secrets versions access latest --secret=cdsci-bioc-mcp-github-token --project=cdsci-infra | npx wrangler secret put GITHUB_TOKEN
```

for the GitHub token. Revoke the old token after the next successful Deploy run.

## 6. Docs rebuild receiver

The docs index is built into the bundle, so a rebuild that is not deployed never reaches users.
`deploy.yml` listens for `repository_dispatch` type `docs-updated` and for `workflow_dispatch`;
either rebuilds the docs index from the live site and deploys. The daily schedule covers a
missed dispatch.

The sender (bioc-infrastructure's docs deploy; a follow-up issue there) can use either:

- `gh api -X POST repos/seandavi/bioc-mcp/dispatches -f event_type=docs-updated`: the token needs
  **Contents: write** on bioc-mcp, which also allows pushing code.
- `gh api -X POST repos/seandavi/bioc-mcp/actions/workflows/deploy.yml/dispatches -f ref=main`:
  the token needs only **Actions: write**. **Recommended.** A dispatch on another ref cannot
  deploy, because `production` only admits `main`.

The token lives in GSM as `cdsci-bioc-mcp-dispatch-token` and is copied into
bioc-infrastructure's Actions secrets.

## 7. Rate limits

120 requests per 60 s per client address per Cloudflare location, approximate (the Workers
rate-limit binding), on `/mcp*` and `/api/*`. An IPv6 address counts by its /64 prefix, since one
client usually holds the whole /64. MCP and REST share one budget per address. A
refused request gets 429, `Retry-After: 60` and a `rate_limited` error body. If the limiter itself
fails, requests are served. Change the limit in `wrangler.jsonc`; change the period in both
`wrangler.jsonc` and `RATE_LIMIT_PERIOD_SECONDS` in `src/rate-limit.ts`.

## 8. Usage metric

Every capability call writes one data point to the Workers Analytics Engine dataset
`bioc_mcp_usage_v1`. No argument values and no client addresses are recorded.

| Column | Contents |
|---|---|
| `index1` | transport (`mcp` or `rest`) |
| `blob1` | transport |
| `blob2` | capability name (`''` for a rate-limited request) |
| `blob3` | error code (`''` when ok; `rate_limited` for a refused request) |
| `double1` | latency in ms (I/O time; Workers freeze the clock during CPU work) |
| `double2` | highest non-3xx upstream HTTP status seen in the call (0 = none, e.g. a cache hit) |
| `double3` | 1 if ok, else 0 |

Data is kept for 3 months and shows up about a minute after the call. Always weight by
`_sample_interval`. The layout is append-only: a change means a new dataset name. The query uses
its own token, `cdsci-bioc-mcp-analytics-token` (§2), not the deploy token.

```sh
export CLOUDFLARE_ANALYTICS_TOKEN=$(gcloud secrets versions access latest --secret=cdsci-bioc-mcp-analytics-token --project=cdsci-infra)
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
  --data "SELECT blob2 AS capability, blob1 AS transport, sum(_sample_interval) AS calls, sum(_sample_interval * double3) AS ok_calls, sum(_sample_interval * double1) / sum(_sample_interval) AS mean_latency_ms FROM bioc_mcp_usage_v1 WHERE timestamp > now() - INTERVAL '7' DAY GROUP BY capability, transport ORDER BY calls DESC"
```

Rate-limited requests are the rows with `blob3 = 'rate_limited'`.

## 9. Logs and rollback

`npx wrangler tail` shows live logs. The dashboard's Workers Logs keep our `console.error` lines;
per-request invocation logs are off, so URLs and headers are not stored.

```sh
npx wrangler deployments list
npx wrangler rollback [version-id]
```
