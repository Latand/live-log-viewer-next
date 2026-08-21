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
  /** Transient (#1087): the connector was respawned moments ago, so calls in
      that window can be dropped. Never persisted — it is projected from the
      restart state while the grace window is open. */
  | "restarting"
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

/** The connector seam adds one code the browser never receives verbatim: a call
    the supervisor's own respawn dropped (#1087). The status payload projects it
    as the `restarting` phase, so the panel's vocabulary above is unchanged. */
export type TelegramConnectorErrorCode = TelegramErrorCode | "connector_restarting";

/** Sanitized account identity: display name and public username only. */
export type TelegramIdentity = {
  name: string;
  username: string | null;
};

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
  /** Connector respawns the Viewer observed in the last 24 h, and when the
      last one happened (#1087). Structured counts only — no crash output. */
  restartsLast24h: number;
  lastRestartAt: string | null;
};

export const NONTERMINAL_TELEGRAM_LOGIN_PHASES: ReadonlySet<TelegramPhase> = new Set([
  "starting",
  "awaiting_scan",
  "awaiting_password",
  "verifying",
]);
