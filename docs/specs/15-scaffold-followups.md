# Spec #15: Scaffold follow-ups from the #2 review

Issue: [seandavi/bioc-mcp#15](https://github.com/seandavi/bioc-mcp/issues/15) (the body plus two
comments: 15 findings in all). Builds on [Spec #2](2-scaffold.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

The following was checked on 2026-10-22 against the installed packages (zod 4.6.7,
`@modelcontextprotocol/server` 2.3.1, `@hono/zod-openapi` 1.6.3, `actions/checkout` v7) with
throwaway scripts outside the repo. **Verified** marks what those scripts showed:

- **Verified:** the SDK's `tools/call` handler runs `validateToolInput`, which returns the parsed
  value (`result.value` from the schema's `~standard.validate`), and hands *that* value to our
  callback. `invokeCapability` then parses it again. Input is parsed twice on MCP (code-3).
- **Verified:** an MCP input-validation failure comes back as the `isError` text
  `Input validation error: Invalid arguments for tool example_item: id: Invalid string: must match pattern /^[a-z0-9-]+$/`
  (ux-1).
- **Verified:** a `Response` whose body stream errors with the request signal's reason makes
  `response.text()` reject with a `TimeoutError`. Today `fetchUpstream` reports that as
  `upstream_error` "Could not read the response from Example upstream" (code-6, reproduced).
- **Verified:** `api.doc31(path, { …, tags: [{ name, description }] })` puts `tags` at the top
  level of the generated document (ux-5).
- **Verified:** `actions/checkout@v7` has a `persist-credentials` input, default `true`
  (security-4).
- **Verified** (zod 4.6.7 `z.toJSONSchema`, per field of an input object): `.default(v)` puts the
  same `default` on both the `io: 'input'` and `io: 'output'` side. `.prefault(v)` puts `default`
  only on the input side. `.catch()`, `.trim()`, `.toLowerCase()`, `z.coerce.number()`,
  `.regex()` and `.describe()` give identical input and output schemas. `.transform()` makes
  `io: 'output'` throw "Transforms cannot be represented in JSON Schema". `.pipe(z.coerce.number())`
  on a string, and `z.stringbool()`, are `string` on input and `number`/`boolean` on output. At
  object level, `io: 'output'` adds `additionalProperties: false` and puts defaulted fields in
  `required`. That is why the check below compares per field and not whole objects.

## Goal

Close every checkbox on #15 in one PR, so the upstream seam and the transports are correct and
documented before the first real adapter (#6) copies them:

| Id | What changes |
|---|---|
| code-1 | `test/core/invoke.test.ts` covers the non-`CapabilityError` throw and output-schema mismatch paths |
| code-3 | Rule: input schemas must accept their own output. Enforced by `validateRegistry`, documented in AGENTS.md and the spec |
| code-4 | `AppConfig` and `parseConfig` move to `src/config.ts`; the MCP transport no longer imports the entry module |
| code-5 | Duplicate-upstream detection compares the known fields, not `JSON.stringify` |
| code-6 | A timeout while reading the body is `upstream_timeout` |
| ux-1 | The SDK's MCP input-error prefix is documented in a comment and the spec, and asserted in the test |
| ux-2 | `meta_ping` description and MCP server instructions stop saying `bioc://about` reports freshness |
| ux-3 | Transient upstream failures say what to do next and include the URL |
| ux-4 | `result_too_large` explains what to do when there is nothing to narrow |
| ux-5 | The OpenAPI document has a top-level `tags` array (one per module) |
| ux-6 | README gets a "Try it locally" section |
| security-4 | CI checkout uses `persist-credentials: false` |
| security-seam-3 | A test shows exactly 3 redirects succeed |
| security-seam-4 | `docs/specs/2-scaffold.md` matches the hardened seam (and the other changes here) |
| security-2-rest | Upstream validation rejects credentials in `baseUrl` and non-positive or non-finite `ttlSeconds`/`timeoutMs` |

## Non-goals

- No new capability, module, upstream or recorded fixture. No REST route or MCP tool is added or
  renamed, so this issue has no capability schemas or upstream calls to specify (see "Upstream
  calls and fixtures").
- MCP input errors keep the SDK's wording. We do not drop `inputSchema` or re-validate to get
  `invalid_input:`, because `tools/list` needs the schema.
- `bioc://about` gets no freshness data. The proposal wants it eventually (the docs index build
  time, #3), but #15 only corrects the wording.
- No SHA pinning of GitHub Actions and no Dependabot config (see security-4).
- No retry advice on 4xx responses other than 404, on redirect violations or on invalid JSON.
  Those are not transient.
- The idempotence check catches type-changing transforms. It cannot see value-rewriting
  `.overwrite(fn)` or `z.preprocess(fn, …)`. Those must be idempotent by construction; the rule
  text says so.

## Design

### Files

```
src/config.ts                  NEW: AppConfig, parseConfig() (moved from src/index.ts)
src/index.ts                   imports parseConfig/AppConfig from './config'; no re-export
src/transports/mcp.ts          AppConfig from '../config'; instructions reworded; SDK-prefix comment
src/transports/rest.ts         doc31(..., tags)
src/core/capability.ts         comment on `input` states the idempotence rule
src/core/registry.ts           sameUpstream(), assertIdempotentInput(), jsonEqual(); assertUpstream
src/core/meta/ping.ts          description reworded
src/upstreams/http.ts          assertBaseUrl → assertUpstream (+ credentials, ttl, timeout rules);
                               isTimeout(); body-read timeout; retry hints
src/envelope.ts                result_too_large message
.github/workflows/ci.yml       persist-credentials: false
README.md                      "Try it locally"
AGENTS.md                      one Rules bullet (idempotent input)
docs/specs/2-scaffold.md       brought up to date (list below)
test/core/invoke.test.ts       NEW
test/core/registry.test.ts     new cases
test/upstreams/http.test.ts    new and updated cases
test/transports/mcp.test.ts    input-error prefix assertion
test/transports/rest.test.ts   OpenAPI tags assertion
test/envelope.test.ts          message update
test/config.test.ts            import from '../src/config'
```

### code-4: `src/config.ts`

Move `AppConfig`, the private `splitList` and `parseConfig` from `src/index.ts` unchanged:

```ts
export interface AppConfig {
  allowedHosts: string[];
  allowedOrigins: string[];
}
/** Splits on ',', trims, drops empties. Throws if ALLOWED_HOSTS yields no hosts (fail closed). */
export function parseConfig(env: { ALLOWED_HOSTS?: string; ALLOWED_ORIGINS?: string }): AppConfig;
```

`src/index.ts`: `import { parseConfig, type AppConfig } from './config';`. Do not re-export them;
there is one import path per concept. `src/transports/mcp.ts`:
`import type { AppConfig } from '../config';`. `test/config.test.ts`:
`import { parseConfig } from '../src/config';`. Afterwards no file under `src/transports/` or
`src/core/` imports `../index`.

### security-2-rest: `assertBaseUrl` becomes `assertUpstream`

The function now validates the whole `Upstream`, so rename it to `assertUpstream` in
`src/upstreams/http.ts`. Update its two callers (`validateRegistry`, `fetchUpstream`). Keep the
existing comment and add the new rules to it. Rules, checked in this order; the first violation
throws `Error`:

| # | Rule | Message (exact) |
|---|---|---|
| 1 | `new URL(baseUrl)` parses | `Upstream "<id>" baseUrl "<baseUrl>" is not an absolute URL` (unchanged) |
| 2 | `url.protocol === 'https:'` | `… must use https:` (unchanged) |
| 3 | `url.username === '' && url.password === ''` | `Upstream "<id>" baseUrl must not include credentials` |
| 4 | `url.pathname.endsWith('/')` | `… must end with "/"` (unchanged) |
| 5 | `url.search === '' && url.hash === ''` | `… must not have a query string or fragment` (unchanged) |
| 6 | `Number.isInteger(ttlSeconds) && ttlSeconds > 0` | `Upstream "<id>" ttlSeconds must be a positive integer (got <ttlSeconds>)` |
| 7 | `timeoutMs === undefined \|\| (Number.isFinite(timeoutMs) && timeoutMs > 0)` | `Upstream "<id>" timeoutMs must be a positive finite number (got <timeoutMs>)` |

"…" is the existing `Upstream "<id>" baseUrl "<baseUrl>"` label. Two of these deliberately go
beyond the issue text:

- **Rule 3's message leaves out the URL.** `fetchUpstream` turns a failed `assertUpstream` into
  `CapabilityError('internal', message)`, and that text reaches MCP and REST clients. Echoing a
  URL with a password would leak it.
- **`ttlSeconds` must be an integer, not just positive and finite.** `AboutSchema` declares
  `ttl_seconds: z.number().int()`, and `cache-control: max-age` takes an integer. A fractional TTL
  would put out an `about` document that fails its own schema.

`fetchUpstream` already calls this on every fetch. Keep that.

### code-5: explicit upstream comparison (`src/core/registry.ts`)

```ts
// Record<keyof Upstream, true> makes tsc fail when Upstream gains a field this list lacks.
const UPSTREAM_FIELDS: Record<keyof Upstream, true> = {
  id: true, name: true, baseUrl: true, ttlSeconds: true, timeoutMs: true, description: true,
};

function sameUpstream(a: Upstream, b: Upstream): boolean {
  return (Object.keys(UPSTREAM_FIELDS) as (keyof Upstream)[]).every((field) => a[field] === b[field]);
}
```

In `validateRegistry`, replace `JSON.stringify(seen) !== JSON.stringify(upstream)` with
`!sameUpstream(seen, upstream)`. The error message stays the same.

### code-3: idempotent input (`src/core/registry.ts`)

**Rule:** a capability's input schema must accept its own output. MCP parses input twice: the
SDK validates the arguments and passes the parsed value on, then `invokeCapability` parses it
again. REST parses once. So a `.transform()`, or a `.pipe()` to another type, would pass on REST
and fail on MCP. Transform in the handler instead.

Add the private helpers and call `assertIdempotentInput(capability, label)` in `validateRegistry`
right after `assertRestCompatible(capability, label)`:

```ts
/** Structural equality for JSON values; object key order does not matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}

/** `default` differs legitimately between io sides (.prefault sets it on input only). */
function withoutDefault(schema: unknown): unknown {
  const { default: _default, ...rest } = schema as Record<string, unknown>;
  return rest;
}

const IDEMPOTENT_RULE =
  'input schemas must accept their own output because MCP parses input twice (the SDK, then ' +
  'invokeCapability). Transform in the handler instead';

function assertIdempotentInput(capability: Capability, label: string): void {
  for (const [field, schema] of Object.entries(capability.input.shape)) {
    let output: unknown;
    try {
      output = z.toJSONSchema(schema, { io: 'output' });
    } catch {
      throw new Error(`${label} input field "${field}" has a transform; ${IDEMPOTENT_RULE}`);
    }
    const input = z.toJSONSchema(schema, { io: 'input' });
    if (!jsonEqual(withoutDefault(input), withoutDefault(output))) {
      throw new Error(`${label} input field "${field}" parses to a different type than it accepts; ${IDEMPOTENT_RULE}`);
    }
  }
}
```

The code above was compiled with this repo's strictness flags (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) against zod
4.6.7. It accepts `meta_ping`, `example_item`, defaults, optionals, enums, arrays, `.trim()`,
`.toLowerCase()`, `.prefault()`, `.catch()` and `z.coerce.number()`. It rejects `.transform()`
(first message), and `.pipe(z.coerce.number())` and `z.stringbool()` (second message).

Document the rule in three places:

- `src/core/capability.ts`, the `input` field comment:
  `input: I; // flat, REST-carriable, and accepts its own output (see validateRegistry)`.
- `AGENTS.md`, a new bullet in "Rules" after "One capability, two transports":
  `- Capability input schemas must accept their own output: MCP parses input twice (the SDK, then
  invokeCapability). No .transform(), no .pipe() to another type, no z.stringbool(); transform in
  the handler. validateRegistry rejects type-changing input; .overwrite() and z.preprocess() must
  be idempotent by construction.`
- `docs/specs/2-scaffold.md` (below).

### code-6 and ux-3: `fetchUpstream` errors (`src/upstreams/http.ts`)

Add a private helper and use it in both catches:

```ts
/** AbortSignal.timeout rejects fetch and body reads with TimeoutError (AbortError in some runtimes). */
function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}
```

Messages after the change. `<url>` is `url.href`, the requested URL (the same value as
`details.url`), not a redirect target. `RETRY` is the literal `Try again shortly.`:

| Case | Code | Message (exact) |
|---|---|---|
| fetch rejects, `isTimeout` | `upstream_timeout` | `<name> did not answer within <ms> ms (<url>). Try again shortly.` |
| fetch rejects, other | `upstream_error` | `Could not reach <name> (<url>). Try again shortly.` |
| status 404 | `not_found` | `<name> has nothing at <url>` (unchanged) |
| status ≥ 500 | `upstream_error` | `<name> returned HTTP <status> (<url>). Try again shortly.` |
| other non-2xx (4xx ≠ 404, 3xx without `Location`) | `upstream_error` | `<name> returned HTTP <status>` (unchanged) |
| `response.text()` rejects, `isTimeout` | `upstream_timeout` | same as the fetch timeout row |
| `response.text()` rejects, other | `upstream_error` | `Could not read the response from <name> (<url>). Try again shortly.` |
| redirect outside base / too many / bad JSON | `upstream_error` | unchanged |

The issue names timeouts and 5xx. The same hint goes on network failures and failed body reads,
because they are the same kind of failure: transient, where a retry is the right next step. The
other rows keep their messages, because retrying does not fix them. `details` is unchanged in
every row (the status row keeps `status`).

### ux-1: MCP input-error prefix

In `buildMcpServer`, add a comment above the `registerTool` callback:

```ts
// The SDK validates args against inputSchema before this callback runs. Its failures come back
// as isError text "Input validation error: Invalid arguments for tool <name>: …", not
// "invalid_input: …"; REST reports the same failure as 400 invalid_input.
```

### ux-2: freshness wording

- `src/core/meta/ping.ts` `description`, exact:
  `'Check that the Bioconductor MCP server is reachable and report its version. ' +
  'Use only as a connectivity check; read the bioc://about resource (REST: GET /api/v1/about) ' +
  'for the modules, tools and upstream sources the server covers and each source\'s cache TTL. ' +
  'Freshness is per result: every tool result lists its sources with an as_of time.'`
- `src/transports/mcp.ts` `instructions`, exact:
  `'Read-only access to public Bioconductor infrastructure data. Every tool result ' +
  'carries `sources` (URL and as_of, the freshness of that data); cite them. Read bioc://about ' +
  'for the modules, tools and upstream sources covered and their cache TTLs.'`
- The `bioc://about` resource description (`'Modules, tools, upstream sources and their cache TTLs.'`)
  is already accurate. Leave it.

### ux-4: `result_too_large` (`src/envelope.ts`)

Exact message:
`` `${tool} returned ${bytes} bytes; the limit is ${MAX_RESULT_BYTES}. If the tool takes a limit or filter, narrow the request; otherwise this is a server bug, please report it at https://github.com/seandavi/bioc-mcp/issues.` ``

### ux-5: OpenAPI tags (`src/transports/rest.ts`)

```ts
api.doc31('/api/openapi.json', {
  openapi: '3.1.0',
  info: { /* unchanged */ },
  tags: modules.map((module) => ({ name: module.name, description: module.description })),
});
```

Registry order. The `/api/v1/about` route keeps `tags: ['meta']`.

### ux-6: README "Try it locally"

Insert between "Principles" and "Contributing", exactly:

````markdown
## Try it locally

With Node ≥ 22.12:

```sh
npm ci
npm run dev
```

`npm run dev` serves the Worker at http://127.0.0.1:8787. Point an MCP client that speaks
Streamable HTTP at `http://127.0.0.1:8787/mcp` (or `/mcp/<module>` for one module), or call the
REST API: `curl http://127.0.0.1:8787/api/v1/meta/ping`. Today the only tool is `meta_ping`.
More commands are in [AGENTS.md](AGENTS.md#commands).
````

(`localhost` and `127.0.0.1` are already in `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` in
`wrangler.jsonc`, so the MCP Host check passes.)

### security-4: CI checkout

```yaml
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
```

**Decision: do not pin to SHAs.** The finding marks pinning optional. Both actions are
first-party (`actions/*`), the workflow has no secrets and `contents: read`, and without an
updater (Dependabot) SHA pins quietly go stale. Revisit when #11 adds deploy credentials or the
first third-party action.

### security-seam-4 (and the rest): update `docs/specs/2-scaffold.md`

Change these sections so the #2 spec matches the code after this PR:

1. **Files:** add `src/config.ts  AppConfig, parseConfig()`; `src/index.ts` becomes
   `createApp(), Worker default export`; `upstreams/http.ts` lists `pathSegment(), assertUpstream()`.
   Add `test/core/invoke.test.ts`, `test/config.test.ts`, `test/support/leaky-module.ts`.
2. **`src/envelope.ts`:** the `assertEnvelopeSize` doc comment gets the new message.
3. **`src/upstreams/http.ts` interface block:** `baseUrl` comment becomes
   `// https:, no credentials, ends with '/', no query/fragment`. `ttlSeconds` becomes
   `// positive integer; cache TTL for 200 responses`. `timeoutMs` becomes
   `// positive; default DEFAULT_TIMEOUT_MS`. Add the `pathSegment(value: string): string` and
   `assertUpstream(upstream: Upstream): void` signatures with their doc comments from the code.
4. **`fetchUpstream` steps.**
   - Step 1: start with `assertUpstream(upstream)` (failure → `internal`). Replace "Callers
     `encodeURIComponent` every caller-supplied path segment" with "Adapters build every path
     through `pathSegment()` for each caller-supplied value; it rejects `''`, `.`, `..`, `/`, `\`,
     `%2e` and `%2f`, and percent-encodes the rest."
   - Step 3: the request is
     `new Request(target, { headers: { 'user-agent': USER_AGENT }, redirect: 'manual', signal })`.
     A 301/302/303/307/308 with a `Location` is resolved against the current target, released
     (`response.body?.cancel()`) and re-checked against the base origin and path (outside →
     `upstream_error` "…redirected outside its base URL"). At most 3 redirects are followed; a 4th
     → `upstream_error` "…redirected more than 3 times". A 3xx without `Location` is an ordinary
     non-2xx.
   - Steps 4 to 6: the ux-3/code-6 message table above, including the body-read timeout. The cache
     key and `url` stay the requested URL.
5. **`validateRegistry` list:** add the `assertUpstream` rules (https, no credentials, trailing
   `/`, no query or fragment, positive-integer `ttlSeconds`, positive finite `timeoutMs`), the
   key-order-independent upstream comparison (`sameUpstream`), and the idempotent-input rule with
   its rationale and limits.
6. **`meta_ping` snippet** and **`buildMcpServer` snippet:** the ux-2 strings, and the ux-1
   comment. Under "The SDK validates arguments…", add the exact SDK prefix and the
   REST/MCP difference.
7. **`src/transports/rest.ts`:** the `doc31` call shows `tags`.
8. **`src/index.ts` block:** drop `AppConfig`/`parseConfig` and point to `src/config.ts`.
9. **Example-module snippet:** `` `items/${pathSegment(id)}.json` `` and import `pathSegment`,
   matching `test/support/example-module.ts`.
10. **CI yaml:** add `with: persist-credentials: false` under checkout.
11. **Acceptance criteria / test plan rows** that quote old messages (`"Narrow the request."`, the
    SSRF bullet) get the new wording. Add a sentence under "Upstream helper" that exactly 3
    redirects succeed and a 4th fails.

Do not rewrite unrelated parts of the #2 spec.

### Upstream calls and fixtures

None. This issue adds no upstream and records no fixture. New tests use the existing synthetic
`example` upstream (`https://upstream.test/`), `test/fixtures/example/items/alpha.json`, and
inline `deps.fetch` stubs, as `test/upstreams/http.test.ts` already does for the User-Agent test.

## Acceptance criteria

- [ ] `npm ci && npm run typecheck && npm test` pass; `npm run build` bundles without credentials.
- [ ] **code-1:** `test/core/invoke.test.ts` exists and asserts `{ ok: false }` with
      `error.code === 'internal'` and the exact messages `demo_thing failed unexpectedly` (handler
      throws `new Error('boom')`) and `demo_thing produced output that does not match its schema`
      (handler returns data the `data` schema rejects).
- [ ] **code-3:** `validateRegistry` rejects an input field with `.transform()` (`/input field "t"
      has a transform/`), `z.string().pipe(z.coerce.number())` and `z.stringbool()` (`/parses to
      a different type than it accepts/`). It accepts `.default()`, `.prefault()`, `.catch()`,
      `.trim()`, `.toLowerCase()`, `z.coerce.number()`, the production registry and
      `[metaModule, exampleModule]`. AGENTS.md Rules carries the bullet.
- [ ] **code-4:** `src/config.ts` exports `AppConfig` and `parseConfig`;
      `grep -rn "from '../index'" src` returns nothing; `src/index.ts` neither defines nor
      re-exports them.
- [ ] **code-5:** two modules that declare the same upstream with keys in a different order pass
      `validateRegistry`; one that differs only in `timeoutMs` is rejected.
- [ ] **code-6:** a body stream that errors with the request signal's reason gives
      `upstream_timeout` with the timeout message, and nothing is cached.
- [ ] **ux-1:** `test/transports/mcp.test.ts` asserts the `id: 'Bad Id'` result text starts with
      `Input validation error: Invalid arguments for tool example_item:`; `mcp.ts` carries the
      comment.
- [ ] **ux-2:** `grep -rn "how fresh each source is\|coverage and freshness" src docs/specs/2-scaffold.md`
      returns nothing; the strings match this spec.
- [ ] **ux-3:** `test/upstreams/http.test.ts` asserts the exact new messages for timeout, network
      failure, HTTP 500, a non-timeout body-read failure, and that HTTP 403 stays
      `Example upstream returned HTTP 403`.
- [ ] **ux-4:** `test/envelope.test.ts` asserts the new `result_too_large` message.
- [ ] **ux-5:** `GET /api/openapi.json` has
      `tags: [{ name: 'meta', description: metaModule.description }, { name: 'example', description: exampleModule.description }]`.
- [ ] **ux-6:** README has the "Try it locally" section linking `AGENTS.md#commands`.
- [ ] **security-4:** `.github/workflows/ci.yml` checkout has `persist-credentials: false`.
- [ ] **security-seam-3:** a test where `hop(3)` returns 200 succeeds with
      `fetch.calls` equal to `[ALPHA, hop(1), hop(2), hop(3)]` (length 4).
- [ ] **security-seam-4:** `grep -n "encodeURIComponent" docs/specs/2-scaffold.md` returns
      nothing. The spec shows `redirect: 'manual'`,
      the 3-hop limit, the `assertUpstream` rules and `pathSegment(id)` in the example snippet.
- [ ] **security-2-rest:** `validateRegistry` rejects (one `test.each` per rule) a `baseUrl` with a
      username, username+password, or password only, with a message that does not contain the
      password; `ttlSeconds` of `0`, `-1`, `1.5`, `NaN`, `Infinity`; `timeoutMs` of `0`, `-1`,
      `NaN`, `Infinity`. It accepts an upstream without `timeoutMs`. `fetchUpstream` with an
      unregistered credentialed upstream throws `internal` without fetching, and the message does
      not contain the password.
- [ ] `grep -rn "assertBaseUrl" src test docs` returns nothing.

## Test plan

All Vitest in Node, no network, existing helpers (`fixtureFetch`, `makeDeps`, `codeOf`,
`makeTestApp`, `connectClient`).

| File | New or changed cases |
|---|---|
| `test/core/invoke.test.ts` (new) | Build throwaway capabilities with `defineCapability` (module `demo`, name `demo_thing`) and a `Deps` from `createMemoryCache`. In `beforeEach`, `vi.spyOn(console, 'error').mockImplementation(() => {})`; in `afterEach`, `vi.restoreAllMocks()`. Cases: (1) handler throws `new Error('boom')` → `ok: false`, code `internal`, message `demo_thing failed unexpectedly`, `console.error` called with `('demo_thing', error)`; (2) `data: z.object({ n: z.number() })`, handler returns `{ n: 'x' }` → `internal`, `demo_thing produced output that does not match its schema`; (3) handler throws `new CapabilityError('not_found', 'gone')` → passed through unchanged (same instance); (4) input that fails the schema → `invalid_input` and the handler is not called. |
| `test/core/registry.test.ts` | `test.each` rejections for code-3 (transform, pipe, stringbool) and an accept case (default, prefault, catch, trim, toLowerCase, coerce.number). code-5: same upstream with keys reordered accepted (build the second object literal in a different key order); `timeoutMs` differing rejected. security-2-rest: three `test.each` blocks (credentials, ttlSeconds, timeoutMs) plus an accept case without `timeoutMs` (`const { timeoutMs: _omit, ...noTimeout } = exampleUpstream`). For credentials, catch the thrown error and assert its `message` does not contain `secret`. |
| `test/upstreams/http.test.ts` | Update exact messages (timeout, network, 500). Add: 403 keeps the plain message; a body-read timeout (stub `deps.fetch` returning `new Response(new ReadableStream({ start(controller) { request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true }); } }))`) → `upstream_timeout`, and `deps.cache.get(ALPHA)` is undefined; a body-read failure (stream `start(controller) { controller.error(new TypeError('terminated')); }`) → `upstream_error` with the new message; "follows exactly 3 redirects" (hop(3) → 200, calls length 4). Add `'https://user:secret@upstream.test/'` to the "unregistered upstream with an unsafe baseUrl" `test.each`, and assert the message does not contain `secret`. |
| `test/transports/mcp.test.ts` | "input that fails the schema" also asserts the text starts with `Input validation error: Invalid arguments for tool example_item:`. |
| `test/transports/rest.test.ts` | The OpenAPI test asserts `body.tags`. |
| `test/envelope.test.ts` | The 8193-byte case expects the new message. |
| `test/config.test.ts` | Import from `../src/config`. |

Manual: `npm run dev`, then `curl -s http://127.0.0.1:8787/api/v1/meta/ping` and the MCP `curl`
from AGENTS.md. Paste the output in the PR.

## Risks

- **The idempotence check is a proxy.** It compares JSON Schemas, so it catches type-changing
  transforms but not value-rewriting `.overwrite()`/`z.preprocess()`. A same-type `.transform()`
  that happens to be idempotent (e.g. `s => s.trim()`) is rejected. The message says to use
  `.trim()` or transform in the handler, which costs little.
- **zod's JSON Schema output can change between minor versions.** For example, `default` might
  start appearing on only one side for `.default()`. The accept cases in `registry.test.ts` would
  then fail loudly at upgrade time rather than silently.
- **The SDK error prefix is SDK-owned.** A future SDK release can reword it. The ux-1 test pins it
  on purpose, so the drift shows up as a failing test.
- **Proposal vs. wording.** The proposal says `bioc://about` reports each source's freshness. ux-2
  rewords today's strings to match what the server does. When #3 adds the docs index build time to
  `about`, those strings should say so again.
- **Unpinned actions.** Accepted for now (see security-4). Re-evaluate in #11.
- **Renaming `assertBaseUrl`** touches two call sites and the #2 spec. Nothing outside this repo
  imports it.
