import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordValue, stringValue } from "@/lib/scanner/json";

/** Same home the scanner uses for `grok-sessions`. */
export function grokHome(): string {
  const configured = process.env.LLV_GROK_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".grok");
}

export type GrokAuthSource = "session" | "api_key";

export interface GrokAuthStatus {
  signedIn: boolean;
  source: GrokAuthSource | null;
  expiresAt: string | null;
}

function entryExpiry(entry: Record<string, unknown>): number | null {
  const raw = stringValue(entry.expires_at);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionEntrySignedIn(entry: Record<string, unknown>, now: number): { signedIn: boolean; expiresAt: string | null } {
  const expires = entryExpiry(entry);
  if (expires !== null) {
    return {
      signedIn: expires > now,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  const hasSecret = (typeof entry.key === "string" && entry.key.length > 0)
    || (typeof entry.refresh_token === "string" && entry.refresh_token.length > 0);
  return { signedIn: hasSecret, expiresAt: null };
}

/** Local Grok CLI sign-in. Never returns tokens, emails, or account ids. */
export function grokAuthStatus(now = Date.now()): GrokAuthStatus {
  const authPath = path.join(grokHome(), "auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      /* Unreadable or malformed credentials are treated as signed out. */
    }
    parsed = null;
  }
  const file = recordValue(parsed);
  if (file) {
    let best: { signedIn: true; expiresAt: string | null } | null = null;
    for (const value of Object.values(file)) {
      const entry = recordValue(value);
      if (!entry) continue;
      const status = sessionEntrySignedIn(entry, now);
      if (!status.signedIn) continue;
      if (!best) {
        best = { signedIn: true, expiresAt: status.expiresAt };
        continue;
      }
      const previous = best.expiresAt ? Date.parse(best.expiresAt) : 0;
      const next = status.expiresAt ? Date.parse(status.expiresAt) : 0;
      if (next >= previous) best = { signedIn: true, expiresAt: status.expiresAt };
    }
    if (best) return { signedIn: true, source: "session", expiresAt: best.expiresAt };
  }
  if (process.env.XAI_API_KEY?.trim()) {
    return { signedIn: true, source: "api_key", expiresAt: null };
  }
  return { signedIn: false, source: null, expiresAt: null };
}
