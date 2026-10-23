# Spec #11: Deploy to workers.dev: rate limiting, usage metrics, deploy-on-main

Issue: [seandavi/bioc-mcp#11](https://github.com/seandavi/bioc-mcp/issues/11) (body plus one
comment: "These secrets should be in google cloud secrets manager."). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Architecture"). Conventions: [AGENTS.md](../../AGENTS.md). Builds on [spec #2](2-scaffold.md),
[spec #3](3-docs-index.md), [spec #15](15-scaffold-followups.md).

Checked on 2026-10-22 against the installed packages (wrangler 4.151.3, workerd 1.20261019.1,
hono 4.13.x) with throwaway copies of the repo outside the worktree. **Verified** marks what those
runs showed:

- **Verified:** wrangler.jsonc accepts `ratelimits`, `analytics_engine_datasets`,
  `secrets.required`, `workers_dev`, `preview_urls` and `observability.logs.invocation_logs`
  (config schema, then `wrangler types` and `wrangler deploy --dry-run --outdir dist` with no
  credentials, which lists `env.USAGE … Analytics Engine Dataset` and
  `env.RATE_LIMITER (120 requests/60s) Rate Limit`).
- **Verified:** after `wrangler types --strict-vars=false`, `Env` gains `USAGE: AnalyticsEngineDataset`,
  `RATE_LIMITER: RateLimit` and `GITHUB_TOKEN: string` (required, because of
  `secrets.required`). The current `interface WorkerEnv extends Env { GITHUB_TOKEN?: string }` then
  fails `tsc` (TS2430, optional vs required), so it must go.
- **Verified:** `RateLimit.limit({ key }): Promise<{ success: boolean }>` and
  `AnalyticsEngineDataset.writeDataPoint(event?): void` (synchronous; no `waitUntil` needed) in
  `worker-configuration.d.ts`.
- **Verified:** in `wrangler dev`, both bindings run locally: a limit of 120/60 s returned 120×200
  then 429; `cf-connecting-ip` is `127.0.0.1`; `writeDataPoint` is a no-op; a missing
  `GITHUB_TOKEN` is only a warning.
- **Verified (wrangler source):** with `secrets.required`, `wrangler deploy` fails with "The
  following required secrets have not been set: GITHUB_TOKEN" when the Worker lacks the secret,
  and the *first* deploy of a Worker that does not exist yet must pass it with
  `--secrets-file` (JSON or .env, read once with `readFileSync`). Later deploys keep secrets.
- **Verified:** Hono `app.use('/mcp/*', …)` runs for `/mcp`, `/mcp/` and `/mcp/pkg`, not for
  `/mcpx`; `app.use('/api/*', …)` runs for `/api/v1/…` and `/api/openapi.json`.
- **Verified:** the whole design below was prototyped in a scratch copy: `tsc` passed with this
  repo's strict flags, the existing 305 tests passed after the signature updates listed under
  [Files](#files), and the new behaviour (events per transport, 429s, AE data point) behaved as
  specified.
- **Verified (GitHub docs, fine-grained token permission table):** `POST /repos/{o}/{r}/dispatches`
  (`repository_dispatch`) needs **Contents: write**; `POST
  /repos/{o}/{r}/actions/workflows/{id}/dispatches` (`workflow_dispatch`) needs **Actions: write**.
- **Verified:** `actions/checkout` v7 = v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1`,
  `actions/setup-node` v7 = v7.1.0 = `949feb2413d6458794dcd2491c4babbbce0c15c1`,
  `actions/upload-artifact` v7 = v7.0.2 = `cf430e030ddbb5b0abf93d22962f4752f3646cd9` (the `v7`
  tag and the release tag resolve to the same commit).
- **From sibling repos (not re-verified here):** `bioc-edge` learned that an Analytics Engine
  dataset's schema is fixed at creation (a 6th blob added later was silently dropped), that
  queries must weight by `sum(_sample_interval)`, and that Logpush is Enterprise-only.
  `taxsea-online` already uses rate-limit `namespace_id` `"1001"`, the Cloudflare docs example.
- **Docs, since verified live (see Risks):** the Cache API page (updated 2026-08-14) no longer lists
  `*.workers.dev` among the places where Cache API calls have no effect, and describes
  workers.dev cache-key behaviour, so `caches.default` should work there. See [Risks](#risks).

## Goal

Ship the Worker to `https://bioc-mcp.seandavi.workers.dev`, safely and observably:

1. `wrangler.jsonc` declares the deployed shape: workers.dev only, the rate-limit and Analytics
   Engine bindings, the required `GITHUB_TOKEN` secret, logs without request metadata.
2. A **Deploy** workflow deploys from `main` only (push, the daily docs rebuild, the docs
   `repository_dispatch`, manual), in a `production` environment restricted to `main`. PR CI is
   unchanged.
3. **Rate limiting** per client address on `/mcp*` and `/api/*` through the Workers rate-limit
   binding: 429 with `Retry-After`.
4. **Usage log:** one Analytics Engine data point per capability call,
   `{ transport, capability, latency_ms, upstream_status, ok, error_code }`, with no argument
   values and no client address. This is the usage metric.
5. **Secrets live in GCP Secret Manager** (project `cdsci-infra`); GitHub and Cloudflare hold
   copies. `docs/deploy.md` is the runbook: secrets, first deploy, the dispatch receiver, usage
   queries, rollback.

## Non-goals

- Creating the Cloudflare API token, the GitHub token, the GSM secrets, the GitHub environment, or
  running the first deploy. Those need a human ([Needs a human](#needs-a-human)); the PR stops at
  green CI.
- Any change in bioc-infrastructure (sending the dispatch). `docs/deploy.md` documents what the
  sender needs; a follow-up issue there does it.
- A custom domain or zone routes (a `bioconductor.org` name waits on bioc-infrastructure#39).
- Workers Caching of the Worker's own responses (the `cache` config key). `caches.default` for
  upstream responses needs no config and is unchanged.
- New capabilities, upstreams or fixtures. No capability input/output schema, MCP tool or REST
  capability route is added or renamed, so there are no capability schemas or upstream calls to
  specify (see [Upstream calls and fixtures](#upstream-calls-and-fixtures)).
- Splitting dev and prod `vars`. `localhost`/`127.0.0.1` in `ALLOWED_HOSTS`/`ALLOWED_ORIGINS`
  stay: the deployed Worker's Host is always the workers.dev name, and the server is public,
  read-only and credential-free, so a local page reaching it cross-origin gains nothing.
- Usage events for MCP protocol traffic that is not a capability call (`initialize`,
  `tools/list`, `resources/read`), for `GET /api/v1/about`, or for MCP calls the SDK rejects
  before our callback runs (its input validation).
- The proposal's "args-shape" field. The issue's field list governs: no argument values or shapes.
- Dependabot, and SHA-pinning `ci.yml` (PR CI unchanged; it holds no secrets).
- A strict global rate limit (that needs a Durable Object; the stack rules out DOs).

## Design

### Decisions

| Question | Decision | Why |
|---|---|---|
| Where secrets live | GSM `cdsci-infra` is the source of truth. The Cloudflare token is copied into a GitHub **environment** secret; `GITHUB_TOKEN` is set as a Worker secret. No GCP access from CI | The issue comment and the standing rule: GSM is authoritative, runtimes get copies, apps read env vars. Workload Identity Federation from Actions would add GCP IAM setup and third-party actions for no gain in v0 |
| Deploy triggers | One `deploy.yml`: push to `main`, the daily schedule and `repository_dispatch: docs-updated` (moved from `docs-index.yml`, which is removed), and `workflow_dispatch` | Spec #3 deferred "the deploy step" to #11. The docs index is built in CI and bundled, so a rebuild that is not deployed never reaches users. Schedule and dispatch runs always use `main`, so "deploy from main only" holds |
| Environment protection | `production` environment, deployment branches: `main` only, no required reviewers | Restricts the token to `main` runs; reviewers would block merge-on-green and the daily rebuild |
| Action pinning | `deploy.yml` pins actions to the verified SHAs above; `ci.yml` keeps `@v7` | Spec #15 deferred this to #11. Only the deploy job sees a credential. No third-party action: `npx wrangler deploy` uses the lock-pinned wrangler |
| Rate-limit key | `rateLimitKey(cf-connecting-ip)`: the address, an IPv6 address by its /64, else `'unknown'`; one key per address shared by MCP and REST | The server is anonymous; the address is the only identity. Sharing stops doubling the budget by switching transport |
| Rate-limit value | 120 requests / 60 s per address per Cloudflare location, `namespace_id` `"1101"` | Generous for an agent session (tens of calls a minute) and for NATed institutions; `"1101"` avoids the docs example `"1001"` that `taxsea-online` uses (namespaces share counters account-wide) |
| Limiter failure | Fail open (log and serve) | Read-only public data; availability beats strictness |
| Usage sink | Workers Analytics Engine dataset `bioc_mcp_usage_v1` | Logpush is Enterprise-only. `_v1` because a dataset's schema is fixed at creation |
| Where usage is recorded | `invokeCapability` (the one place a capability runs), from a per-call context the transport passes; not in `Deps` | Keeps logic out of the transports; `Deps` stays "what capabilities need" (the docs-index build script and adapter tests construct `Deps` and need no sink) |
| Extra field `error_code` | Added to the issue's five fields | `ok: false` alone cannot tell bad input from an upstream outage, which is the first thing the metric is read for. It is a fixed enum, never input |
| Rate-limited requests in the usage log | Yes: one event, `capability: ''`, `error_code: 'rate_limited'` | Cloudflare does not show rate-limit binding outcomes anywhere; its docs recommend exactly this |
| Logs | `observability.enabled: true`, `logs.invocation_logs: false` | Keeps our `console.error` lines (persisted, queryable) without per-request metadata (URLs with REST query values, client data) |

### Files

```
wrangler.jsonc                       workers_dev, preview_urls, observability, secrets, ratelimits,
                                     analytics_engine_datasets (below)
worker-configuration.d.ts            regenerated: npm run cf-typegen
src/usage.ts                         NEW  Transport, UsageEvent, UsageSink, createAnalyticsEngineSink(),
                                          createMemoryUsageSink()
src/rate-limit.ts                    NEW  RateLimiter, RATE_LIMIT_PERIOD_SECONDS, rateLimitMiddleware()
src/core/invoke.ts                   InvokeContext; invokeCapability(…, context); runCapability() (private)
src/transports/mcp.ts                McpAppOptions.usage; buildMcpServer(all, selected, deps, usage)
src/transports/rest.ts               RestAppOptions.usage; 429 in every route's responses
src/index.ts                         createApp options usage + rateLimiter; middleware; Worker entry
                                     uses Env, the AE sink and env.RATE_LIMITER; WorkerEnv removed
.github/workflows/docs-index.yml     git mv → .github/workflows/deploy.yml, then edited (below)
docs/deploy.md                       NEW  runbook
AGENTS.md                            Layout, Rules, Commands lines (below)
README.md                            status line (below)
test/support/app.ts                  makeTestApp: usage sink + rateLimiter option; returns usage
test/usage.test.ts                   NEW
test/rate-limit.test.ts              NEW
test/core/invoke.test.ts             4th argument; new usage cases
test/core/pkg/status.test.ts         4th argument at both invokeCapability calls
test/transports/usage.test.ts        NEW  events per transport
test/transports/rest.test.ts         OpenAPI 429 assertion
```

`.github/workflows/ci.yml`, `src/core/deps.ts`, `scripts/` and the upstream adapters do not change.

### `wrangler.jsonc`

Exactly (comments included):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "bioc-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  // Deployed only at https://bioc-mcp.seandavi.workers.dev; no zone routes, no per-version preview URLs.
  "workers_dev": true,
  "preview_urls": false,
  // Our console.error lines are kept; per-request invocation logs (URL, headers) are not.
  "observability": { "enabled": true, "logs": { "invocation_logs": false } },
  // Set from GCP Secret Manager (cdsci-bioc-mcp-github-token); see docs/deploy.md. Deploys fail without it.
  "secrets": { "required": ["GITHUB_TOKEN"] },
  "ratelimits": [
    // Per client address, per Cloudflare location, approximate. period must equal
    // RATE_LIMIT_PERIOD_SECONDS in src/rate-limit.ts. namespace_id is account-wide: do not reuse.
    { "name": "RATE_LIMITER", "namespace_id": "1101", "simple": { "limit": 120, "period": 60 } }
  ],
  // A dataset's schema is fixed at creation: changing the data point layout in src/usage.ts
  // means a new dataset name (_v2), never an edit to this one.
  "analytics_engine_datasets": [{ "binding": "USAGE", "dataset": "bioc_mcp_usage_v1" }],
  "vars": {
    // (unchanged comment and values)
    "ALLOWED_HOSTS": "bioc-mcp.seandavi.workers.dev,localhost,127.0.0.1",
    "ALLOWED_ORIGINS": "bioc-mcp.seandavi.workers.dev,localhost,127.0.0.1"
  }
}
```

`compatibility_date` stays `2026-10-01` (the date the runtime types were generated for). Then run
`npm run cf-typegen` and commit `worker-configuration.d.ts`.

### `src/usage.ts`

```ts
import type { ErrorCode } from './errors';

export type Transport = 'mcp' | 'rest';

/** One capability call, or one rate-limited request. Never carries argument values or client data. */
export interface UsageEvent {
  transport: Transport;
  capability: string; // tool name, e.g. 'pkg_status'; '' for a rate-limited request
  latency_ms: number; // deps.now() at the end minus at the start of invokeCapability
  upstream_status: number; // highest non-3xx upstream HTTP status seen in the call; 0 = none
  ok: boolean;
  error_code: ErrorCode | 'rate_limited' | null; // null when ok
}

export interface UsageSink {
  record(event: UsageEvent): void; // never throws
}

/**
 * Workers Analytics Engine. The data point layout is the dataset's schema (see wrangler.jsonc):
 * index1 = transport; blob1 = transport, blob2 = capability, blob3 = error_code ('' when ok);
 * double1 = latency_ms, double2 = upstream_status, double3 = ok (1 or 0). Append only.
 */
export function createAnalyticsEngineSink(dataset: Pick<AnalyticsEngineDataset, 'writeDataPoint'>): UsageSink;

/** Collects events in memory; for tests and Node. */
export function createMemoryUsageSink(): UsageSink & { events: UsageEvent[] };
```

`createAnalyticsEngineSink(dataset).record(event)` calls exactly

```ts
dataset.writeDataPoint({
  indexes: [event.transport],
  blobs: [event.transport, event.capability, event.error_code ?? ''],
  doubles: [event.latency_ms, event.upstream_status, event.ok ? 1 : 0],
});
```

inside `try`; on a throw it calls `console.error('usage', error)` and returns. The index is the
transport (always non-empty, at most 96 bytes). `createMemoryUsageSink` pushes each event onto
`events`.

### `src/rate-limit.ts`

```ts
import type { MiddlewareHandler } from 'hono';
import type { Transport, UsageSink } from './usage';

/** The Workers rate-limit binding's shape (env.RATE_LIMITER satisfies it). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Must equal simple.period of RATE_LIMITER in wrangler.jsonc. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * The limiter key for a client address. An IPv6 client usually holds a whole /64, so an IPv6
 * address counts by its /64 prefix ("2001:db8:1:2::/64"); an IPv4-embedded IPv6 address
 * ("::ffff:203.0.113.9") by its IPv4 part; anything else, including text that does not parse,
 * as is. No address: 'unknown'.
 */
export function rateLimitKey(address: string | undefined): string;

/** One limiter key per client address (an IPv6 /64 counts as one; rateLimitKey), else 'unknown'. Fails open. */
export function rateLimitMiddleware(limiter: RateLimiter, usage: UsageSink, transport: Transport): MiddlewareHandler;
```

Behaviour, in order:

1. `key = rateLimitKey(c.req.header('cf-connecting-ip'))`.
2. `({ success } = await limiter.limit({ key }))` in `try`. If `limit` throws or rejects:
   `console.error('rate-limit', error)` and treat as `success = true`.
3. Allowed: `await next()` and return.
4. Refused: `usage.record({ transport, capability: '', latency_ms: 0, upstream_status: 0, ok: false, error_code: 'rate_limited' })`,
   set header `retry-after: 60` (`String(RATE_LIMIT_PERIOD_SECONDS)`), and return
   `c.json({ error: { code: 'rate_limited', message } }, 429)` with `message` exactly
   `` `Too many requests from this address. Wait ${RATE_LIMIT_PERIOD_SECONDS} seconds and try again.` ``

The body matches `ErrorBodySchema`. The address never appears in a response, log or event.

### `src/core/invoke.ts`

```ts
export interface InvokeContext {
  transport: Transport;
  usage: UsageSink;
}

/** The one place a capability runs; both transports call only this. Records one usage event. */
export async function invokeCapability(
  capability: Capability,
  rawInput: unknown,
  deps: Deps,
  context: InvokeContext,
): Promise<InvokeResult>;
```

Move today's body unchanged into a private `async function runCapability(capability, rawInput, deps): Promise<InvokeResult>`.
`invokeCapability` then:

```ts
const startedAt = deps.now().getTime();
let upstreamStatus = 0;
// Wraps fetch for this call only, so upstream_status needs nothing from adapters or fetchUpstream.
const traced: Deps = {
  ...deps,
  fetch: async (request) => {
    const response = await deps.fetch(request);
    if (response.status < 300 || response.status > 399) upstreamStatus = Math.max(upstreamStatus, response.status);
    return response;
  },
};
const result = await runCapability(capability, rawInput, traced);
context.usage.record({
  transport: context.transport,
  capability: capability.name,
  latency_ms: deps.now().getTime() - startedAt,
  upstream_status: upstreamStatus,
  ok: result.ok,
  error_code: result.ok ? null : result.error.code,
});
return result;
```

Consequences, all intended: a cache hit, a network error or a timeout gives `upstream_status: 0`;
redirect hops (3xx) are ignored and the followed response counts; with two upstreams (as in
`pkg_status`) the worse status wins. REST input that fails the schema records `invalid_input`;
the MCP equivalent is rejected by the SDK first and records nothing (see Non-goals).

### Transports

- `src/transports/mcp.ts`: `McpAppOptions` gains `usage: UsageSink`; `createMcpApp({ modules, deps, usage, config })`;
  `buildMcpServer(all, selected, deps, usage)`; the tool callback calls
  `invokeCapability(capability, args, deps, { transport: 'mcp', usage })`. Nothing else changes.
- `src/transports/rest.ts`: `RestAppOptions` gains `usage: UsageSink`; `createRestApp({ modules, deps, usage })`;
  the handler calls `invokeCapability(capability, input, deps, { transport: 'rest', usage })`.
  Every capability route and the `/api/v1/about` route add
  `429: json(ErrorBodySchema, 'Too many requests from this client address; wait Retry-After seconds')`.

### `src/index.ts`

```ts
export function createApp(options: {
  config: AppConfig;
  deps: Deps;
  usage: UsageSink;
  rateLimiter: RateLimiter;
  modules?: readonly Module[];
}): Hono;
```

Right after `const app = new Hono();` and before any `app.route`:

```ts
app.use('/mcp/*', rateLimitMiddleware(options.rateLimiter, options.usage, 'mcp'));
app.use('/api/*', rateLimitMiddleware(options.rateLimiter, options.usage, 'rest'));
```

Pass `usage: options.usage` to `createMcpApp` and `createRestApp`. Delete `interface WorkerEnv`;
the entry becomes `satisfies ExportedHandler<Env>` and builds:

```ts
app ??= createApp({
  config: parseConfig(env),
  deps: {
    fetch: (r) => fetch(r), // wrapper: never store the bare global fetch on an object
    cache: createCloudflareCache(caches.default),
    now: () => new Date(),
    env: { GITHUB_TOKEN: env.GITHUB_TOKEN },
  },
  usage: createAnalyticsEngineSink(env.USAGE),
  rateLimiter: env.RATE_LIMITER,
});
```

The rate-limited paths are exactly `/mcp`, `/mcp/…`, `/api` and `/api/…` (including
`/api/openapi.json`). Unknown paths reach `notFound` without consuming budget.

### `.github/workflows/deploy.yml`

`git mv .github/workflows/docs-index.yml .github/workflows/deploy.yml`, then make it exactly:

```yaml
name: Deploy
# Deploys only from main: pushes, the daily docs-index rebuild, the docs site's dispatch, or by hand.
# The production environment is restricted to main and holds CLOUDFLARE_API_TOKEN (copied from
# GCP Secret Manager; see docs/deploy.md). Pull requests run ci.yml, which has no secrets.
on:
  push:
    branches: [main]
  schedule:
    - cron: '23 6 * * *'
  repository_dispatch:
    types: [docs-updated]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://bioc-mcp.seandavi.workers.dev
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run docs:build
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: docs-index
          path: generated/
          retention-days: 14
      - name: Deploy
        run: npx wrangler deploy --message "$DEPLOY_MESSAGE"
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          DEPLOY_MESSAGE: ${{ github.event_name }} ${{ github.sha }}
```

Only the last step receives the token. `cancel-in-progress: false` lets a running deploy finish
and keeps only the newest pending run.

### `docs/deploy.md` (new runbook)

Sections and their required content (prose is the implementer's; commands exactly as here):

1. **What runs where.** Table: `ci.yml` (pull requests and pushes to `main`; tests; no secrets); `deploy.yml`
   (triggers as above; environment `production`). Live URLs: `/mcp`, `/api/v1`,
   `/api/openapi.json` on `https://bioc-mcp.seandavi.workers.dev`.
2. **Secrets.** GSM project `cdsci-infra` is the source of truth; the copies are derived from it,
   never edited by hand. Table:

   | GSM secret | What | Copy lives in |
   |---|---|---|
   | `cdsci-bioc-mcp-cloudflare-deploy-token` | Cloudflare **Account** API token for the one account that owns `seandavi.workers.dev`, with exactly **Account › Workers Scripts: Edit** and **Account › Account Settings: Read**. Do not start from the "Edit Cloudflare Workers" template, or remove everything else it adds: Workers KV Storage, Workers R2 Storage, Workers Tail, and the zone-level Workers Routes (no routes are used), plus User Details and Memberships if offered | GitHub environment `production`, secret `CLOUDFLARE_API_TOKEN` |
   | `cdsci-bioc-mcp-github-token` | GitHub fine-grained token, "Public repositories (read-only)", no permissions; rate limit only | Worker secret `GITHUB_TOKEN` |
   | `cdsci-bioc-mcp-analytics-token` | Cloudflare Account API token with only **Account › Account Analytics: Read**, for the usage query (item 8). The deploy token does not have this permission and must not be given it | nowhere: exported in a local shell when querying; never in GitHub or the Worker |

   Every endpoint `wrangler deploy` uses here (script upload, versions, deployments, the
   workers.dev subdomain, the required-secrets check) accepts Workers Scripts: Edit; Account
   Settings: Read is kept from the template.

   Each GSM secret gets labels `repo=bioc-mcp`, `managed-by=manual` and annotations
   `consumed-by`, `scopes` and `rotated` (the convention already used in `cdsci-infra`). The
   account ID is not a secret: GitHub environment **variable** `CLOUDFLARE_ACCOUNT_ID` (find it
   with `npx wrangler whoami`).
3. **One-time setup** (human, once; one command per step):

   ```sh
   gh api -X PUT repos/seandavi/bioc-mcp/environments/production \
     --input - <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
   gh api -X POST repos/seandavi/bioc-mcp/environments/production/deployment-branch-policies -f name=main -f type=branch
   gcloud secrets versions access latest --secret=cdsci-bioc-mcp-cloudflare-deploy-token --project=cdsci-infra \
     | gh secret set CLOUDFLARE_API_TOKEN --env production -R seandavi/bioc-mcp
   gh variable set CLOUDFLARE_ACCOUNT_ID --env production -R seandavi/bioc-mcp --body <account-id>
   ```

4. **First deploy** (by hand, because the Worker does not exist yet and `GITHUB_TOKEN` is
   required). From a clean checkout of `main`, with `CLOUDFLARE_API_TOKEN` exported from GSM
   (`cdsci-bioc-mcp-cloudflare-deploy-token`) and `CLOUDFLARE_ACCOUNT_ID` (from
   `npx wrangler whoami`):

   ```sh
   npm ci && npm run docs:build && npm test
   npx wrangler deploy --secrets-file <(printf 'GITHUB_TOKEN=%s\n' "$(gcloud secrets versions access latest --secret=cdsci-bioc-mcp-github-token --project=cdsci-infra)")
   ```

   After that, every deploy runs from `deploy.yml`.
5. **Rotating.** Add a GSM version, then re-run the matching copy command:
   the `gh secret set` line above, or
   `gcloud secrets versions access latest --secret=cdsci-bioc-mcp-github-token --project=cdsci-infra | npx wrangler secret put GITHUB_TOKEN`.
   Revoke the old token after the next successful run.
6. **Docs rebuild receiver.** `deploy.yml` listens for `repository_dispatch` type `docs-updated`
   and for `workflow_dispatch`; either rebuilds the docs index from the live site and deploys.
   The sender (bioc-infrastructure's docs deploy; a follow-up issue there) can use either:
   - `gh api -X POST repos/seandavi/bioc-mcp/dispatches -f event_type=docs-updated`: the token
     needs **Contents: write** on bioc-mcp, which also allows pushing code.
   - `gh api -X POST repos/seandavi/bioc-mcp/actions/workflows/deploy.yml/dispatches -f ref=main`:
     the token needs only **Actions: write**. **Recommended.** A dispatch on another ref cannot
     deploy, because `production` only admits `main`.

   The token lives in GSM as `cdsci-bioc-mcp-dispatch-token` and is copied into
   bioc-infrastructure's Actions secrets. The daily schedule covers any missed dispatch.
7. **Rate limits.** 120 requests per 60 s per client address per Cloudflare location,
   approximate (Workers rate-limit binding). An IPv6 address counts by its /64 prefix, since one
   client usually holds the whole /64. The response: 429, `Retry-After: 60`, `rate_limited`
   body. Change the limit in `wrangler.jsonc`, the period in both `wrangler.jsonc` and
   `RATE_LIMIT_PERIOD_SECONDS`.
8. **Usage metric.** Dataset `bioc_mcp_usage_v1`; the column layout from `src/usage.ts`; no
   argument values, no addresses; 3-month retention; ingestion lags about a minute; always weight
   by `_sample_interval`. The query uses its own token, `cdsci-bioc-mcp-analytics-token` (item 2),
   not the deploy token:

   ```sh
   export CLOUDFLARE_ANALYTICS_TOKEN=$(gcloud secrets versions access latest --secret=cdsci-bioc-mcp-analytics-token --project=cdsci-infra)
   curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
     -H "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
     --data "SELECT blob2 AS capability, blob1 AS transport, sum(_sample_interval) AS calls, sum(_sample_interval * double3) AS ok_calls, sum(_sample_interval * double1) / sum(_sample_interval) AS mean_latency_ms FROM bioc_mcp_usage_v1 WHERE timestamp > now() - INTERVAL '7' DAY GROUP BY capability, transport ORDER BY calls DESC"
   ```

   Rate-limited requests are the rows with `blob3 = 'rate_limited'`.
9. **Logs and rollback.** `npx wrangler tail` for live logs; the dashboard's Workers Logs keep our
   `console.error` lines (invocation logs are off). `npx wrangler deployments list` and
   `npx wrangler rollback [version-id]` to roll back.

### AGENTS.md

- Layout: add `usage.ts           usage events → Analytics Engine (the usage metric)` and
  `rate-limit.ts      per-address rate limit on /mcp and /api` after `envelope.ts`; add
  `docs/deploy.md      deploy runbook: secrets, first deploy, dispatch, usage queries` under the tree.
- Rules: replace the last bullet with
  `- CI on pull_request runs tests only and never sees secrets. The Deploy workflow runs only from
  main (push, the daily docs rebuild, the docs-updated dispatch, by hand) in the production
  environment. Secrets live in GCP Secret Manager (cdsci-infra); GitHub and Cloudflare hold copies
  (docs/deploy.md).`
- Rules, new bullet after "No tool returns…":
  `- Usage events carry no argument values and no client addresses; the Analytics Engine layout in
  src/usage.ts is append-only, and a layout change needs a new dataset name.`
- Commands: add `- Deploying: see docs/deploy.md. Never run wrangler deploy from a branch.`

### README.md

Replace the first sentence of the status note, "Nothing is deployed yet.", with:
"Deploys from `main` to `https://bioc-mcp.seandavi.workers.dev/mcp` (REST: `/api/v1`); expect
breaking changes." Keep the rest of the note.

### Upstream calls and fixtures

None. No upstream, adapter or fixture is added. New tests use the existing synthetic `example`
upstream (`https://upstream.test/items/alpha.json`, `test/fixtures/example/items/alpha.json`) and
`fixtureFetch` routes (`{ status: 404 }`, `{ status: 302, headers: { location } }`, `'timeout'`).

## Acceptance criteria

Automated (in the PR):

- [ ] `npm ci && npm run typecheck && npm test` pass; `npm run build` (no credentials) lists
      `env.USAGE (bioc_mcp_usage_v1)` and `env.RATE_LIMITER (120 requests/60s)`.
- [ ] `wrangler.jsonc` matches this spec; `worker-configuration.d.ts` is regenerated and declares
      `USAGE: AnalyticsEngineDataset`, `RATE_LIMITER: RateLimit`, `GITHUB_TOKEN: string`.
- [ ] `grep -n WorkerEnv src` returns nothing; the entry `satisfies ExportedHandler<Env>`.
- [ ] **Rate limit:** with a limiter returning `{ success: false }`, `POST /mcp`, `POST /mcp/example`,
      `GET /api/v1/meta/ping` and `GET /api/openapi.json` return 429, `retry-after: 60` and exactly
      `{ error: { code: 'rate_limited', message: 'Too many requests from this address. Wait 60 seconds and try again.' } }`;
      `GET /` and `GET /mcpx` stay 404 and never call the limiter.
- [ ] The limiter key is the `cf-connecting-ip` value (an IPv6 address by its /64), else `'unknown'`; the same key is used on
      MCP and REST; a limiter that rejects lets the request through and logs `rate-limit`.
- [ ] A 429 records one event `{ transport, capability: '', latency_ms: 0, upstream_status: 0, ok: false, error_code: 'rate_limited' }`
      with `transport` `'mcp'` or `'rest'` by path.
- [ ] **Usage:** one event per `invokeCapability` call with keys exactly
      `transport, capability, latency_ms, upstream_status, ok, error_code`; REST calls record
      `'rest'`, MCP `tools/call` records `'mcp'`; `tools/list`, `resources/read`,
      `GET /api/v1/about` and an SDK-rejected MCP call record nothing.
- [ ] `upstream_status`: 200 after a fetched 200; 0 on a cache hit; 404 with `error_code: 'not_found'`;
      0 with `upstream_timeout` on a timeout; 200 (not 302) after a followed redirect; 0 for
      `invalid_input`.
- [ ] `latency_ms` equals the clock advance during the handler (250 when the handler moves the
      test clock by 250 ms).
- [ ] No event contains an input value (`JSON.stringify(events)` lacks `alpha` and `trackViewer`).
- [ ] `createAnalyticsEngineSink` writes exactly
      `{ indexes: ['rest'], blobs: ['rest', 'example_item', ''], doubles: [12, 200, 1] }` for an ok
      event, `blobs[2] === 'not_found'` and `doubles[2] === 0` for a failed one, and swallows a
      throwing `writeDataPoint` (logs `usage`).
- [ ] The OpenAPI document lists a 429 response for `/api/v1/meta/ping` and `/api/v1/about`.
- [ ] `.github/workflows/docs-index.yml` is gone (moved with `git mv`); `deploy.yml` matches this
      spec; `ci.yml` is unchanged (`git diff main -- .github/workflows/ci.yml` is empty).
- [ ] `docs/deploy.md` has the nine sections; AGENTS.md and README carry the lines above.

### Needs a human

These follow the merge and are verified by hand (the PR stops at green CI):

- [ ] GSM secrets `cdsci-bioc-mcp-cloudflare-deploy-token` and `cdsci-bioc-mcp-github-token`
      exist with labels and annotations; the `production` environment admits only `main`, with
      `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set.
- [ ] The first deploy (docs/deploy.md §4) succeeds, then a `workflow_dispatch` run of Deploy
      succeeds.
- [ ] `curl -s https://bioc-mcp.seandavi.workers.dev/api/v1/meta/ping` returns the envelope; the
      AGENTS.md MCP `curl` against `/mcp` lists the tools; the server works from Claude Code over
      the remote URL.
- [ ] 125 rapid requests to `/api/v1/meta/ping` from one address end in 429s.
- [ ] Two identical `pkg_status` calls a few seconds apart: the second is served from the cache
      (Cache API works on workers.dev; check that `sources[].as_of` is unchanged where it falls back to fetch time, or
      `wrangler tail` shows no second upstream fetch).
- [ ] The usage query in docs/deploy.md §8 returns rows for those calls about a minute later.

## Test plan

All Vitest in Node, no network, existing helpers (`fixtureFetch`, `makeTestApp`, `appFetch`,
`connectClient`).

| File | Cases |
|---|---|
| `test/support/app.ts` | `makeTestApp` options gain `rateLimiter?: RateLimiter` (default `{ limit: async () => ({ success: true }) }`); it creates `usage = createMemoryUsageSink()`, passes `usage` and `rateLimiter` to `createApp`, and returns `{ app, fetch, cache, usage }` |
| `test/usage.test.ts` (new) | AE sink layout for ok and failed events (exact objects above); a `writeDataPoint` that throws is swallowed and `console.error` is called with `('usage', error)` (spy, restored in `afterEach`); memory sink collects in order |
| `test/rate-limit.test.ts` (new) | Through `makeTestApp({ rateLimiter })`: `test.each` over the four limited routes → 429, `retry-after: 60`, exact body; `GET /` and `GET /mcpx` → 404 with the limiter spy not called; key from `cf-connecting-ip: 203.0.113.9` on both an MCP and a REST request, and `'unknown'` without the header; the 429 usage event per transport; a rejecting limiter → 200 from `/api/v1/meta/ping` and `console.error('rate-limit', error)`; an allowing limiter → normal 200 |
| `test/core/invoke.test.ts` | Existing calls pass `{ transport: 'rest', usage }` (memory sink). New: one event per call with the exact key set; `latency_ms` 250 via a mutable clock the handler advances; `error_code` `internal` and `invalid_input` cases with `upstream_status` 0; a handler calling `fetchUpstream` on the example upstream via `fixtureFetch`: 200, 404 (`not_found`), timeout (`upstream_timeout`, 0), `302 → 200` (200), and a second call through the same memory cache (0) |
| `test/core/pkg/status.test.ts` | Both `invokeCapability` calls pass `{ transport: 'rest', usage: createMemoryUsageSink() }`; one new assertion that the trackViewer call records `upstream_status: 200`, `ok: true`, and that the serialized events lack `trackViewer` |
| `test/transports/usage.test.ts` (new) | REST `GET /api/v1/example/item?id=alpha` → one `'rest'` event; MCP `listTools`, `readResource('bioc://about')`, `callTool example_item {id:'alpha'}`, `callTool example_item {id:'Bad Id'}` → exactly one `'mcp'` event (the valid call); `GET /api/v1/about` → none; no event string contains `alpha` |
| `test/transports/rest.test.ts` | The OpenAPI test asserts `paths['/api/v1/meta/ping'].get.responses['429']` and the same for `/api/v1/about` |

Manual, before opening the PR: `npm run dev`, then 125 requests to
`http://127.0.0.1:8787/api/v1/meta/ping` (`for i in $(seq 1 125); do curl -s -o /dev/null -w "%{http_code}\n" …; done | sort | uniq -c`
shows `120 200` and `5 429`), and the AGENTS.md MCP `curl`. Paste the output in the PR.

## Risks

- **Cache API on workers.dev: verified 2026-10-23.** Two identical `ops_activity?kind=failures`
  calls 3 s apart returned the same `as_of`; production has no in-memory layer, so `caches.default`
  served the second. The cache is per data centre, so many locations still multiply upstream load.
- **Rate limits are approximate and per location**, keyed by address: NATed users share a budget,
  a distributed client is barely limited. IPv6 clients are keyed by /64 (#26 security-r0-1), so
  rotating addresses inside one /64 does not reset the budget; a client with many /64s or many
  IPv4 addresses still can. Acceptable for a public read-only server; the 429 rows
  in the usage data show whether 120/min is wrong.
- **The first deploy is manual** because `secrets.required` blocks a CI deploy until the Worker
  and its secret exist. That is the intended fail-closed behaviour; docs/deploy.md §4 covers it.
- **A docs-site outage blocks deploys.** `npm run docs:build` fails on any upstream error, so a
  code merge cannot deploy while the docs site is down. Re-run the workflow later; deploying with
  fixture docs would silently ship a stale index.
- **Latency is I/O time.** Workers freeze `Date` during CPU work, so `latency_ms` measures waiting
  on upstreams and cache, not CPU. It is still the number that matters for upstream health.
- **Usage gaps:** MCP calls rejected by the SDK's input validation are not counted; REST ones are.
- **`RATE_LIMIT_PERIOD_SECONDS` duplicates `simple.period`.** Nothing enforces equality besides
  the comments in both places; no JSONC parser is installed, and adding one only for this is not
  worth it.
- **Pinned action SHAs go stale** without Dependabot. Only `deploy.yml` is pinned; bump by hand
  with the verified-SHA method above when upgrading.
- **`npm ci` runs in the job that holds the deploy token.** A compromised dependency could reach
  it during the deploy step. The lockfile and least-privilege token (Workers Scripts: Edit and
  Account Settings: Read on one account; no KV, R2, Pages or zone permissions) bound the damage;
  rotate via GSM if in doubt.
- **The dispatch token** in bioc-infrastructure: if the sender uses `repository_dispatch` it needs
  Contents: write on this repo, i.e. push access. docs/deploy.md recommends `workflow_dispatch`
  (Actions: write) instead; the receiver accepts both.
