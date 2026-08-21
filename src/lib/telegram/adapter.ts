import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { TelegramErrorCode, TelegramIdentity } from "./contracts";
import { bridgeLaunchSpec, ensureConnectorProvisioned, telegramApiCredentials } from "./packaging";

/**
 * The Telegram seam (issue #1059): everything that actually talks to Telegram
 * sits behind this interface. Production spawns the Telethon enrollment bridge
 * (`bin/telegram-login-bridge.py`); tests install a fake, so no test can ever
 * reach a real account.
 *
 * Only sanitized values cross this interface — with one deliberate exception:
 * the `authorized` event carries the session string exactly once, from the
 * bridge pipe to the caller, whose only job is to hand it to the owner-only
 * store. Nothing here logs, throws, or re-emits it.
 */

export type TelegramEnrollmentEvent =
  | { type: "qr"; url: string; expiresAt: string }
  | { type: "password_required" }
  | { type: "password_invalid" }
  | { type: "verifying" }
  | { type: "authorized"; sessionString: string; identity: TelegramIdentity }
  | { type: "failed"; code: TelegramErrorCode };

export interface TelegramEnrollmentHandle {
  submitPassword(password: string): void;
  /** Terminates the enrollment process. Idempotent. */
  cancel(): void;
}

export type TelegramHealthResult =
  | { status: "connected"; identity: TelegramIdentity }
  | { status: "expired" }
  | { status: "error"; code: TelegramErrorCode };

export interface TelegramAdapter {
  /** Host configuration failures known before product-owned provisioning. */
  unavailableReason(): TelegramErrorCode | null;
  startEnrollment(onEvent: (event: TelegramEnrollmentEvent) => void): TelegramEnrollmentHandle;
  checkSession(sessionString: string): Promise<TelegramHealthResult>;
  logout(sessionString: string): Promise<{ ok: boolean; code: TelegramErrorCode | null }>;
}

const BRIDGE_CALL_TIMEOUT_MS = 60_000;

function identityOf(value: unknown): TelegramIdentity {
  const raw = (value && typeof value === "object" ? value : {}) as { name?: unknown; username?: unknown };
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : "Telegram account",
    username: typeof raw.username === "string" && raw.username ? raw.username : null,
  };
}

function sanitizedCode(value: unknown, fallback: TelegramErrorCode = "bridge_failed"): TelegramErrorCode {
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value as TelegramErrorCode : fallback;
}

function bridgeChild(command: "enroll" | "health" | "logout"): ChildProcessWithoutNullStreams | null {
  const credentials = telegramApiCredentials();
  if (!credentials) return null;
  const spec = bridgeLaunchSpec(command, credentials);
  try {
    return spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function parseEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** One short-lived bridge call (`health`/`logout`): session in via stdin, one
    event line out, always terminated, always resolved. */
async function bridgeCall(command: "health" | "logout", sessionString: string): Promise<Record<string, unknown> | null> {
  if (!await ensureConnectorProvisioned()) return null;
  return new Promise((resolve) => {
    const child = bridgeChild(command);
    if (!child) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (event: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(event);
    };
    const timer = setTimeout(() => finish(null), BRIDGE_CALL_TIMEOUT_MS);
    child.once("error", () => finish(null));
    child.once("close", () => finish(null));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseEvent(line);
      if (event?.event === command) finish(event);
    });
    child.stderr.on("data", () => undefined);
    try {
      child.stdin.write(JSON.stringify({ session: sessionString }) + "\n");
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

export const processTelegramAdapter: TelegramAdapter = {
  unavailableReason() {
    if (!telegramApiCredentials()) return "credentials_missing";
    return null;
  },

  startEnrollment(onEvent) {
    let done = false;
    let canceled = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    const emit = (event: TelegramEnrollmentEvent) => {
      if (done) return;
      if (event.type === "authorized" || event.type === "failed") done = true;
      onEvent(event);
    };
    void ensureConnectorProvisioned().then((provisioned) => {
      if (canceled || done) return;
      if (!provisioned) {
        emit({ type: "failed", code: "start_failed" });
        return;
      }
      child = bridgeChild("enroll");
      if (!child) {
        emit({ type: "failed", code: "start_failed" });
        return;
      }
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const raw = parseEvent(line);
        if (!raw) return;
        switch (raw.event) {
          case "qr":
            if (typeof raw.url === "string" && raw.url.startsWith("tg://login")) {
              emit({ type: "qr", url: raw.url, expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : new Date(Date.now() + 30_000).toISOString() });
            }
            return;
          case "password_required": emit({ type: "password_required" }); return;
          case "password_invalid": emit({ type: "password_invalid" }); return;
          case "verifying": emit({ type: "verifying" }); return;
          case "authorized":
            if (typeof raw.session === "string" && raw.session) {
              emit({ type: "authorized", sessionString: raw.session, identity: identityOf(raw.identity) });
            } else {
              emit({ type: "failed", code: "bridge_failed" });
            }
            return;
          case "failed": emit({ type: "failed", code: sanitizedCode(raw.code) }); return;
        }
      });
      child.stderr.on("data", () => undefined);
      child.once("error", () => emit({ type: "failed", code: "start_failed" }));
      child.once("close", () => emit({ type: "failed", code: "bridge_failed" }));
    }).catch(() => emit({ type: "failed", code: "start_failed" }));
    return {
      submitPassword(password: string) {
        try { child?.stdin.write(JSON.stringify({ password }) + "\n"); }
        catch { emit({ type: "failed", code: "bridge_failed" }); }
      },
      cancel() {
        canceled = true;
        done = true;
        try { child?.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* already gone */ } }, 2_000).unref?.();
      },
    };
  },

  async checkSession(sessionString) {
    const event = await bridgeCall("health", sessionString);
    if (!event) return { status: "error", code: "health_failed" };
    if (event.status === "connected") return { status: "connected", identity: identityOf(event.identity) };
    if (event.status === "expired") return { status: "expired" };
    return { status: "error", code: sanitizedCode(event.code, "health_failed") };
  },

  async logout(sessionString) {
    const event = await bridgeCall("logout", sessionString);
    if (!event) return { ok: false, code: "logout_failed" };
    if (event.ok === true) return { ok: true, code: null };
    return { ok: false, code: sanitizedCode(event.code, "logout_failed") };
  },
};
