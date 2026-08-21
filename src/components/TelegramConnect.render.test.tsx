import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TelegramConnectionState } from "@/hooks/useTelegramConnection";
import type { TelegramStatusPayload } from "@/lib/telegram/contracts";

import { TelegramPanel } from "./TelegramConnect";

function stateFor(status: Partial<TelegramStatusPayload>, failure: { code: string } | null = null): TelegramConnectionState {
  return {
    status: {
      phase: "disconnected",
      login: null,
      identity: null,
      credentialRef: null,
      credentialsConfigured: true,
      lastHealthCheckAt: null,
      error: null,
      restartsLast24h: 0,
      lastRestartAt: null,
      ...status,
    },
    busy: false,
    failure,
    refresh: async () => {},
    connect: async () => {},
    submitPassword: async () => {},
    cancel: async () => {},
    logout: async () => {},
    deleteLocal: async () => {},
    saveCredentials: async () => {},
  };
}

const render = (status: Partial<TelegramStatusPayload>, failure: { code: string } | null = null) =>
  renderToStaticMarkup(<TelegramPanel state={stateFor(status, failure)} onClose={() => {}} />);

test("disconnected offers Connect and explains local-only storage", () => {
  const html = render({ phase: "disconnected" });
  expect(html).toContain("Not connected");
  expect(html).toContain("Connect Telegram");
  expect(html).toContain("Read-only · operator sessions only");
});

test("#1070: missing host credentials render the inline api_id/api_hash form instead of a dead end", () => {
  const html = render({ phase: "disconnected", credentialsConfigured: false });
  expect(html).toContain("API ID");
  expect(html).toContain("API hash");
  expect(html).toContain("Save credentials");
  expect(html).toContain("my.telegram.org");
  expect(html).not.toContain("Connect Telegram");
});

test("#1070: the credentials_missing error also gets the form, and configured hosts keep plain Connect", () => {
  const errorHtml = render({ phase: "error", error: { code: "credentials_missing" }, credentialsConfigured: false });
  expect(errorHtml).toContain("Save credentials");
  /* The error card's Retry would restart enrollment without credentials;
     while the form is up it stays hidden. */
  expect(errorHtml).not.toContain(">Retry<");
  const configured = render({ phase: "disconnected", credentialsConfigured: true });
  expect(configured).toContain("Connect Telegram");
  expect(configured).not.toContain("Save credentials");
});

test("the panel reuses the accounts flyout anchoring and the mobile sheet", () => {
  const html = render({ phase: "disconnected" });
  expect(html).toContain("sm:left-full");
  expect(html).toContain("sm:bottom-1");
  expect(html.indexOf("sm:hidden")).toBeLessThan(html.indexOf('role="dialog"'));
  expect(html).toContain('aria-live="polite"');
});

test("awaiting_scan shows the QR slot, the refresh hint, and Cancel", () => {
  const html = render({
    phase: "awaiting_scan",
    login: { operationId: "op-1", qr: { url: "tg://login?token=abc", expiresAt: "2026-08-20T12:00:30.000Z" }, passwordError: false },
  });
  expect(html).toContain("Scan the QR code");
  expect(html).toContain("refreshes automatically");
  expect(html).toContain("Cancel");
  /* The static render carries the placeholder; the client swaps in the drawn
     QR — the token url itself is never rendered as text. */
  expect(html).toContain("generating QR");
});

test("awaiting_password renders a password input, hint, and Cancel; an invalid try says so", () => {
  const html = render({
    phase: "awaiting_password",
    login: { operationId: "op-1", qr: null, passwordError: false },
  });
  expect(html).toContain('type="password"');
  expect(html).toContain("Two-step verification password");
  expect(html).toContain("Cancel");
  expect(html).not.toContain("Wrong password");

  const invalid = render({
    phase: "awaiting_password",
    login: { operationId: "op-1", qr: null, passwordError: true },
  });
  expect(invalid).toContain("Wrong password. Try again.");
});

test("connected shows identity, health time, and both destructive actions unarmed", () => {
  const html = render({
    phase: "connected",
    identity: { name: "Account A", username: "account_a" },
    credentialRef: "credential-ref-placeholder",
    lastHealthCheckAt: "2026-08-20T10:04:00.000Z",
  });
  expect(html).toContain("Connected as");
  expect(html).toContain("Account A");
  expect(html).toContain("@account_a");
  expect(html).toContain("Checked");
  expect(html).toContain("Log out");
  expect(html).toContain("Delete local session");
  /* Destructive prompts only appear after arming. */
  expect(html).not.toContain("Log out of Telegram");
  expect(html).not.toContain("may remain");
});

test("expired offers Reconnect and local deletion, never remote logout", () => {
  const html = render({
    phase: "expired",
    identity: { name: "Account A", username: null },
    credentialRef: "credential-ref-placeholder",
  });
  expect(html).toContain("Session expired");
  expect(html).toContain("Reconnect");
  expect(html).toContain("Delete local session");
  expect(html).not.toContain("Log out<");
});

test("error renders the sanitized message and Retry; codes never leak raw text", () => {
  const html = render({ phase: "error", error: { code: "network_failed" } });
  expect(html).toContain("Network error. Try again.");
  expect(html).toContain("Retry");

  const refused = render({ phase: "error", error: { code: "not_read_only" } });
  expect(refused).toContain("not read-only");
});

test("an error over a stored session keeps local deletion reachable", () => {
  const html = render({
    phase: "error",
    error: { code: "logout_failed" },
    credentialRef: "credential-ref-placeholder",
  });
  expect(html).toContain("Remote logout failed");
  expect(html).toContain("Delete local session");
});

test("an unsafe session always offers local deletion and suppresses remote logout", () => {
  const html = render({ phase: "error", error: { code: "session_unsafe" }, credentialRef: null });
    expect(html).toContain("Local session storage failed safety checks.");
  expect(html).toContain("Delete local session");
  expect(html).not.toContain("Log out<");
});

test("a failed action renders an actionable alert instead of silence", () => {
  /* A rejected request over a still-disconnected panel: without the alert the
     screen would look untouched. */
  const generic = render({ phase: "disconnected" }, { code: "action_failed" });
  expect(generic).toContain('role="alert"');
  expect(generic).toContain("Try again");
  expect(generic).toContain("Connect Telegram");

  /* Known backend codes keep their specific message. */
  const busyHtml = render({ phase: "disconnected" }, { code: "login_busy" });
  expect(busyHtml).toContain("already in progress");

  /* A transport failure says the server was unreachable. (The static render
     HTML-escapes apostrophes, so the fragment avoids one.) */
  const transport = render({ phase: "connected", identity: { name: "Account A", username: null } }, { code: "transport" });
  expect(transport).toContain("Check the connection and try again");

  /* No failure, no alert chrome. */
  expect(render({ phase: "disconnected" })).not.toContain('role="alert"');
});
