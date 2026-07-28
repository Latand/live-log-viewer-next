import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

/**
 * The operator's BROWSER session — the durable half of operator authority.
 *
 * The startup-link credential (`operatorSession.ts`) authorizes exactly one thing
 * well: the tab that opened the link. That is what its carriers can express — a
 * URL fragment and per-tab `sessionStorage` — and hosted acceptance showed it is
 * the wrong scope for the requirement: the operator's ALREADY-OPEN tab held no
 * credential, every new tab starts from nothing, and every server restart mints a
 * new secret, so the operator kept losing the voice controls to plumbing.
 *
 * So visiting the one-time link now also establishes a browser-scoped session:
 * the server mints a random token, returns it ONLY as an `httpOnly`,
 * `SameSite=Strict` cookie, and remembers its SHA-256 digest. The cookie
 * authorizes every tab of that browser profile automatically, is invisible to
 * page JavaScript entirely, and — because only the digest is persisted — survives
 * a server restart without a usable bearer ever touching disk.
 *
 * The threat model that shaped `operatorSession.ts` still binds, clause by clause:
 *
 * - the token appears in no response BODY, no log line, and no file — the
 *   `Set-Cookie` header goes only to the browser that just presented the startup
 *   link over loopback;
 * - the persisted store holds sha256 digests, which name a token without
 *   granting it: a worker reading the state dir (every worker can) learns nothing
 *   it can present;
 * - a local process without the browser's cookie jar gains no authority, and the
 *   jar itself is the same operator-uid boundary every browser secret already
 *   lives behind;
 * - `SameSite=Strict` keeps foreign origins from riding the cookie, and the
 *   backend guard (`realtimeInjection.ts`) is untouched — this changes how the
 *   operator PROVES themselves, never what anyone may do.
 */

export const OPERATOR_SESSION_COOKIE = "llv_operator_session";

/** Long-lived on purpose: the cookie's whole job is to outlive tabs and stage
    refreshes. Revocation is deleting the digest store (or restarting after doing
    so); the cap below keeps the population small enough for that to be real. */
export const OPERATOR_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const STORE_FILE = "operator-browser-sessions.json";

/** Every link visit mints a fresh token, so a handful of browsers (desktop,
    phone, a re-opened profile) coexist; beyond that the oldest is retired. */
const MAX_SESSIONS = 8;

const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/** In-memory view of the digest store; `null` until first read so a fresh
    process rehydrates from disk — that rehydration IS the restart survival. */
let digests: string[] | null = null;

function storeFile(): string {
  return statePath(STORE_FILE);
}

function load(): string[] {
  if (digests) return digests;
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8")) as { digests?: unknown };
    digests = Array.isArray(parsed.digests)
      ? parsed.digests.filter((entry): entry is string => typeof entry === "string" && DIGEST_SHAPE.test(entry))
      : [];
  } catch {
    digests = [];
  }
  return digests;
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), `${JSON.stringify({ digests: load() }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* Disk refused: this process still honors the session from memory; it will
       simply not survive the next restart. */
  }
}

function digestOf(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a browser session. Returns the token exactly once, for the Set-Cookie
    header and nothing else; only its digest is kept. */
export function establishOperatorBrowserSession(): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const known = load();
  known.push(digestOf(token));
  while (known.length > MAX_SESSIONS) known.shift();
  persist();
  return token;
}

/** Whether a presented cookie token names an established session. Hashing first
    makes the comparison structure-free; the digest compare is constant-time. */
export function matchesOperatorBrowserSession(token: string): boolean {
  if (!token) return false;
  const presented = Buffer.from(digestOf(token), "hex");
  return load().some((known) => {
    const expected = Buffer.from(known, "hex");
    return expected.byteLength === presented.byteLength && crypto.timingSafeEqual(expected, presented);
  });
}

/** Tests only: drop the in-memory view so the next call re-reads the store —
    which is also how a "server restart" is simulated. */
export function resetOperatorBrowserSessionsForTests(): void {
  digests = null;
}
