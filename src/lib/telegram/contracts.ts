/**
 * Public contracts for the personal Telegram connector (issue #1059).
 *
 * Everything in this file may cross the browser boundary, so nothing here can
 * carry a session string, an API credential, or raw upstream error text. The
 * session value lives only in the owner-only store (`sessionStore.ts`) and the
 * enrollment pipe; the API and UI see status, an opaque credential reference,
 * and sanitized codes.
 */

/** The connection lifecycle, in the exact phases issue #1059 names. */
export type TelegramPhase =
  | "disconnected"
  | "starting"
  | "awaiting_scan"
  | "awaiting_password"
  | "verifying"
  | "connected"
  | "expired"
  | "error";

/** Sanitized failure vocabulary — the only error detail that leaves the server. */
export type TelegramErrorCode =
  | "credentials_missing"
  | "start_failed"
  | "bridge_failed"
  | "password_invalid"
  | "network_failed"
  | "timed_out"
  | "canceled"
  | "session_unsafe"
  | "connector_failed"
  | "host_registration_failed"
  | "not_read_only"
  | "logout_failed"
  | "health_failed";

/** Sanitized account identity: display name and public username only. This is
    the shape that crosses the browser boundary. */
export type TelegramIdentity = {
  name: string;
  username: string | null;
};

/**
 * The identity as it is RECORDED (issue #1091).
 *
 * Names and handles are the operator's to change at any moment; the numeric
 * Telegram user id is not, so it is what "the same account" actually means and
 * what the report-run verifier compares. It is recorded at Connect, kept in
 * owner-only `connection.json`, and deliberately absent from
 * {@link TelegramStatusPayload}: no surface outside the server has a use for
 * it, so it stays on the same side of the boundary as the credential.
 *
 * `id` is a decimal STRING because a Telegram id is a 64-bit integer and JSON
 * numbers are not. `null` is a pre-#1091 record that has not been upgraded yet.
 */
export type TelegramAccountIdentity = TelegramIdentity & {
  id: string | null;
};

/** Telegram user ids are positive integers; the marked form a connector
    returns for a user is the id itself. Anything else is not an id. */
export function validTelegramAccountId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[1-9]\d{0,18}$/.test(trimmed) ? trimmed : null;
}

/** A live login operation as the browser sees it. The QR url is the
    `tg://login` token Telegram mints for scanning — it is the one value that
    MUST reach the screen, and it grants nothing without the operator's phone
    approving it. */
export type TelegramLoginView = {
  operationId: string;
  qr: { url: string; expiresAt: string } | null;
  /** Set while awaiting_password after a rejected attempt, so the form can say
      "wrong password" without leaving the password phase. */
  passwordError: boolean;
};

export type TelegramStatusPayload = {
  phase: TelegramPhase;
  login: TelegramLoginView | null;
  identity: TelegramIdentity | null;
  /** Opaque reference to the stored credential; never the credential itself. */
  credentialRef: string | null;
  lastHealthCheckAt: string | null;
  error: { code: TelegramErrorCode } | null;
  /** Whether host API credentials (env or telegram.json) exist. A boolean
      only — the values themselves never cross this boundary (#1070). */
  credentialsConfigured: boolean;
};

export const NONTERMINAL_TELEGRAM_LOGIN_PHASES: ReadonlySet<TelegramPhase> = new Set([
  "starting",
  "awaiting_scan",
  "awaiting_password",
  "verifying",
]);
