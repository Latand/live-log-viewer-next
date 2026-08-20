# Issue #1059: QR account connection and packaged read-only Telegram MCP

The Viewer ships a first-class personal Telegram connector. The operator scans
a QR code from the left-rail footer, enters a 2FA password only when Telegram
asks for it, and sees explicit connected / expired / error states with remote
logout and local session deletion. The resulting MCP surface (`telegram`) is
read-only, served by one shared loopback process packaged with the Viewer from
the pinned `chigwell/telegram-mcp` v3.2.22 source, and granted only through the
existing #739 operator-root grant boundary. The separately configured legacy
transport (`telegram-readonly`) stays untouched. Daily Reports, write tools,
phone login, multi-account, chat rendering, a generic connector marketplace,
and legacy-credential migration are out of scope. No deployment in this task.

## Acceptance criteria

AC1: The pinned upstream source (release `v3.2.22`, commit
`a61294362226bd93052f5a40b4a1b1269a99ce69`, Apache-2.0) is vendored with its
dependency lock, license, provenance record, and per-file checksums, and ships
with the package (`files` includes `vendor`). Provisioning builds the connector
environment from that vendored tree with a frozen lock; no path resolves the
`telegram-mcp` name through a package index, and a clean installation needs no
manually cloned checkout.

AC2: One shared streamable-HTTP connector runs on loopback with
`TELEGRAM_EXPOSED_TOOLS=read-only`. Before the connector is treated as ready —
whether newly spawned or adopted from a previous Viewer generation via the
persisted pid record — every advertised tool must carry `readOnlyHint: true`;
every tool name must also belong to the audited read allowlist. A surface that
violates either bound is refused and reported as `not_read_only`. The HTTP
endpoint requires a per-credential bearer token. Adoption also proves the PID,
portable start identity, exact executable/entrypoint, credential generation,
pre-auth challenge response, and token-derived server identity. Each readiness
probe has its own bounded timeout inside the overall startup deadline; a
stalled probe terminates the spawned connector.

AC3: The login operation follows the account-login pattern: at most one
operation at a time, phases `disconnected → starting → awaiting_scan →
(awaiting_password) → verifying → connected | expired | error`. An expired QR
token refreshes automatically within the same operation. The 2FA password is
requested only when Telegram asks; an invalid password is an explicit state
that allows retry. Cancellation terminates the enrollment process and clears
temporary state, including a credential written before connector verification.
Lifecycle generations prevent stale enrollment/health results from restoring
state or processes after cancel, logout, or local deletion. Enrollment,
health, and logout share the vendored per-session process lock; health/logout
release the shared connector before their short-lived bridge connects. Logout
advances the generation again when remote revocation settles, invalidating
health checks that began during the revocation wait.

AC4: The session persists server-side only: an owner-only (0600, dir 0700)
regular non-symlinked file written atomically under Viewer state. Reads,
overwrites, and deletion refuse symlinks, widened file/directory modes, and
foreign ownership. Status
surfaces carry an opaque `credentialRef` only. The session string appears in no
API payload, log line, process argument, transcript, fixture, or served client
payload; focused secret-leak tests prove the API and argv paths with a
placeholder session. The connector bearer token is a separate 0600 secret,
rotates with `credentialRef`, and appears in no config file, argv, or API body.
Corrupt/unreadable session data reports `session_unsafe`, remains preserved for
explicit local deletion, and never produces a successful remote logout.
An overwrite preflights both credential files and restores the previous token
if the second write fails, preserving the existing pair byte-for-byte.

AC5: `Log out` performs remote revocation and then removes the local session,
stops the connector, and unregisters the host definition. A failed remote
logout preserves the local session and reports a sanitized code. `Delete local
session` removes local credentials and stops the connector without the remote
side, and its inline confirmation states that the remote authorization may
remain. Both actions require inline confirmation.

AC6: On connect, the shared URL is registered idempotently as `telegram` for
Claude (legacy and managed `.claude.json` state files) and Codex (a
marker-delimited block in the legacy `config.toml`, which managed homes
symlink). Registration never rewrites corrupt or symlinked targets, never
touches the legacy `telegram-readonly` entry, and backs off from an
operator-authored `telegram` definition. Disconnect removes exactly the
managed entry, so the next dispatch materializes nothing. Managed Claude and
Codex HTTP definitions obtain bearer authorization from an environment
variable present only in granted operator-root launches. Existing corrupt
Codex TOML is byte-unchanged, including valid quoted-key conflicts. Host
registration returns one aggregate result; every required definition must be
installed before `connected` is published. Successful health recovery
re-registers both hosts.

AC7: The #739 boundary extends by exactly one name: `telegram` joins
`GRANTABLE_MCP_SERVERS` and the operator-root default; the delegated default
stays `["viewer"]`. Builders, reviewers, pipeline stages, delegated children,
and unproven adopted sessions cannot obtain the grant, and hand-edited
profiles are re-bounded — proven by the existing #739 test walls updated for
tranche 2. Tmux and both structured host implementations load the bearer token
only for a proven `telegram` grant; delegated hosts scrub it. Missing local
enrollment state leaves operator-root launches usable with Telegram unavailable.

AC8: The UI is a Telegram row in the left-rail footer beside the account
controls, opening the accounts-style flyout (desktop) / bottom sheet (mobile):
client-rendered QR via the existing `qrcode` dependency, Cancel / Retry /
Reconnect, an uncontrolled password input cleared before submission and across
phase changes, inline destructive confirmations, an `aria-live` status region,
connected identity (name and username only), last health check time, and
human-readable sanitized errors in en and uk. Retry uses fresh health recovery
when an existing credential is available and starts QR enrollment otherwise.
Client-side QR rendering failures show a localized alert and retry the current
Telegram token without restarting enrollment.

AC9: Health checks report connected / expired / error explicitly: `expired`
stops the connector and keeps Reconnect plus local deletion available;
transient probe failures are an error state, never a silent disconnect; an
unsafe session file reads as `session_unsafe`. Initial and fresh polling
failures are visible, and request sequencing prevents slow responses from
overwriting newer status. Entering a live login phase immediately switches to
the 1.5-second cadence; connected and credential-backed error polling performs
fresh health and connector recovery on the idle cadence and at client startup.
Stateful `fresh=1` health requests enforce the same-origin gate before service
access; the observational status GET remains read-only.

AC9a: The vendored `get_chats` and `list_chats` read tools reject boolean,
zero, negative, and oversized pagination values before Telegram I/O. Dialog
responses are capped at 100 results; `get_chats` accepts at most 10 pages and
uses a bounded API limit of at most 1000 instead of downloading the full dialog
list.

AC10: Focused tests run with isolated `LLV_STATE_DIR` (and temp homes where
paths matter) and a fake Telegram adapter — no test reaches a real account,
the operator registry, or live runtime state. Typecheck and the
privacy-publication gate pass. Desktop and 390 px screenshots of the mocked
disconnected, QR, password, connected, expired, error, and destructive
confirmation states carry no real identity. Focused DOM tests prove the 2FA
field never stores its value in React state and clears at the required seams.

AC11: Scope holds to `src/lib/telegram/*`, `src/app/api/telegram/*`,
`src/components/TelegramConnect.tsx`, `src/hooks/useTelegramConnection.ts`, the
footer row mount, the tranche-2 allowlist and CLI grant propagation with their
test updates, i18n keys, packaging manifest entries,
`bin/telegram-login-bridge.py`, `bin/provision-telegram-connector.mjs`,
`bin/telegram-mcp-server.py`,
`vendor/telegram-mcp/`, evidence, and this spec. No VPS, OpenClaw,
morning-digest, or real Telegram credential/session is touched; no deploy.
