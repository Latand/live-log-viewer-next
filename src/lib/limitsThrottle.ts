import { LIMITS_RATE_LIMITED_REASON, type LimitsProvenance } from "@/lib/types";

type HostedEngine = "claude" | "codex";

function throttleProvenance(value: unknown): LimitsProvenance | null {
  if (!value || typeof value !== "object") return null;
  const provenance = value as Partial<LimitsProvenance>;
  if (provenance.reason !== LIMITS_RATE_LIMITED_REASON || typeof provenance.retryAt !== "string") return null;
  if (provenance.source !== "live" && provenance.source !== "transcript"
    && provenance.source !== "cache" && provenance.source !== "unavailable") return null;
  if (provenance.staleSince !== null && typeof provenance.staleSince !== "string") return null;
  return {
    source: provenance.source,
    reason: provenance.reason,
    staleSince: provenance.staleSince,
    retryAt: provenance.retryAt,
  };
}

/** Read the same persisted cache as `/api/limits` without importing its
    server-only probe graph into the client-safe quota projection module. */
export function cachedProviderThrottleProvenance(
  engine: HostedEngine,
  accountId: string,
): LimitsProvenance | null {
  const store = globalThis as typeof globalThis & {
    __llvLimitsCache?: { engines?: Partial<Record<HostedEngine, Record<string, { provenance?: unknown }>>> } | null;
  };
  const warm = throttleProvenance(store.__llvLimitsCache?.engines?.[engine]?.[accountId]?.provenance);
  if (warm) return warm;
  if (typeof window !== "undefined" || typeof process === "undefined") return null;

  const loadBuiltin = (process as typeof process & {
    getBuiltinModule?: (id: string) => unknown;
  }).getBuiltinModule;
  if (!loadBuiltin) return null;
  const fs = loadBuiltin("node:fs") as { readFileSync(pathname: string, encoding: "utf8"): string } | undefined;
  const os = loadBuiltin("node:os") as { homedir(): string } | undefined;
  const path = loadBuiltin("node:path") as {
    join(...parts: string[]): string;
    resolve(pathname: string): string;
  } | undefined;
  if (!fs || !os || !path) return null;

  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const override = process.env.LLV_STATE_DIR;
  const stateDir = override || path.join(
    configRoot,
    "agent-log-viewer",
    process.env.LLV_STAGING === "1" ? "state-staging" : "state",
  );
  if (process.env.LLV_STAGING === "1") {
    const resolved = path.resolve(stateDir);
    const productionDirs = [
      path.join(configRoot, "agent-log-viewer", "state"),
      path.join(configRoot, "live-log-viewer", "state"),
      path.join(os.homedir(), ".claude", "viewer-state"),
    ];
    if (productionDirs.some((candidate) => path.resolve(candidate) === resolved)) return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "limits-cache.json"), "utf8")) as {
      version?: unknown;
      engines?: Partial<Record<HostedEngine, Record<string, { provenance?: unknown }>>>;
    };
    if (parsed.version !== 2) return null;
    return throttleProvenance(parsed.engines?.[engine]?.[accountId]?.provenance);
  } catch {
    return null;
  }
}

/** A provider retry deadline is an estimate. Give the provider one ordinary
    refresh cadence to release the request before silence becomes a real stall. */
export const PROVIDER_THROTTLE_GRACE_MS = 60_000;

export interface ProviderThrottleState {
  reason: "provider_throttled";
  /** Normalized provider retry deadline. */
  retryAt: string;
}

/** The retry deadline while a limits rejection still explains provider-side
    silence. Once the bounded grace passes, callers resume ordinary stall
    classification even when an old cache entry has not refreshed yet. */
export function providerThrottleRetryAt(
  provenance: LimitsProvenance | null | undefined,
  now: number = Date.now(),
  graceMs: number = PROVIDER_THROTTLE_GRACE_MS,
): string | null {
  if (provenance?.reason !== LIMITS_RATE_LIMITED_REASON || !provenance.retryAt) return null;
  const retryAt = Date.parse(provenance.retryAt);
  if (!Number.isFinite(retryAt)) return null;
  const grace = Number.isFinite(graceMs) ? Math.max(0, graceMs) : PROVIDER_THROTTLE_GRACE_MS;
  if (now > retryAt + grace) return null;
  return new Date(retryAt).toISOString();
}

export function providerThrottleState(
  provenance: LimitsProvenance | null | undefined,
  now: number = Date.now(),
  graceMs: number = PROVIDER_THROTTLE_GRACE_MS,
): ProviderThrottleState | null {
  const retryAt = providerThrottleRetryAt(provenance, now, graceMs);
  return retryAt ? { reason: "provider_throttled", retryAt } : null;
}
