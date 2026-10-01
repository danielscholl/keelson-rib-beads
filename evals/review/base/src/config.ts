export interface Config {
  port: number;
  uploadRoot: string;
  sessionTtlMs: number;
  cacheTtlMs: number;
  requireAuth: boolean;
  maxPageSize: number;
  retry: { max: number; baseMs: number };
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid integer: ${value}`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    port: int(env.PORT, 8080),
    uploadRoot: env.UPLOAD_ROOT ?? "/var/lib/ledgerd/uploads",
    sessionTtlMs: int(env.SESSION_TTL_MS, 30 * 60 * 1000),
    cacheTtlMs: int(env.CACHE_TTL_MS, 5000),
    // Auth stays on unless a developer turns it off for a local run.
    requireAuth: env.REQUIRE_AUTH !== "false",
    maxPageSize: int(env.MAX_PAGE_SIZE, 100),
    retry: { max: int(env.RETRY_MAX, 3), baseMs: int(env.RETRY_BASE_MS, 200) },
  };
}
