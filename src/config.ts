export interface AppConfig {
  allowedHosts: string[];
  allowedOrigins: string[];
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Splits on ',', trims, drops empties. Throws if ALLOWED_HOSTS yields no hosts (fail closed). */
export function parseConfig(env: { ALLOWED_HOSTS?: string; ALLOWED_ORIGINS?: string }): AppConfig {
  const allowedHosts = splitList(env.ALLOWED_HOSTS);
  if (allowedHosts.length === 0) {
    throw new Error('ALLOWED_HOSTS must list at least one hostname (comma-separated); refusing to start open');
  }
  return { allowedHosts, allowedOrigins: splitList(env.ALLOWED_ORIGINS) };
}
