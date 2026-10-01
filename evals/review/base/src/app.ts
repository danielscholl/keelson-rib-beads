import { Sessions } from "./auth.ts";
import { TtlCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import type { Deps, Summary } from "./handlers.ts";
import { InvoiceStore } from "./store.ts";

export function buildDeps(env: Record<string, string | undefined>, gateway: Gateway): Deps {
  const config = loadConfig(env);
  return {
    config,
    sessions: new Sessions(config.sessionTtlMs),
    store: new InvoiceStore(),
    cache: new TtlCache<Summary>(config.cacheTtlMs),
    gateway,
    now: Date.now,
  };
}
