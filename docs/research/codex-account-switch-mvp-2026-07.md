# Codex multi-account switching — MVP design (issue #40, urgent slice)

**Date:** 2026-07-09 · **Author:** Fable architect session · **Status:** design, review-ready
**Scope:** Codex only. Claude account parity and UI polish are explicitly deferred (see §12).

This document is the implementation contract for the expedited Codex-first slice of
issue #40: named account homes, safe registration of the existing account, a shared
skills/config overlay, an active-account selector, `accountId` on fresh and resume
spawns, per-pane `CODEX_HOME`, dynamic scanner roots, and a tracked
`codex login --device-auth` pane. Running panes keep their account. Secrets never
enter logs or browser payloads.

---

## 1. Verified grounding (all checked live on this machine, 2026-07-09)

Everything below was verified against the installed toolchain; none of it is assumed
from training data.

**Codex CLI 0.144.0** (`~/.bun/bin/codex` → `@openai/codex` bun global, native binary at
`@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`):

- `CODEX_HOME` is honored by the native binary (59 string references: sessions, skills,
  themes, log dir, "sqlite home", MCP OAuth, `"failed to canonicalize CODEX_HOME"`).
  The binary **canonicalizes** the path — account homes must not themselves sit behind
  symlinks or the sessions paths the scanner sees will differ from the ones it built.
- `codex login --device-auth` exists (in `codex login --help`) and the binary carries a
  `ChatgptDeviceCode` auth mode with `user_code`. Official docs (learn.chatgpt.com/docs/auth)
  describe it: run the command, get a one-time code, finish sign-in in a browser —
  designed for headless machines, which is exactly our tmux-pane flow.
- `codex login status` exits `0` when logged in, `1` when not — a cheap, token-free
  auth probe.
- **Live overlay probe** (scratch `CODEX_HOME` with `skills/`, `prompts/`, `config.toml`
  symlinked to `~/.codex`): `codex login status` said **"Not logged in"** while
  `~/.codex` was logged in — auth is fully home-scoped. `codex doctor` under the same
  overlay **parsed the symlinked `config.toml`** (model, 10 MCP servers, feature flags
  all resolved), reported `auth file` / `log dir` / `state DB` / `active rollouts` all
  scoped **inside the overlay**, and left every symlink intact with zero files written.
  Symlink traversal for shared subpaths works.
- Codex **refuses to create its helper "PATH alias" binaries when `CODEX_HOME` is under
  `/tmp`** (warning observed in the probe). Account homes must live under a real
  directory — ours live under `~/.config/agent-log-viewer/`, which is fine.
- Auth storage is configurable: `cli_auth_credentials_store = file | keyring | auto`
  (official docs). `codex doctor` shows this machine resolves to **File**. A keyring
  store would silently break per-home isolation, so managed logins pin it (§7.3).
- `config.toml` **is written by the CLI** (`projects.<path>.trust_level` entries — our
  live config has ~20 of them). Sharing it by symlink therefore carries a
  write-behavior question, handled in §7.2.
- Official docs on multi-account: *"No built-in account switching exists — you must log
  out and back in."* This feature fills that gap; there is no upstream mechanism to
  reuse.
- Official docs on token refresh: sessions auto-refresh tokens before expiry during
  active use; refreshed tokens are persisted back to the home's `auth.json`. Copying
  cached credentials to another machine is an officially sanctioned headless option,
  so a copied `auth.json` is not instantly revoked — but concurrent divergent rotation
  of two copies is undocumented, which drives invariant **I2** (§5).

**Local credential layout:** `~/.codex/auth.json` is mode `0600`, owner-only, containing
`auth_mode` + `tokens {id_token, access_token, refresh_token, account_id}` (shape per
issue #40; the viewer already reads a subset in `src/lib/codexAuth.ts` for dictation).

**Viewer runtime (Docker Compose, prod on 127.0.0.1:8898):**

- The container bind-mounts `/home/latand` at the **same path**, so account homes under
  `~/.config/agent-log-viewer/` and symlink targets under `~/.codex` resolve identically
  inside and outside the container.
- Spawning works by **typing a command into a host tmux pane**: the in-container `tmux`
  wrapper (Dockerfile) nsenters to the host tmux and rewrites `send-keys … -l` text
  (shim paths → host binary paths). Container environment variables therefore **do not
  reach the pane**; the only reliable env channel is the typed command text itself.
  `CODEX_HOME=<home> codex …` as a command prefix travels through the wrapper's `sed`
  untouched (it only rewrites `/usr/local/bin/{claude,codex,…}` occurrences) and lands
  on the host shell verbatim. This is the load-bearing propagation fact of the design.
- `resolveBinary("codex")` returns `/usr/local/bin/codex` under
  `LLV_DOCKER_NSENTER_SHIMS=1` (`src/lib/agent/cli.ts:20`); the tmux wrapper rewrites it
  to `/home/latand/.bun/bin/codex` before it reaches the pane. Unchanged by this design.
- Next.js docs note: this worktree has no `node_modules` yet. Per `AGENTS.md`, the
  implementer must `bun install` and read the route-handler guide under
  `node_modules/next/dist/docs/` before writing the new API routes.

---

## 2. Design overview

One new **deep module** owns every fact about Codex accounts — layout, store, overlay
construction, ownership resolution — behind a small interface:
`src/lib/accounts/codex.ts`. Everything else (spec builders, scanner roots, API routes,
UI) consumes that interface and stays shallow. No other file may know what an account
home looks like on disk.

```
~/.codex/                                        ← "default" account home (by reference, untouched)
~/.config/agent-log-viewer/accounts/codex/<id>/  ← managed account homes (overlays)
    auth.json            real, written by codex itself (0600)
    sessions/            real, per-account rollouts (scanner root)
    history.jsonl, log/, *.sqlite, .tmp/         real, per-account, created by codex on demand
    skills/    -> ~/.codex/skills                symlink, shared
    prompts/   -> ~/.codex/prompts               symlink, shared
    config.toml-> ~/.codex/config.toml           symlink, shared (see §7.2)
    AGENTS.md  -> ~/.codex/AGENTS.md             symlink, shared global guidance
~/.config/agent-log-viewer/state/codex-accounts.json   ← registry (viewer-owned, no secrets)
```

**Spawn-time contract:** every codex command the viewer types into a pane carries an
explicit `CODEX_HOME='<home>'` prefix — for the default account too. Explicitness
protects against a user-shell `export CODEX_HOME` overriding spawns, and makes the
account auditable in `/proc/<pid>/environ` and pane scrollback (the path is public;
the tokens never appear anywhere).

**Account selection:** fresh spawns take an optional `accountId` (falling back to the
persisted active account). Resumes **derive** the account from which home's `sessions/`
contains the transcript — the session physically lives in one home and `codex resume
<id>` can only find it there, so resume account is a pure function of the file; the
selector plays no part in it. Running panes are untouched by switches because the env is baked into the
typed command at boot; nothing re-reads the selector afterwards.

---

## 3. Vocabulary

- **Account home** — a directory codex treats as `CODEX_HOME`.
- **Legacy account** — the reserved id `default`, whose home is `~/.codex` *by
  reference*. Registration copies nothing; this is the "safe existing-account import".
- **Managed account** — a viewer-created overlay home under the accounts root.
- **Overlay** — a managed home: real credential/session state, symlinked shared state.
- **Owning home** — for a session transcript, the account home whose `sessions/`
  subtree contains it.
- **Active account** — the id new fresh spawns default to; a single persisted value.

---

## 4. Deep interface: `src/lib/accounts/codex.ts`

```ts
export interface CodexAccount {
  id: string;                    // "default" | /^[a-z0-9][a-z0-9-]{0,31}$/
  label: string;                 // user-visible, free text
  kind: "legacy" | "managed";
  home: string;                  // absolute; legacy → ~/.codex
  sessionsDir: string;           // home + "/sessions"
  authPresent: boolean;          // fs.stat of auth.json; the file itself stays unopened
  loginPane: { paneId: string; windowName: string } | null;  // pending device-auth pane
  createdAt: number;
}

/** Registry + active id. Always contains "default". Corrupt/missing store file
    degrades to the default-only registry (logged once); it never throws into the
    scanner or a route. */
export function listCodexAccounts(): CodexAccount[];
export function activeCodexAccountId(): string;   // dangling active id falls back to "default"
export function setActiveCodexAccount(id: string): void;      // throws UnknownAccountError

/** Resolution used by spec builders. `requested` comes from the API body; null/undefined
    means "use active". Throws UnknownAccountError (mapped to HTTP 400 by routes). */
export function accountForSpawn(requested?: string | null): { id: string; home: string };

/** Which account home's sessions/ contains this path; null when none does.
    Compares realpaths, mirrors pathAllowed()'s containment discipline. */
export function codexHomeOwningSessionPath(pathname: string): string | null;

/** All session roots for the scanner: [~/.codex/sessions, ...managed sessionsDirs].
    Existence is NOT required here — discover.ts already skips missing roots. */
export function codexSessionRoots(): string[];

/** Builds the overlay skeleton (0700 home, symlinks per §2), registers the account
    as authPresent:false, and returns it. Partial failure removes the partial dir and
    rethrows — the registry never lists a home that does not exist. Duplicate label is
    allowed; duplicate id is generated away (slug + numeric suffix). */
export function createManagedCodexAccount(label: string): CodexAccount;

export class UnknownAccountError extends Error {}
```

**Information hiding:** the store path (`statePath("codex-accounts.json")`), the
accounts root (`path.join(configRoot(), "agent-log-viewer", "accounts", "codex")`),
the overlay symlink set, and the id→path mapping are all private. Tests override the
legacy home via a `LLV_CODEX_HOME` env var (same pattern as `LLV_STATE_DIR` in
`src/lib/configDir.ts:115`), so no test touches the real `~/.codex`.

**Registry file** (`state/codex-accounts.json`, no secrets — ids, labels, timestamps,
pane ids only):

```json
{ "version": 1, "active": "default",
  "accounts": [
    { "id": "default", "label": "Main", "kind": "legacy", "createdAt": 0 },
    { "id": "work", "label": "Work", "kind": "managed", "createdAt": 1783982000000,
      "loginPane": { "paneId": "%42", "windowName": "codex-login" } } ] }
```

**Error modes, enumerated:**

| Condition | Behavior |
|---|---|
| store file missing/corrupt | default-only registry, `console.error` once, keep serving |
| `active` names a deleted account | resolve as `default`; next `setActive` heals the file |
| requested spawn id unknown | `UnknownAccountError` → HTTP 400 with the id echoed (id is not secret) |
| managed id fails `/^[a-z0-9][a-z0-9-]{0,31}$/` or its resolved home escapes the accounts root | account is dropped at load with an error log — belt over the slug regex; `id="default"` in a managed record is likewise dropped |
| overlay creation half-fails | `fs.rmSync(home, {recursive, force})` then rethrow; nothing registered |
| `~/.codex/auth.json` absent | `default` stays listed with `authPresent:false`; spawning under it is allowed (codex itself shows its login prompt in the pane — same behavior as today) |

---

## 5. Invariants

- **I1 — One id, one home.** `id → home` is a pure function; `default ⇄ ~/.codex`.
  Managed homes are always directly under the accounts root (realpath-checked).
- **I2 — One live home per ChatGPT account.** The viewer never copies `auth.json`.
  The existing account is registered *by reference*; new accounts are created only by
  device login into a fresh home. This sidesteps refresh-token rotation divergence
  entirely (§8): every refresh token on disk is the only live copy of itself.
- **I3 — Overlay shape.** Managed homes: real `auth.json`/`sessions/` and other
  codex-written state; symlinked `skills/`, `prompts/`, `config.toml`, `AGENTS.md`.
  The viewer creates only the home dir (0700) and the symlinks; codex creates
  everything else itself with its own modes (auth.json arrives 0600, as verified).
- **I4 — Explicit env, always.** Every codex command in `freshSpecFor`/`resumeSpecFor`
  output starts with `CODEX_HOME='<home>'`, default account included.
- **I5 — Boot-time account fixation.** A pane's account is decided when its command is
  typed; switching the active account, renaming labels, or deleting the registry never
  alters a running pane. (Holds by construction: nothing after boot rewrites pane env.)
- **I6 — Resume follows ownership.** `resumeSpecFor` derives the home from
  `codexHomeOwningSessionPath(transcript)`. A request that also carries an `accountId`
  disagreeing with ownership is rejected (409); silent re-homing is forbidden —
  `codex resume` would fail to find the rollout under any other home.
- **I7 — Scanner totality.** The set of codex scanner roots equals the set of account
  `sessionsDir`s. `pathAllowed`/`transcriptAllowed` accept exactly that union (plus the
  existing claude roots). Live and dead checkouts keep grouping by cwd exactly as
  before — account homes only add roots; inventing a second project-naming scheme is
  forbidden (AGENTS.md invariant untouched; `describe.ts` stays unmodified).
- **I8 — Zero token bytes.** Account-feature code never opens `auth.json` (existence
  `stat` only). API responses carry ids/labels/booleans; event log entries carry
  target/cwd/path/result as today (`logEvent` in `src/lib/tmux.ts` already omits
  command text). No new logging of command strings.
- **I9 — Real filesystem home.** Account homes live under the XDG config root, never
  under `/tmp` (codex refuses helper binaries there; scratch dirs also get wiped).

---

## 6. Changes by file (exact seams)

### 6.1 `src/lib/agent/cli.ts`

- `FreshSpecOptions` gains `codexHome?: string | null`. In the codex branch of
  `freshSpecFor` (`cli.ts:99`), prepend the env assignment to the assembled command:
  `command = "CODEX_HOME=" + shellQuote(home) + " " + args.map(shellQuote).join(" ")`.
  POSIX/zsh accept `VAR=v 'cmd'` with a quoted command word; the docker tmux wrapper's
  `sed` rewrites only the binary path inside the string, leaving the prefix intact.
- `resumeSpecFor` (`cli.ts:123`): for `codex-sessions` entries, resolve
  `codexHomeOwningSessionPath(pathname)`; null (file vanished between scan and resume,
  or path outside all roots) returns `null` — the existing "cannot be resumed" 409 in
  `delivery.ts:173` already covers it. Same env prefix.
- Claude branches: byte-for-byte unchanged.

### 6.2 Scanner roots — `src/lib/scanner/roots.ts` and consumers

`Roots = Record<RootKey, string>` allows one dir per key; codex now has N. Smallest
complete change:

- `roots.ts`: add `export function scanRootEntries(): [RootKey, string][]` returning
  `[["codex-sessions", r] for r of codexSessionRoots()], ["claude-projects", …],
  ["claude-tasks", …]`. Keep `ROOTS` for the claude keys (their consumers at
  `links.ts:143,167,413`, `process.ts:46`, `discover.ts:65-70`, `proc/route.ts:26`,
  `log/route.ts:70` are claude/tasks-specific and stay valid).
- `pathAllowed` (`roots.ts:54`): iterate `scanRootEntries()` dirs instead of
  `Object.values(ROOTS)`.
- `discover.ts`: `discoverRaw` (`discover.ts:92`) iterates `[RootKey, string][]`
  entries instead of `Object.entries(roots)`; `Roots` type becomes that entries list.
  `walk`, `taskParts`, describe/catalog calls take the per-entry `root` dir they
  already receive — duplicate keys are naturally fine.
- `transcripts.ts:44` `transcriptEngine`: codex prefix check against any of
  `codexSessionRoots()`.
- `src/app/api/session/route.ts:11` and `src/app/api/log/route.ts:85`: same
  multi-root prefix helper (export a `codexSessionRootFor(pathname)` from the accounts
  module or roots.ts rather than three hand-rolled loops).
- `src/app/api/spawn/route.ts:44` `transcriptAllowed`: check the union.
- Registry reads are memoized on the store file's `mtimeMs` so the 10 s poll does not
  re-parse JSON needlessly; a `fresh` bypass is unnecessary (a just-created account may
  appear one poll late, which the create endpoint compensates for by returning the
  account directly).

Pid attribution, activity, kill, and the composer need **no changes**: codex keeps its
rollout fd open, so `writingHolders` matches by file path regardless of home
(`transcripts.ts` signal #1), and cwd-fallback matching is home-agnostic.

### 6.3 Fresh-spawn transcript resolution — `src/lib/agent/spawnedTranscript.ts`

`resolveSpawnedTranscriptPath` walks `ROOTS["codex-sessions"]`
(`spawnedTranscript.ts:67`) to find the new rollout. It gains a
`codexSessionsDir: string` option; each spawn call passes the spawned account's
`sessionsDir`, which also makes attribution *more* precise (no cross-account
candidates).

### 6.4 Spawn entrypoints

- `src/app/api/spawn/route.ts` (POST, `:128`): body gains `accountId?: unknown`
  (string, codex-only — reject with 400 when `engine === "claude"` and an accountId is
  present, so the deferred Claude scope fails loudly instead of silently ignoring).
  `accountForSpawn(body.accountId)` → pass `home` into `freshSpecFor`; pass
  `sessionsDir` into `resolveSpawnedTranscriptPath`.
- `src/app/api/tasks/[id]/spawn/route.ts:74`, `src/lib/flows/engine.ts:175`,
  `src/lib/workflows/engine.ts:77`: call `accountForSpawn()` with no argument — task,
  flow-reviewer, and workflow spawns follow the active account at their spawn moment.
  (Per-role account pinning is deferred.)
- `src/lib/flows/engine.ts:112` and `delivery.ts:172,260,281` resume paths need no
  change beyond 6.1 — they already flow through `resumeSpecFor`.

### 6.5 Accounts API (new, thin routes over the deep module)

All POSTs go through `rejectCrossOrigin` like every mutating route.

- `GET /api/accounts` → `{ codex: { active: string, accounts: [{id,label,kind,authPresent,loginPending}] } }`.
  `loginPending` = `loginPane !== null && !authPresent`, revalidated against
  `paneInfo(paneId)` (window-name check, same trust discipline as
  `liveResumePane`, `tmux.ts:505`); a dead pane clears the record.
- `POST /api/accounts/codex/active` `{id}` → 204 | 400 unknown.
- `POST /api/accounts/codex` `{label}` → creates the overlay, spawns the login pane,
  persists `loginPane`, returns `{account, target}` (target = tmux display coords for
  the UI hint). Failure after overlay creation keeps the account (authPresent:false);
  the user can retry login from the UI later (retry endpoint is follow-up scope; for
  MVP re-running create with a new label is acceptable, documented).

### 6.6 Device-auth pane (tracked)

`spawnAgentWithPrompt` (`tmux.ts:621`) is shaped around agent TUIs (readiness markers,
startup-gate auto-Enter, prompt paste). A login flow needs none of that and must never
receive an auto-Enter (it displays a code the user acts on elsewhere). Add a small
sibling in `tmux.ts`:

```ts
/** Opens a window running one command, no readiness/gate machinery, no text. */
export async function spawnCommandWindow(spec: { command, cwd, windowName }): Promise<SpawnedPane>
```

— the `new-window`/type/Enter part of `spawnAgentWithPrompt` extracted, stopping after
the command is typed. Login command:

```
CODEX_HOME='<home>' codex login --device-auth -c cli_auth_credentials_store=file
```

The `-c` pin guarantees the credential lands in the overlay's `auth.json` even if a
future codex default flips to `keyring`/`auto` (§7.3). Window name `codex-login`, cwd
= home dir of the user. Completion detection is **filesystem truth**: `authPresent`
flips when `auth.json` appears (checked on every `GET /api/accounts` and by the poll);
the pane record is only a UI affordance. `codex login status` under the home
(exit 0/1) is the stronger post-hoc check used in acceptance, kept out of the poll
path to avoid spawning processes every 10 s.

### 6.7 Limits — `src/lib/limits.ts:11`

`CODEX_SESSIONS` currently pins `~/.codex/sessions`. Point it at the **active**
account's `sessionsDir` (resolved freshly on every refresh; module-load pinning would
freeze the pre-switch account). The limits card
then answers "how much runway does the account my next spawn will use have" — the
exact question behind this urgent issue. The cache (`limits-cache.json`) may serve one
stale interval after a switch; acceptable, noted in code. Per-account limit rows are
deferred.

`readCodexAuth` (`src/lib/codexAuth.ts`) keeps reading `~/.codex` for dictation.
Dictation quota is negligible; making it account-aware is deferred and listed in §12.

### 6.8 UI (MVP-thin)

- `src/components/CodexAccountSwitch.tsx` (new): compact select fed by
  `GET /api/accounts`, posts to `/active`, plus an "add account…" action that calls
  create and surfaces "device login opened in pane `<target>` — enter the code shown
  there". Mounted in the `Switchboard` header next to the existing global controls.
- `src/components/DraftAgentPane.tsx`: when `engine === "codex"`, an account pill row
  (same visual grammar as `EffortPills`) whose value rides the existing
  sessionStorage draft-field mechanism (`:50`) and lands in the POST body (`:228`) as
  `accountId`. Default = active account.
- No per-card account badges, no rename/delete/sign-out UI, no per-project defaults —
  deferred (§12).

---

## 7. Environment & compatibility analysis

### 7.1 Docker/nsenter propagation — verified path

Container server → in-container `/usr/local/bin/tmux` wrapper → `nsenter -t 1 -m -p` →
host `tmux send-keys -l '<text>'` → host login shell parses `CODEX_HOME='…' codex …`.
The wrapper's rewriting (`Dockerfile`, `host_command_text`) is a fixed `sed` over
binary paths and cannot touch the prefix. The first typed line (`cd -- '<cwd>'`) is a
separate send-keys and unaffected. Non-docker dev runs (`bun run dev`) type the same
text into the same host tmux — identical semantics, nothing branches on
`LLV_DOCKER_NSENTER_SHIMS` in this feature.

### 7.2 Symlinked `config.toml` — the one real write hazard

Codex writes `projects.*.trust_level` into `config.toml`. Two possible write styles:
in-place truncate (follows the symlink → **shared config updated**, desired) or
temp-file+rename (**replaces the symlink** with a real file → config silently forks).
The binary's behavior here is unverified. Consequence of the bad case is bounded:
the account's config drifts from canonical, skills/prompts stay shared, nothing
breaks at runtime. Mitigation, in order:

1. **Verify in slice 1's live check** (cheap, no tokens): under a scratch overlay run
   `CODEX_HOME=… codex exec --sandbox read-only 'exit'` in an untrusted dir or simply
   answer one trust prompt in a throwaway pane, then `readlink config.toml`.
2. If rename-based: switch the overlay builder to a **symlinked directory layer
   instead of the file** where possible, and otherwise fall back to *copying*
   `config.toml` at account creation (trust entries then diverge per account —
   tolerable because the viewer's spawn gate auto-answers trust prompts already,
   `tmux.ts:676`). The overlay builder is the only code that knows; the interface
   does not change. Record the outcome in this file.

`skills/` and `prompts/` are read-traversed (verified via doctor parsing config +
skills through symlinks); skill *installs* write through the symlink into the shared
canonical dir — which is the desired "add once, every account sees it" behavior.

### 7.3 Keyring stores

`cli_auth_credentials_store=auto|keyring` would put tokens in the OS keyring keyed
outside any home. The login command pins `file` (§6.6). If a user hand-configures
keyring in the shared config, `authPresent` stays false and the account never lights
up — a visible failure, documented here as a known limitation.

### 7.4 Session/auth file layout & modes

Codex creates `sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`, `history.jsonl`, `log/`,
and sqlite state lazily per home (doctor listed each as home-scoped). `auth.json` is
written by codex at 0600 (verified on the live one). The viewer's own writes: home dir
0700, symlinks, registry JSON (no secrets) — no umask games needed. Per-home sqlite
files start empty; the 1.4 GB `logs_2.sqlite` in `~/.codex` stays where it is.

### 7.5 Path containment

`pathAllowed` and `transcriptAllowed` compare realpaths against realpathed roots.
Managed `sessionsDir`s join that root set; account ids are slug-validated **and**
their resolved homes are containment-checked against the accounts root at load
(§4 error table), so a hostile registry entry cannot smuggle `/etc` into the
allowlist. `/api/log` reads of managed-home transcripts flow through the same gate.

---

## 8. Refresh-token rotation — why the design is safe

Facts: tokens auto-refresh during use and are rewritten into the home's `auth.json`;
copying credentials between machines is officially supported; simultaneous independent
rotation of two copies has no documented guarantee.

The design never creates the dangerous state: **no copy operation exists** (I2). The
default account's tokens live only in `~/.codex` (also used by the user's own terminal
codex — same file, same single copy, exactly today's situation). A managed account's
tokens exist only in its overlay, written there by codex itself at login. Two panes on
the *same* account share one home and one `auth.json`, which is precisely the
single-machine situation codex already handles today with the user's parallel
sessions. Acceptance includes a cross-write check (§11.4).

Rejected alternative, for the record: copy-import of `~/.codex/auth.json` into a named
home. It would make "switch main to a new login" one click faster and creates the only
scenario where two live refresh-token copies of one account rotate divergently.
Migration of the primary identity into a managed home stays a documented manual
procedure (log out in `~/.codex`, device-auth into the managed home), deferred.

---

## 9. Vertical implementation slices

Each slice lands independently green: `bun test`, lint, `bun run build` (unset
`__NEXT_PRIVATE_STANDALONE_CONFIG` first — known standalone-env leak breaks clean
builds otherwise).

**Slice 1 — account catalog + scoped fresh spawn (API-complete core).**
`src/lib/accounts/codex.ts` + registry; `freshSpecFor` codexHome; spawn route
`accountId`; `scanRootEntries` + `pathAllowed` union; `spawnedTranscript` sessions-dir
option. *Tests:* store round-trip & corrupt-store degradation; id/containment
rejection; `freshSpecFor` emits `CODEX_HOME='…'` prefix (and claude spec unchanged);
discover finds files in two fake codex roots; `pathAllowed` accepts managed /rejects
outside; spawn route 400 on unknown accountId, claude+accountId rejected.
*Deliverable:* `curl` a spawn with `accountId` → pane runs under the overlay, its
session file appears in the viewer.

**Slice 2 — resume + delivery ownership.** `resumeSpecFor` owning-home derivation;
`transcriptEngine`/session-route/log-route/`transcriptAllowed` multi-root; I6
mismatch rejection. *Tests:* resume spec for a managed-root transcript carries that
home's prefix and correct cwd; ownership null for foreign paths; a managed-home
transcript passes `transcriptAllowed`. The deleted-worktree grouping guard is **owned
by the existing, unmodified `describe.test.ts`**: grouping is decided purely by
`projectInfoFromCwd(cwd)` and is independent of Codex account/managed-root state, so its
current cases (deleted codex, nested, and arbitrary-path worktrees) already cover the
AGENTS.md standing rule. `describe.ts`/`describe.test.ts` stay untouched by this MVP; no
new case is added because it would only re-assert an already-covered path.

**Slice 3 — active account + selector UI + limits.** `GET /api/accounts`, `POST
…/active`; `CodexAccountSwitch` in Switchboard; DraftAgentPane account pills; limits
reader on active `sessionsDir`. *Tests:* route handlers (active-switch persistence,
dangling-active fallback); component-level state tests follow the existing
`Viewer.test.ts` style where cheap.

**Slice 4 — add account via tracked device login.** `spawnCommandWindow`;
`POST /api/accounts/codex`; overlay builder finalized per §7.2 verification;
loginPane tracking + `authPresent` flip. *Tests:* overlay builder creates exact
symlink set with 0700 home and cleans up on injected failure; create route rejects
bad labels; loginPending revalidation drops dead panes.

Delivery order matches the issue's expedited list; slices 1–3 are the MVP the five-hour
window needs, slice 4 completes add-account without leaving the viewer.

---

## 10. Test surface summary

New/updated files: `src/lib/accounts/codex.test.ts`, `src/lib/agent/cli.test.ts`
(new — the file currently has no test), `src/lib/scanner/discover.test.ts` (extend),
`src/lib/scanner/describe.test.ts` (worktree-grouping guard — **existing coverage,
unmodified**; see §9 slice 2), route tests alongside
existing patterns, `src/lib/agent/spawnedTranscript.test.ts` (extend for sessions-dir
option). All tests run against `LLV_STATE_DIR` + `LLV_CODEX_HOME` scratch dirs; none
read the real `~/.codex` or write outside tmpdirs.

---

## 11. Live acceptance (prod viewer, 127.0.0.1:8898, after deploy)

1. **Registry:** `GET /api/accounts` lists `default` (authPresent:true, active).
2. **Add account:** create `alt` from the UI → `codex-login` pane opens showing URL +
   one-time code; complete with the second ChatGPT account → `authPresent:true`;
   on disk: home 0700, `auth.json` 0600, symlinks resolve, `CODEX_HOME=<home> codex
   login status` exits 0.
3. **Scoped spawn + scanner:** switch active to `alt`, spawn from the UI →
   `tr '\0' '\n' < /proc/<panePid>/environ | grep CODEX_HOME` shows the overlay;
   rollout lands under the overlay's `sessions/`; the conversation card appears,
   composer and kill work (pid attribution via rollout fd).
4. **Two-account concurrency + rotation isolation:** one pane per account
   simultaneously, both streaming; afterwards `~/.codex/auth.json` and the overlay
   `auth.json` mtimes moved independently and neither file references the other
   account (compare `tokens.account_id` fingerprints only via `jq -r … | sha256sum`,
   never printing values).
5. **Resume ownership:** resume the `alt` conversation from the UI → new pane's
   `CODEX_HOME` is the overlay.
6. **Running-pane preservation:** with a `default` pane mid-turn, flip active to
   `alt` and back — the running pane streams on uninterrupted.
7. **Secrets sweep:** grep the viewer event log, `docker compose logs`, and the
   browser network tab for `refresh_token`, `access_token`, `id_token` substrings and
   for any 20+‑char token prefix from the fingerprints — zero hits. `GET
   /api/accounts` payload contains only ids/labels/booleans.
8. **Shared skills:** a skill added under `~/.codex/skills` is visible in a fresh
   `alt` session (`/skills` listing in the pane).
9. **Config write check (§7.2):** after answering one trust prompt under `alt`,
   `readlink <home>/config.toml` still points at `~/.codex/config.toml` (or the
   documented fallback is in effect).
10. **Limits:** the limits footer reflects the active account after a switch (within
    one cache interval).

---

## 12. Deferred scope (exact)

- **Claude accounts entirely**: `CLAUDE_CONFIG_DIR` overlay, `.credentials.json`
  handling, claude `accountId` (the spawn route actively rejects it until then).
- **UI polish**: extracting the device code from the pane into the browser, login
  progress states, sign-out/delete/rename account management, per-card account badges,
  account filtering, per-project default accounts.
- **Per-account limits** rows and history; dictation (`readCodexAuth`) account-awareness.
- **Copy-based identity migration** of `~/.codex` into a managed home (manual
  procedure documented in §8 until then).
- **Keyring credential stores**; login **retry endpoint** for a half-created account.
- **Per-role account pinning** in flows/workflows/tasks (they follow the active
  account for now).
- **`chik` CLI integration** (binary unavailable on this machine).
- Broader #39 engine adapters — this module is the account seam a future
  `EngineAdapter` composes over (`accounts/codex.ts` deliberately exposes engine-neutral
  vocabulary: id/label/home/sessionsDir), keeping #25 SDK-runtime compatibility: an SDK
  client would consume `accountForSpawn().home` the same way the CLI spec builder does.

---

## 13. Open verification items carried into implementation

1. §7.2 `config.toml` symlink write-behavior probe (slice 1 live check; fallback
   specified).
2. Confirm `codex login --device-auth` honors `-c cli_auth_credentials_store=file`
   end-to-end on 0.144.0 during slice 4 acceptance (help text accepts `-c`; doctor
   already shows File as the effective mode on this machine).
3. Observe whether codex rewrites `auth.json` atomically per home during acceptance
   §11.4 (informational; no design dependency either way, thanks to I2).

## 14. Implemented overlay matrix and resolved checks

Sol's final architecture verification confirmed that Codex preserves a `config.toml`
symlink during its atomic config writes. Managed overlays therefore keep the canonical
shared config link. The builder applies this path policy:

| Path under `CODEX_HOME` | Policy | Reason |
| --- | --- | --- |
| `skills/`, `prompts/`, `memories/`, `rules/`, `AGENTS.md` | shared symlink | Durable capabilities and guidance stay consistent across accounts. |
| `config.toml` | shared symlink | Shared CLI configuration; verified symlink-aware atomic writes preserve the link. |
| `plugins/cache` | shared symlink | Read-mostly plugin packages and cache remain available to every account. |
| `plugins/data` | private, created by Codex when needed | Mutable plugin state can carry account identity. |
| `auth.json`, `history.jsonl`, `sessions/`, logs, sqlite state | private, created by Codex | Credential and session ownership remains account-local. |
| MCP OAuth state (`mcp-oauth/` and Codex-created equivalents) | private, created by Codex | OAuth tokens are account-bound. |

Every managed fresh pane, managed resume, managed headless reviewer, and device-login
command pins `cli_auth_credentials_store=file`. The legacy `default` home keeps its
user-selected credential-store behavior. Corrupt registry bytes now place the catalog
in a default-only, read-only degraded state: reads keep working, mutations return a
recoverable typed error, and no overwrite occurs. Limits cache entries carry the active
account id, preventing a newly selected account from inheriting another account's quota.

Issue #40 remains open. This change is the expedited Codex MVP; Claude account parity
and account sign-out remain follow-up acceptance work.
