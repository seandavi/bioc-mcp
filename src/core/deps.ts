import type { UpstreamCache } from '../upstreams/cache';

/** Takes a Request so the Worker can pass a wrapper around the global fetch. */
export type FetchFn = (request: Request) => Promise<Response>;

export interface CapabilityEnv {
  readonly GITHUB_TOKEN?: string | undefined;
}

export interface Deps {
  fetch: FetchFn;
  cache: UpstreamCache;
  now: () => Date;
  env: CapabilityEnv;
}
