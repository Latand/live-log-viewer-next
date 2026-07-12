export const MODEL_REGISTRY_VERSION = "2026-07-10";

interface RegistryEntry {
  standard: number;
  extended?: number;
}

const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_THOUSAND = 200_000;

/** Official-doc snapshot. Exact keys keep future model revisions unknown until
    the registry is deliberately updated and its version is bumped. */
const MODEL_REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  "fable-5": { standard: ONE_MILLION },
  "mythos-5": { standard: ONE_MILLION },
  "mythos-preview": { standard: ONE_MILLION },
  "opus-4-8": { standard: ONE_MILLION },
  "opus-4-7": { standard: ONE_MILLION },
  "opus-4-6": { standard: ONE_MILLION },
  "sonnet-5": { standard: ONE_MILLION },
  "sonnet-4-6": { standard: ONE_MILLION },
  "haiku-4-5": { standard: TWO_HUNDRED_THOUSAND },
  "opus-4-5": { standard: TWO_HUNDRED_THOUSAND },
  "opus-4-1": { standard: TWO_HUNDRED_THOUSAND },
  "sonnet-4-5": { standard: TWO_HUNDRED_THOUSAND, extended: ONE_MILLION },
  "sonnet-4-0": { standard: TWO_HUNDRED_THOUSAND, extended: ONE_MILLION },
};

export type ModelContextMode = "standard" | "1m";

export function normalizeModelKey(raw: string): { key: string; mode: ModelContextMode } | null {
  let value = raw.toLowerCase().trim();
  if (!value || value === "<synthetic>") return null;

  const tagged1m = /\[1m\]$/.test(value);
  if (tagged1m) value = value.replace(/\[1m\]$/, "");
  value = value.replace(/^(?:us\.|eu\.)?anthropic\./, "");
  value = value.replace(/@20\d{6}$/, "");
  value = value.replace(/-v\d+(?::\d+)?$/, "");
  value = value.replace(/-20\d{6}$/, "");
  value = value.replace(/^claude-/, "");
  if (!value) return null;
  return { key: value, mode: tagged1m ? "1m" : "standard" };
}

export function registryWindow(key: string, mode: ModelContextMode): number | null {
  const entry = MODEL_REGISTRY[key];
  if (!entry) return null;
  return mode === "1m" ? (entry.extended ?? ONE_MILLION) : entry.standard;
}
