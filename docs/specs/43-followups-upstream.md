# Spec #43: Follow-ups on the upstream seam and invoke

Issue: [seandavi/bioc-mcp#43](https://github.com/seandavi/bioc-mcp/issues/43). It collects
review findings from [#18](https://github.com/seandavi/bioc-mcp/issues/18) (all items),
[#20](https://github.com/seandavi/bioc-mcp/issues/20) code-r0-1,
[#28](https://github.com/seandavi/bioc-mcp/issues/28) main-1,
[#32](https://github.com/seandavi/bioc-mcp/issues/32) code-r0-3 and
[#36](https://github.com/seandavi/bioc-mcp/issues/36) code-r0-1. Builds on
[Spec #2](2-scaffold.md) and [Spec #15](15-scaffold-followups.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

The following was checked on 2026-10-22. **Verified** marks what was run, not just reasoned about:

- **Verified** (Node 26.8.1): `AbortSignal.timeout(1.5)` throws `RangeError [ERR_OUT_OF_RANGE]`
  "The value of "delay" is out of range. It must be an integer. Received 1.5", and
  `AbortSignal.timeout(2 ** 32)` throws "It must be >= 0 && <= 4294967295". `2147483647` and
  `60000` are accepted (#18 code-r0-2).
- **Verified** (Node 26.8.1): reading a `Response` body with `getReader()` and
  `new TextDecoder().decode(chunk, { stream: true })`, then `decode()`, gives the same string as
  `response.text()`, including the stripped UTF-8 BOM. `new Response(null).body` is `null`.
- **Verified** (`worker-configuration.d.ts`): workerd's `Response.body` is `ReadableStream | null`,
  `ReadableStream.getReader()` returns a `ReadableStreamDefaultReader` with `read()` and
  `cancel()`, and `TextDecoder.decode(input, { stream })` exists. Not run in workerd; the
  manual `npm run dev` check below covers it.
- **Verified** (live `curl --compressed … | wc -c`, decoded bytes, 2026-10-22). Response sizes per upstream:

  | Upstream | Largest response checked | Decoded bytes |
  |---|---|---|
  | `registry` | `data/prop/bioc/index.json` | 8,035,095 |
  | `registry` | `data/prop/bioc-release/index.json` | 7,780,823 |
  | `registry` | `checks/bioc/95858209718` (the 7 recorded check jobs; the others are 11–28 KB) | 821,913 |
  | `github` | `bioc-infrastructure/issues?state=open&per_page=100&…` | 149,993 |
  | `bioconductor` | `packages/stats/bioc/limma/` (HTML page) | 115,381 |
  | `r-universe-bioc` | `packages/Biostrings` | 70,438 |

  Spec #7 also records single files of 1.6 MB (`{pkg}-Ex.Rout`) and 2.5 MB (`00BiocCheck.log`)
  inside `/checks` responses.
- **Verified** (Node 26.8.1, `--expose-gc`, heapUsed + external + arrayBuffers, one run): the
  live devel index loaded as `{ text, packages }` came to 31.7 MB, and as `{ packages }` with the
  text dropped to 23.7 MB. Keeping the body costs about 8 MB per universe, which matches #20
  code-r0-1. V8's `JSON.parse` therefore does not keep the source string alive through sliced
  strings.

## Goal

Close every item #43 lists in one PR. Each item is fixed; none turned out to be moot or declined
on reading the current code (each finding still applies on `main` at `41923d1`). The PR body
repeats this table so the source issues can be ticked and closed after merge:

| Source | Id | Outcome | What changes |
|---|---|---|---|
| #18 | code-r0-2 | fixed | `timeoutMs` must be an integer in 1…`MAX_TIMEOUT_MS` (60,000) |
| #18 | code-r0-3 | fixed | `Upstream` interface comments state the rules; AGENTS.md upstream rule extended |
| #18 | code-r0-4 | fixed | Spec #2 puts `Capability`, `Module`, `defineCapability` in `src/core/capability.ts` |
| #18 | code-r0-5 | fixed | Spec #15's `assertBaseUrl` grep criterion is narrowed so it can pass |
| #18 | code-r0-6 | fixed | The body-read-timeout test uses a new `'body-timeout'` `FixtureRoute` that holds the signal |
| #18 | code-r1-1 | fixed | `assertUpstream` doc comment re-wrapped (and rewritten for the new rules) in code and spec #2 |
| #20 | code-r0-1 | fixed | The propagation-index memo drops the 8 MB body; `sourceFor` takes a body-less response |
| #28 | main-1 | fixed | `fetchUpstream` reads at most `maxBytes` per upstream and fails cleanly past it |
| #32 | code-r0-3 (+ ux-r0-7) | fixed | Every error message built in `http.ts` and `github.ts` ends with `.`; GitHub 404 wording covers sub-paths |
| #36 | code-r0-1 | fixed | `invokeCapability` sizes the envelope *after* the output parse |

Out of scope, per the issue: #36 code-r0-2 (the proposal lives in bioc-infrastructure).

## Non-goals

- No new capability, module, upstream, MCP tool, REST route or recorded fixture. No capability's
  input or output schema changes, so this spec has no capability schemas to list (see "Upstream
  calls and fixtures").
- No other items from #18, #20, #28, #32 or #36: they belong to other follow-up issues.
  In particular #32 ux-r0-3 (a GitHub 401 message) and #28's other items are not touched.
- No `Content-Length` pre-check before reading a body. The stream count is what bounds memory, and
  with `Content-Encoding` the header gives the encoded length, not the decoded one (see Risks).
- No per-path byte caps (`/checks` vs the index). The cap is per upstream, as #28 main-1 proposes.
- `assertUpstream`'s own messages (configuration errors, raised at start-up by
  `validateRegistry`) do not gain a trailing period. Only `CapabilityError` messages built in
  `http.ts` and `github.ts` change (#32).
- `errorsSentence` in `src/core/ops/activity.ts` is unchanged; the messages it quotes now end with
  a period at the source.
- Specs other than #2, #6, #9 and #15 are not edited.

## Design

### Files

```
src/upstreams/http.ts             Upstream comments + maxBytes; MAX_TIMEOUT_MS, DEFAULT_MAX_BYTES,
                                  UpstreamResponseMeta; assertUpstream rules + re-wrapped comment;
                                  readCapped(); messages end with '.'; sourceFor(UpstreamResponseMeta)
src/upstreams/registry.ts         registryUpstream.maxBytes; PropagationIndex.response is body-less
src/upstreams/github.ts           404 and unexpected-shape messages
src/core/registry.ts              UPSTREAM_FIELDS gains maxBytes
src/core/invoke.ts                size guard after the output parse
AGENTS.md                         upstream rule; 8 KB rule
docs/specs/2-scaffold.md          brought up to date (list below)
docs/specs/6-pkg-status.md        PropagationIndex snippet; Risks › Memory
docs/specs/9-ops-activity.md      the two GitHub message strings
docs/specs/15-scaffold-followups.md  rule-7 row; the assertBaseUrl grep criterion
test/support/fixture-fetch.ts     'body-timeout' FixtureRoute
test/upstreams/http.test.ts       body-timeout via the route; byte-cap cases; message updates
test/upstreams/github.test.ts     message updates
test/upstreams/registry.test.ts   memo holds no body; registry maxBytes
test/core/registry.test.ts        timeoutMs and maxBytes rules; sameUpstream on maxBytes
test/core/invoke.test.ts          output-side bytes are caught; oversized + off-schema is internal
test/core/ops/activity.test.ts    a non-5xx per-repo error still ends the summary with '.'
```

### `src/upstreams/http.ts`

#### The `Upstream` interface and constants (#18 code-r0-2, code-r0-3; #28 main-1)

Replace the interface and add the constants next to `DEFAULT_TIMEOUT_MS`, exactly:

```ts
export interface Upstream {
  id: string; // stable, kebab-case, e.g. 'registry', 'r-universe'
  name: string; // human name used in messages, e.g. 'Bioconductor registry'
  baseUrl: string; // https:, no credentials, ends with '/', no query/fragment
  ttlSeconds: number; // positive integer; cache TTL for 200 responses
  timeoutMs?: number; // positive integer <= MAX_TIMEOUT_MS; default DEFAULT_TIMEOUT_MS
  maxBytes?: number; // positive integer; decoded body bytes read before failing; default DEFAULT_MAX_BYTES
  description: string; // one line for bioc://about
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** AbortSignal.timeout needs an integer delay; a minute is far above any upstream we call. */
export const MAX_TIMEOUT_MS = 60_000;
/** 2 MiB: more than 10x the largest github, r-universe or bioconductor.org response seen. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
```

`bioc://about` (`src/core/about.ts`) does not report `maxBytes`; it is not changed.

#### `assertUpstream` (#18 code-r0-2, code-r1-1; #28 main-1)

Doc comment, exactly (wrapped at 100 columns):

```ts
/**
 * The SSRF guard below is only sound for an https: baseUrl that ends with '/' and has no query or
 * fragment. The baseUrl must not carry credentials. No message ever includes the baseUrl itself,
 * so a password in a malformed or non-https: URL never reaches a client. ttlSeconds must be a
 * positive integer (about and cache-control take integers). timeoutMs, when set, must be a
 * positive integer no greater than MAX_TIMEOUT_MS (AbortSignal.timeout throws on fractions and
 * on values above 2^32 - 1). maxBytes, when set, must be a positive integer. Checked at
 * registration (validateRegistry) and again on every fetch, so an adapter cannot bypass it by
 * passing an upstream it never registered.
 */
```

Rules 1–6 (baseUrl and `ttlSeconds`) are unchanged. Rule 7 changes and rule 8 is new; the first
violation throws `Error`:

| # | Rule | Message (exact) |
|---|---|---|
| 7 | `timeoutMs === undefined \|\| (Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)` | `` `Upstream "${id}" timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS} (got ${timeoutMs})` `` |
| 8 | `maxBytes === undefined \|\| (Number.isInteger(maxBytes) && maxBytes > 0)` | `` `Upstream "${id}" maxBytes must be a positive integer (got ${maxBytes})` `` |

With `MAX_TIMEOUT_MS = 60_000` the first message reads `… no greater than 60000 (got 1.5)`.

#### `fetchUpstream`: the byte cap (#28 main-1)

Add a private helper below `isTimeout`:

```ts
/**
 * The body as UTF-8 text, like response.text(), or null once more than maxBytes have arrived. The
 * count is of decoded bytes (after Content-Encoding), which is what the isolate holds. Past the
 * cap the stream is cancelled, so its connection is released and nothing more is buffered. Read
 * errors (including the timeout) propagate to the caller.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}
```

In `fetchUpstream`, add `const maxBytes = upstream.maxBytes ?? DEFAULT_MAX_BYTES;` next to
`const timeoutMs = …`, and change the body read to:

```ts
  let body: string | null;
  try {
    body = await readCapped(response.body, maxBytes);
  } catch (error) {
    // unchanged: isTimeout → timeoutError(); else upstream_error "Could not read the response …"
  }
  if (body === null) {
    throw new CapabilityError(
      'upstream_error',
      `${upstream.name} sent more than ${maxBytes} bytes (${url.href}); this server does not read responses that large.`,
      details,
    );
  }
```

The existing `catch` still covers `reader.read()` rejections, including the body-read timeout.

The `CachedUpstream` is built only on success, so nothing is cached past the cap. `details` stays
`{ upstream, url }`; `CapabilityError['details']` gains no field. The cap applies to network
reads only. A cache hit returns what an earlier capped read stored.

#### `registryUpstream.maxBytes` (#28 main-1)

In `src/upstreams/registry.ts`:

```ts
  timeoutMs: 15_000, // the index is ~8 MB
  maxBytes: 16 * 1024 * 1024, // the devel index was 8.0 MB on 2026-10-22; /checks responses reach several MB
```

`githubUpstream`, both `rUniverseUpstreams` and `bioconductorUpstream` take the default (2 MiB).

#### Messages end with a period (#32 code-r0-3)

Every `CapabilityError` message built in `http.ts` ends with `.`. Exact strings after the change
(`<url>` is `url.href`, `<name>` is `upstream.name`):

| Where | Code | Message (exact) |
|---|---|---|
| `pathSegment` | `invalid_input` | `"<value>" cannot be used as a URL path segment.` |
| SSRF guard on the path | `internal` | `Refusing to fetch outside <name>.` |
| redirect leaves the base | `upstream_error` | `<name> redirected outside its base URL.` |
| more than 3 redirects | `upstream_error` | `<name> redirected more than 3 times.` |
| status 404 | `not_found` | `<name> has nothing at <url>.` |
| other non-2xx, not ≥ 500 | `upstream_error` | `<name> returned HTTP <status>.` |
| body over `maxBytes` (new) | `upstream_error` | `<name> sent more than <maxBytes> bytes (<url>); this server does not read responses that large.` |
| invalid JSON (`fetchUpstreamJson`) | `upstream_error` | `<name> returned a response that is not valid JSON.` |

The timeout, network, ≥ 500 and body-read rows already end with `Try again shortly.` and are
unchanged. In code: `` `${upstream.name} returned HTTP ${response.status}${advice}` `` becomes
`` `${upstream.name} returned HTTP ${response.status}${advice || '.'}` ``. Since `advice` already
ends with `.`, the ≥ 500 text is unchanged.

#### `sourceFor` and `UpstreamResponseMeta` (#20 code-r0-1)

```ts
/** An UpstreamResponse without its body: what a caller keeps for provenance after parsing. */
export type UpstreamResponseMeta = Omit<UpstreamResponse, 'body'>;

/** Provenance for one response: as_of = asOf ?? response.lastModified ?? response.fetchedAt. */
export function sourceFor(response: UpstreamResponseMeta, asOf?: string): Source;
```

The body is unchanged. Every existing caller passes an `UpstreamResponse`, which is assignable to
`UpstreamResponseMeta`, so no caller changes.

### `src/upstreams/registry.ts`: the memo drops the body (#20 code-r0-1)

```ts
export interface PropagationIndex {
  response: UpstreamResponseMeta; // for sourceFor(); the ~8 MB body is dropped once parsed
  packages: Record<string, unknown>; // parsed index.json; entries unvalidated
}
```

In `loadPropagationIndex`, return
`` `{ response: meta, packages: json as Record<string, unknown> }` `` where
`const { body: _body, ...meta } = response;`. Import `type UpstreamResponseMeta` from `./http`.
`getPropagationIndex`'s spread `{ ...shared.response, fromCache: true }` is unchanged.
`CheckFiles` and `getBuildManifest` keep `UpstreamResponse`, because nothing memoises them.

### `src/upstreams/github.ts` (#32 code-r0-3 and ux-r0-7)

In `githubJson`:

| Case | Message (exact) |
|---|---|
| `not_found` | `` `GitHub has nothing at ${error.details.url}; the repository, PR or workflow may have been removed, renamed or made private.` `` |
| `safeParse` fails | `` `GitHub returned an unexpected ${what} for seandavi/${repo}.` `` |

The 403/429 message already ends with `Try again later.` and is unchanged, as is the `githubJson`
doc comment (it quotes no message).

### `src/core/registry.ts` (#28 main-1)

Add `maxBytes: true` to `UPSTREAM_FIELDS`, after `timeoutMs`. Without it `tsc` fails, because
the map is typed `Record<keyof Upstream, true>`. Two declarations of one upstream id that differ
only in `maxBytes` are then rejected with the existing message.

### `src/core/invoke.ts` (#36 code-r0-1)

`runCapability` checks the size of the parsed envelope, which is what the transports send:

```ts
  let envelope: Envelope<unknown>;
  try {
    envelope = await capability.handler(parsed.data, deps);
  } catch (error) {
    if (error instanceof CapabilityError) return { ok: false, error };
    console.error(capability.name, error);
    return { ok: false, error: new CapabilityError('internal', `${capability.name} failed unexpectedly`) };
  }

  const output = capability.output.safeParse(envelope);
  if (!output.success) {
    // …unchanged: console.error + internal "<name> produced output that does not match its schema"
  }
  // Return the parsed value so fields the output schema does not declare never leave the server.
  // Size that value, not the handler's: an output-side .default() or .transform() can add bytes.
  const sent = output.data as Envelope<unknown>;
  try {
    assertEnvelopeSize(sent, capability.name);
  } catch (error) {
    if (error instanceof CapabilityError) return { ok: false, error };
    throw error;
  }
  return { ok: true, envelope: sent };
```

Accepted cost, named in the issue: a result that is both oversized and off-schema now reports
`internal` (schema mismatch) instead of `result_too_large`. Both are server bugs. The usage event
(`error_code`) follows the same order.

### `test/support/fixture-fetch.ts` (#18 code-r0-6)

Add a route variant and handle it next to `'timeout'`, reusing `pendingSignals`:

```ts
export type FixtureRoute =
  | { file: string; status?: number; headers?: Record<string, string> }
  | { status: number; body?: string; headers?: Record<string, string> }
  | 'timeout'
  | 'body-timeout' // 200 whose body never arrives; the read fails with the signal's reason
  | 'network-error';
```

```ts
    if (route === 'body-timeout') {
      pendingSignals.add(request.signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener(
            'abort',
            () => {
              pendingSignals.delete(request.signal);
              controller.error(request.signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(stream);
    }
```

The existing "a timeout while reading the body…" test in `test/upstreams/http.test.ts` uses
`makeDeps({ [ALPHA]: 'body-timeout' })` instead of its inline `deps.fetch` stub. Its assertions are
unchanged.

### `AGENTS.md`

- Upstream rule: the bullet's last sentence
  `` Upstream `baseUrl`s are `https:` and end with `/`. `` becomes:
  `` Upstream `baseUrl`s are `https:`, carry no credentials and end with `/`; `ttlSeconds` is a positive integer, `timeoutMs` (at most 60000) and `maxBytes` positive integers when set (`assertUpstream` enforces this). `fetchUpstream` stops reading a body past `maxBytes` (default 2 MiB) and fails with `upstream_error`. ``
- 8 KB rule: replace
  `` `assertEnvelopeSize` checks `JSON.stringify(envelope)` against `MAX_RESULT_BYTES` (8192), ``
  with
  `` `invokeCapability` runs `assertEnvelopeSize` on the envelope after the output schema parse (what the transports send), checking `JSON.stringify(envelope)` against `MAX_RESULT_BYTES` (8192), ``.
  The rest of the bullet stays. Re-wrap both bullets at about 100 columns.

### `docs/specs/2-scaffold.md` (#18 code-r0-2, -3, -4, r1-1; #28; #32; #36)

Change only these parts, so the #2 spec matches the code after this PR:

1. **Files** (code-r0-4): add
   `core/capability.ts          Capability, Module, defineCapability()` above `core/registry.ts`,
   and change the `core/registry.ts` line to
   `validateRegistry(), restPath(), the production `modules` list; re-exports capability.ts`.
2. **The `### src/core/registry.ts` block** (code-r0-4): split it. A new heading
   `### src/core/capability.ts` holds the `Capability`, `defineCapability` and `Module` code, with
   one sentence: "Capability modules import these from `'../capability'`, never from
   `'../registry'`, which imports them through the production `modules` list and would form a
   cycle." The `### src/core/registry.ts` heading keeps `modules`, `validateRegistry`, `restPath`,
   says registry.ts re-exports the capability.ts types for callers outside `core/<module>/`, and
   keeps the `validateRegistry` paragraph.
3. **`src/upstreams/http.ts` block**: the `Upstream` interface, the constants, `UpstreamResponseMeta`,
   the `assertUpstream` doc comment (re-wrapped exactly as above, code-r1-1) and the `sourceFor`
   signature, all as in this spec.
4. **`fetchUpstream` behaviour**: step 1's SSRF message and step 3's two redirect messages get their
   period. The step 4 table gets the period on the 404 and "other non-2xx" rows and a new row
   `| body over maxBytes | upstream_error | <name> sent more than <maxBytes> bytes (<url>); this server does not read responses that large. |`.
   Step 5 becomes "Read the body with `readCapped(response.body, upstream.maxBytes ?? DEFAULT_MAX_BYTES)`
   (decoded bytes; the stream is cancelled past the cap); build the `CachedUpstream`; …". The rest
   of step 5 is unchanged.
5. **`validateRegistry` paragraph**: replace "positive finite `timeoutMs`" with "`timeoutMs` a
   positive integer no greater than 60000, `maxBytes` a positive integer".
6. **`src/core/invoke.ts` steps**: "Then `assertEnvelopeSize`. Then `capability.output.safeParse(envelope)`;
   failure is logged and becomes `internal` (…)" becomes "Then `capability.output.safeParse(envelope)`;
   failure is logged and becomes `internal` (…). Then `assertEnvelopeSize` on the parsed envelope,
   the value the transports send, so an output schema that adds bytes cannot pass the limit."
7. **`pathSegment` and `fetchUpstreamJson`** comments or prose that quote a message get the period.

### `docs/specs/6-pkg-status.md` (#20 code-r0-1)

- The `PropagationIndex` snippet uses `response: UpstreamResponseMeta; // for sourceFor(); the ~8 MB body is dropped once parsed`.
- Behaviour step 5 becomes "The load resolves to `{ response: <response without body>, packages: json }` …".
- Risks › Memory: append "The memo keeps only the parsed index and the response's metadata; the
  ~8 MB body is dropped after `JSON.parse` (#43). Keeping it measured about 8 MB more per
  universe in Node 26."

### `docs/specs/9-ops-activity.md` (#32 code-r0-3)

Replace the two strings in the "Error mapping" list with the exact `github.ts` messages above.
Leave the Summary › Errors sentence ("the message ends with its own period") as it is; it is now
true.

### `docs/specs/15-scaffold-followups.md` (#18 code-r0-2, code-r0-5)

- Rule table row 7: rule `timeoutMs === undefined || (Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)`,
  message `` Upstream "<id>" timeoutMs must be a positive integer no greater than 60000 (got <timeoutMs>) ``,
  with a trailing note "(tightened by #43)".
- Acceptance criterion `` `grep -rn "assertBaseUrl" src test docs` returns nothing `` becomes
  `` `grep -rn "assertBaseUrl" src test docs/specs/2-scaffold.md` returns nothing ``.

### Upstream calls and fixtures

None. This issue adds no upstream and no upstream call, and records no fixture. The byte-cap tests
use `exampleUpstream` (`https://upstream.test/`) copies with a small `maxBytes`, fed by inline
`deps.fetch` stubs or `{ status: 200, body }` routes, as `test/upstreams/http.test.ts` already
does. Every existing fixture served through `fetchUpstream` is far below its cap (the largest
is `test/fixtures/bioconductor/packages/stats/bioc/edgeR/index.html`, 115,089 bytes, against
2 MiB; the largest registry fixture is 42,435 bytes), so no existing test changes because of
the cap. (`test/fixtures/docs/` feeds the build script, not `fetchUpstream`.)

## Acceptance criteria

- [ ] `npm ci && npm run typecheck && npm test` pass; `npm run build` bundles without credentials.
- [ ] **#18 code-r0-2:** `validateRegistry` rejects `timeoutMs` of `0`, `-1`, `1.5`, `2 ** 32`,
      `60_001`, `NaN` and `Infinity` with
      `/timeoutMs must be a positive integer no greater than 60000/`, and accepts `60_000` and an
      absent `timeoutMs`.
- [ ] **#18 code-r0-3:** the `Upstream` interface comments in `src/upstreams/http.ts` match this
      spec and spec #2's block word for word. AGENTS.md has the extended upstream rule.
- [ ] **#18 code-r0-4:** spec #2's Files list has `core/capability.ts`, and a
      `### src/core/capability.ts` heading holds `Capability`, `defineCapability` and `Module`.
- [ ] **#18 code-r0-5:** `grep -rn "assertBaseUrl" src test docs/specs/2-scaffold.md` returns
      nothing, and spec #15 states that command.
- [ ] **#18 code-r0-6:** `FixtureRoute` has `'body-timeout'`, which adds the signal to
      `pendingSignals`. The body-read timeout test uses it and no longer stubs `deps.fetch`.
- [ ] **#18 code-r1-1:** no line of the `assertUpstream` doc comment in `src/upstreams/http.ts`
      exceeds 100 columns, and spec #2's copy is identical.
- [ ] **#20 code-r0-1:** after `getPropagationIndex`, `'body' in index.response` is `false`, both
      on the first (fetching) call and on a memo hit. `pkg_status` sources are unchanged (the
      existing `test/core/pkg/status.test.ts` passes).
- [ ] **#28 main-1:** with `maxBytes: 16`, a 16-byte body succeeds and a 17-byte body fails with
      `upstream_error` and the exact message
      `Example upstream sent more than 16 bytes (https://upstream.test/items/alpha.json); this server does not read responses that large.`.
      Nothing is cached. Bytes are counted, not characters: 8 × `é` (16 bytes) passes and 9 fails.
      An endless stream is cancelled once past the cap. An `é` split across two chunks decodes
      as `é`. Without `maxBytes`, `DEFAULT_MAX_BYTES + 1` bytes fail and `DEFAULT_MAX_BYTES`
      pass. `validateRegistry` rejects `maxBytes` of `0`, `-1`, `1.5`, `NaN`, `Infinity`, and two
      declarations that differ only in `maxBytes`. `registryUpstream.maxBytes === 16 * 1024 * 1024`.
- [ ] **#32 code-r0-3:** `test/upstreams/http.test.ts` and `test/upstreams/github.test.ts` assert
      the exact period-terminated messages in the tables above. A per-repo HTTP 422 in an
      all-repo `ops_activity` call gives a summary that ends with
      `Could not read bioc-traffic: GitHub REST API returned HTTP 422.`.
- [ ] **#36 code-r0-1:** a capability whose `data` schema pads a field in `.transform()` past
      8 KB, while the handler's own envelope is small, gives `result_too_large`. A handler
      envelope that is both over 8 KB and off-schema gives `internal`
      `demo_thing produced output that does not match its schema`. The existing REST and MCP
      `result_too_large` tests (`example_item`, `repeat=1000`) still pass. AGENTS.md's 8 KB bullet
      names the post-parse check.
- [ ] Specs #2, #6, #9 and #15 carry the edits listed above; no other spec changes.

## Test plan

All Vitest in Node, no network, with the existing helpers (`fixtureFetch`, `makeDeps`, `codeOf`,
`errorOf`, `githubRoutes`, `run`).

| File | New or changed cases |
|---|---|
| `test/support/fixture-fetch.ts` | `'body-timeout'` route (above). |
| `test/upstreams/http.test.ts` | "a timeout while reading the body…" uses `makeDeps({ [ALPHA]: 'body-timeout' })`. Update the exact messages: 404 (`… has nothing at ${ALPHA}.`), 403 (`Example upstream returned HTTP 403.`), redirects outside (two tests) and more than 3, 302 without Location (`… returned HTTP 302.`). The invalid-JSON test asserts the exact string `Example upstream returned a response that is not valid JSON.`. Add one `pathSegment` message assertion: `pathSegment('a/b')` throws `invalid_input` with `"a/b" cannot be used as a URL path segment.`. New `describe('byte cap')` with `const small = { ...exampleUpstream, maxBytes: 16 }`: (1) `{ status: 200, body: 'a'.repeat(16) }` → body returned; (2) `'a'.repeat(17)` → `upstream_error`, exact message, `deps.cache.get(ALPHA)` undefined; (3) `'é'.repeat(8)` passes, `'é'.repeat(9)` fails; (4) endless stream `new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } })` via a `deps.fetch` stub → rejects with `upstream_error` and `cancelled === true`; (5) chunks `[0x22, 0xc3]` and `[0xa9, 0x22]` (`"é"`) via `start(c) { c.enqueue(…); c.enqueue(…); c.close(); }` with `fetchUpstreamJson` → `json === 'é'`; (6) `exampleUpstream` (no `maxBytes`): `'a'.repeat(DEFAULT_MAX_BYTES)` passes, `'a'.repeat(DEFAULT_MAX_BYTES + 1)` fails with `sent more than 2097152 bytes`. |
| `test/upstreams/github.test.ts` | The 404 test asserts the exact message `GitHub has nothing at ${url}; the repository, PR or workflow may have been removed, renamed or made private.`. The two unexpected-shape tests add the trailing `.`. |
| `test/upstreams/registry.test.ts` | In "parses the index once per TTL…": `expect('body' in first.response).toBe(false)` and the same for `second`. New: `registryUpstream.maxBytes` is `16 * 1024 * 1024`. |
| `test/core/registry.test.ts` | `timeoutMs` `test.each` becomes `[0, -1, 1.5, 2 ** 32, 60_001, Number.NaN, Number.POSITIVE_INFINITY]` with the new regex; add "accepts timeoutMs 60000". New `test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects maxBytes %s', …)` → `/maxBytes must be a positive integer/`. New: the same upstream declared twice with `maxBytes` differing (`{ ...exampleUpstream, maxBytes: 1 }`) is rejected, like the existing `timeoutMs` case. |
| `test/core/invoke.test.ts` | New `describe('the size guard')`: (1) `defineCapability` with `data: z.object({ pad: z.string().transform((s) => s.padEnd(9000, 'x')) })` and a handler returning `{ data: { pad: 'x' }, summary: '', sources: [] }` → `ok: false`, `error.code === 'result_too_large'`; (2) `demoThing(async () => ({ data: { n: 'x'.repeat(9000) }, summary: '', sources: [] }))` → `internal`, `demo_thing produced output that does not match its schema`. |
| `test/core/ops/activity.test.ts` | Next to "one failing repo is reported…": the same setup with `{ status: 422 }` for `githubUrl('bioc-traffic', ISSUES_SUFFIX)`, run `'summary'` with `{}`, assert `summary.endsWith('Could not read bioc-traffic: GitHub REST API returned HTTP 422.')`. |

Manual (paste the output in the PR): `npm run dev`, then
`curl -s 'http://127.0.0.1:8787/api/v1/pkg/status?package=edgeR'`. This reads the live 8 MB
devel index through `readCapped` in workerd, so it confirms the streaming decode and the 16 MiB
registry cap there. Also run the MCP `tools/list` curl from AGENTS.md.

## Risks

- **The caps can be outgrown.** The devel index is 8.0 MB against a 16 MiB cap, and it grows
  with the package count. Past the cap, `pkg_status` fails for everyone with `upstream_error`
  until the cap is raised. The failure is loud and the message names the URL and the byte
  count. The real fix is a per-package registry route (#13), which removes the 8 MB read.
  GitHub issue lists are 150 KB against 2 MiB. A repo with many very long issue bodies could
  reach 2 MiB (100 × 65,536-character bodies is about 6.5 MB). `ops_activity` would then report
  that repo as a per-repo error, not fail the call.
- **One cap for the whole registry.** `/checks` responses share the index's 16 MiB cap, so one
  concurrent `/checks` read can still hold up to 16 MiB. That bounds #28 main-1 but does not
  shrink it to the size of one file; the per-file route (#13) does.
- **Decoded size, not wire size.** The count is of decoded bytes, so a small gzip body that
  inflates is caught. No `Content-Length` pre-check: a large uncompressed body is streamed up to
  the cap before failing. Memory is not bounded by `maxBytes`. `readCapped` keeps every decoded
  chunk and then joins them, so the chunks and the joined string coexist. The count is checked
  after a chunk arrives. One read therefore peaks at about 2 × `maxBytes` plus one chunk (ASCII;
  more for text V8 stores at 2 bytes per character). `fetchUpstreamJson` then adds the parsed
  object while the body string is alive. For the registry's 16 MiB cap, one `/checks` read can
  peak near 32 MB of strings before parsing, and `/checks` loads are not shared like the index
  (`SharedLoads`), so a few concurrent callers approach the 128 MB isolate limit. Pick
  per-upstream caps on this basis (#47).
- **workerd streaming decode is verified by types, not by a run**, until the manual `npm run dev`
  check above.
- **Error precedence change (#36).** An oversized, off-schema result now reports `internal`, not
  `result_too_large`. Usage events show `internal` for such a bug. Both codes are server bugs, and
  the log line from the schema failure is more useful.
- **Message changes touch clients.** Error messages gain a trailing period and the GitHub 404
  wording changes. Error text is not part of a stable API (the REST API is unstable until v1), and
  codes do not change.
- **Edits to merged specs.** Specs #2, #6, #9 and #15 are rewritten in place, as #18 and #20 ask,
  so they keep describing the code. The PR table records why.
