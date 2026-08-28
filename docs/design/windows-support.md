# Native Windows support — stage 1 design (issue #1201)

## The originating requirement

Verbatim, from the "Operator request" section of GitHub issue #1201 (dated
2026-08-26 in the issue, read with `gh issue view 1201` on 2026-08-28):

> Add Windows support. Today `package.json` declares `"os": ["linux", "darwin"]`,
> so `npm install` on Windows fails with `EBADPLATFORM`; README says "WSL works
> as Linux". There is no Windows process backend.

The issue's own plan makes this document stage 1: enumerate every platform
assumption from the code, classify each as **blocking**, **degrade-gracefully**
or **docs-only**, and produce a phased plan with the exact CI matrix. Nothing
here changes product code. Stage 2 implements what this document names.

## Evidence discipline

Everything below was read from this checkout at `83fae8f4` on `main`
(2026-08-28). Line references resolve against that commit. The greps the issue
asked for (`process.platform`, `/proc`, `xdg-open`, `kill(`, `path.posix`,
`os.homedir`, shell invocations under `scripts/` and `bin/`) were run, plus the
ones they imply (`SIGTERM`/`SIGKILL`, `detached`, `bun:ffi`, `flock`, unix
sockets, `getuid`, `0o600`/`0o700` mode checks, `realpath`/`symlink`,
`tmpdir`, `HOME`/`XDG_*`). Test files are excluded from the inventory.

**Nobody involved has a Windows machine, and nothing in this document was run
on Windows.** Every claim about Windows behaviour therefore carries one of
three tags:

- **CI-proves** — a `windows-latest` job runs a named test and the test's pass
  is the proof.
- **CI-partial** — CI proves the mechanism works (a spawn returns, a file
  appears) while the user-visible effect (a browser window opened) is not
  observable in a headless runner.
- **Not CI-settleable** — the claim depends on something a public runner cannot
  provide (an authenticated Claude session, a second Windows user account, a
  real desktop). These are listed together in
  [What cannot be settled from CI alone](#what-cannot-be-settled-from-ci-alone).

Facts about Windows itself (PID reuse, `process.kill` semantics, PowerShell
availability, the named-pipe namespace) are stated as facts; facts about
third-party tools (Claude Code's install path, Codex's Windows status) are
stated "at the time of writing" and each has a CI probe that re-checks them.

This is a public document: paths are `$HOME`-relative or `%USERPROFILE%`
relative, and no identifiers from any live machine appear.

---

## Summary of decisions

| # | Question | Decision |
|---|----------|----------|
| a | Third process backend | `src/lib/proc/windows.ts`, selected by `process.platform === "win32"` and forceable with `VIEWER_PROC_BACKEND=windows`. One Windows PowerShell `Get-CimInstance Win32_Process` call per 5 s snapshot supplies pid, ppid, command line, creation time and working set; `bun:ffi` reads each candidate's working directory from its PEB (same shape as the Darwin `libproc` binding). |
| b | Process identity token | `${pid}:${creationTimeFileTimeUtc}` — the kernel's process creation time as a 100 ns FILETIME. It plays exactly the role `/proc/<pid>/stat` field 22 plays on Linux and `proc_pidinfo` start time plays on macOS. `tasklist` and `wmic` cannot supply it; `Get-Process` can but lacks the command line on Windows PowerShell 5.1. |
| c | Paths | Keep `~/.config/agent-log-viewer` on Windows (no `%APPDATA%` split, no migration). Ignore `HOME` on win32 and use `os.homedir()` everywhere. Transcript roots stay `~/.claude/projects` and `~/.codex/sessions`. The worktree recognisers work unchanged on backslash paths; the two slug-based fallbacks and the scratchpad recogniser are deferred with their degrade named. |
| d | Runtime host IPC | Named pipe `\\.\pipe\agent-log-viewer-<installId>` replacing the Unix socket; the singleton fence stays a real file in the state directory and locks it with `kernel32!LockFileEx` where Linux/macOS use `flock`. |
| e | Termination | Windows has no signals: `process.kill` is `TerminateProcess`. Graceful stop is already "close stdin, then signal" for both hosts, so the only change is that "signal the group" becomes "terminate the ppid-tree, children first, verified by identity". No Job Objects in phase 1. |
| f | Agents | Claude Code runs natively (native installer → `claude.exe`). Codex stays a WSL route; no native Codex host design here. |
| g | CI | A new `platform-tests.yml` with an `ubuntu-latest` and a `windows-latest` leg over an explicit file list, plus a `windows-latest` package-smoke job that builds, packs, installs and boots the CLI. No workflow runs any test today, so the Ubuntu leg is what makes "Linux unchanged" a CI-witnessed claim. |
| h | Phasing | Four independently shippable and revertable phase-1 slices (backend → runtime host → spawn/terminate → package flip), each with its own tests; phase 2 and 3 hold the deferred pieces. The `os` field is extended in the last slice, so reverting that one PR re-blocks Windows installs without touching any internals. |

---

## Corrections to the issue's starting facts

Reading the code changed the picture in six places.

1. **`portableBackend` is unusable on Windows, so the third backend is
   mandatory.** It shells out to `ps`, `lsof`, `vm_stat`
   and `sysctl` (`src/lib/proc/portable.ts:139-142`, `:224-236`) and its
   `processIdentity` is Darwin-only (`:179-182`). On win32 the selector today
   would pick it and every scan would return empty.

2. **The scanner drops every process whose cwd is unknown**
   (`src/lib/scanner/process.ts:216`). A Windows backend that returns
   `cwd: null` — the cheap option — makes *zero* `claude` processes visible,
   which fails the issue's own phase-1 acceptance ("shows running `claude`
   processes"). Reading another process's working directory on Windows has no
   command-line route; it needs `NtQueryInformationProcess` +
   `ReadProcessMemory`, which is why the backend carries a `bun:ffi` binding.
   Section [The Windows process backend](#the-windows-process-backend) names
   the fallback if that binding fails on a given process.

3. **The blocking items are mostly ones the issue does not list.** The
   structured hosts pass their child an allow-listed environment
   (`src/lib/runtime/claudeStreamBrokerHost.ts:241-247`,
   `src/lib/runtime/codexAppServerHost.ts:227-251`) with no `SystemRoot`,
   `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PATHEXT` or `ComSpec`; a Node or
   Bun child on Windows does not start without `SystemRoot`. The runtime host
   listens on a Unix socket path (`src/runtime-host/socket.ts:26`, "binds a
   Unix path only") and its singleton fence `dlopen`s `libc.so.6` for `flock`
   (`src/runtime-host/runtimeHostFence.ts:34-36`). Any of the three alone
   stops a structured Claude host from ever starting.

4. **"`kill -TERM -pgid` needs a `taskkill /T` equivalent" understates it.**
   Windows has no signals at all: Node's `process.kill(pid, "SIGTERM")` calls
   `TerminateProcess`, `process.kill(-pid, …)` throws, and a `SIGTERM` handler
   in the child never runs. Both hosts already close the child's stdin before
   signalling (`claudeStreamBrokerHost.ts:1445`), which is the only graceful
   stop Windows offers for `claude -p`. The design change is smaller than a
   new termination ladder: the *group* step becomes a ppid-tree walk.

5. **The tmux transport is irrelevant to Windows.** The CLI pins
   `LLV_SPAWN_TRANSPORT=structured` (`bin/server-runtime.mjs:101`) and #1161
   is removing the transport. The `tmux` code paths are dead on Windows and
   need no port; the README's tmux sentence needs rewriting, nothing more.

6. **Browser opening is already a graceful degrade.** `openBrowser` returns
   silently on any platform other than linux/darwin (`bin/cli.mjs:616-621`), so
   the CLI runs on Windows today without it; adding a win32 opener is a
   usability fix; it blocks nothing.

One more thing the issue could not know: **no workflow in `.github/workflows/`
runs the test suite** (`privacy-publication.yml` runs only its own gate test).
The "Linux and macOS behaviour unchanged (existing tests green)" acceptance
has no CI witness today; the matrix below adds one for the files this work
touches.

---

## Inventory of platform assumptions

Classification: **B** blocking (Windows cannot reach the phase-1 acceptance
without it), **D** degrade-gracefully (the feature narrows or hides itself
with no crash), **N** docs-only / not applicable (Docker-only, maintainer
script, or a feature that stays a WSL route).

### A. Process discovery and identity

| Location | Assumption | Class | Phase | How CI settles it |
|---|---|---|---|---|
| `src/lib/proc/index.ts:17` | `linux` → `/proc`, everything else → `ps`/`lsof` | B | 1a | `proc/index.test.ts` (new): win32 selects `windowsBackend`; `VIEWER_PROC_BACKEND=windows` forces it |
| `src/lib/proc/types.ts:41` | `name: "linux" \| "portable"` | B | 1a | type-level; `"windows"` added |
| `src/lib/proc/linux.ts:54-58` | identity = `/proc/<pid>/stat` start ticks | B | 1a | `proc/windows.test.ts` (new): identity stable across two reads, differs across two spawns, `null` after exit |
| `src/lib/proc/portable.ts:157-166` | `process.kill(pid, 0)` liveness | B | 1a | same test: alive child true, exited child false — proves Bun's win32 `process.kill(…, 0)` |
| `src/lib/scanner/process.ts:216` | a process with `cwd === null` is dropped | B | 1a | `proc/windows.test.ts`: `readCwd` of a child spawned with a known cwd equals that cwd |
| `src/lib/scanner/process.ts:120-127` | engine sniff accepts `claude.exe` | — | — | already handled; `scanner/process.test.ts` on win32 |
| `src/lib/scanner/transcripts.ts:194,267` | cwd-fallback attribution requires `tty !== 0` | D | 1a | backend reports a constant nonzero tty (see backend section); `transcripts.test.ts` on win32 |
| `src/lib/scanner/transcripts.ts:143,250,282` and `process.ts:41-52` | fd-holder scans (`lsof` / `/proc/*/fd`) identify live writers | D | 2 | backend returns no holders; attribution falls back to `--session-id` argv and cwd; `activity.test.ts` on win32 proves mtime path still yields `live` |
| `src/lib/scanner/activity.ts:432`, `src/lib/scanner/observe.ts:72`, `src/app/api/proc/route.ts:27-29` | `.output` holders for background tasks | D | 2 | empty map → `stale`; no crash (`observe.singleFlight.test.ts`) |
| `src/lib/proc/portable.ts:191-193` (and Linux `readEnvVar`) | reading another process's env | D | — | already null on macOS; scanner tolerates it (`scanner/process.ts:199-205`) |
| `src/lib/runtime/structuredHostControl.ts:214-226` | process group id from `/proc/<pid>/stat` | D | 1c | returns null off-Linux already; tree comes from `ppidMap` (`:304-317`); `structuredHostControl.test.ts` on win32 |
| `src/lib/resources.ts:743-940` | direct `/proc` walks for the resource worker (namespaces, groups, descendants) | D | 2 | every call guarded by `procBackend.name === "linux"` (`:955-966`) with portable arms; the portable arms are what Windows gets; `resources.test.ts` on win32 (phase 2) |
| `src/lib/resources.ts:1354-1360` | `unshare` PID-namespace containment | N | — | `process.platform === "linux"` guard already |
| `src/lib/accounts/claudeLogin.ts:68-70,91-93` | `/proc/<pid>/stat` start token and `/proc/<pid>/cmdline` for the login supervisor | D | 2 | Windows: supervised in-app login unavailable; log in from a terminal. Test: supervisor reports a `launch_unfenced`-class refusal and never throws |
| `src/lib/accounts/accountMutation.ts:83` | `/proc/self/ns/pid` | D | 2 | account mutation fence falls back to pid+identity |
| `src/lib/mcp/bindings.ts:873-875,961-963` | `/proc/self/fd` / `/dev/fd` symlink for the targeted MCP read | D | 3 | MCP server on Windows is phase 3 |
| `src/lib/runtime/runtimeImageStore.ts:479-481,776-779,784` | `/proc/self/fd` pinning, `geteuid`, `O_DIRECTORY`, `0o700` mode | D | 2 | store is lazy (`:905`); first image attach fails with "runtime image root is unsafe"; composer images stay off on Windows in phase 1 |

### B. Paths, homes and identity

| Location | Assumption | Class | Phase | How CI settles it |
|---|---|---|---|---|
| `src/lib/scanner/roots.ts:11,74-80` | roots under `os.homedir()` with `/`-joined segments | — | — | `path.join` normalises; `roots.claude.test.ts` on win32 |
| `src/lib/scanner/roots.ts:24-31` | Claude background tasks at `<tmpdir>/claude-<uid>`; uid defaults to 1000 without `getuid` | D | 2 | **not CI-settleable** (needs a real background task); degrade: root absent → zero tasks |
| `src/lib/configDir.ts:13-18` | `$XDG_CONFIG_HOME` else `~/.config` | — (decision c) | 1d | `configDir.test.ts` on win32: state dir resolves under `%USERPROFILE%\.config\agent-log-viewer\state` |
| `bin/mcp-server.mjs:21-22`, `src/lib/accounts/claudeLogin.ts:600` | `process.env.HOME` with a hard-coded Linux-shaped fallback (`mcp-server`) or `"/"` (`claudeLogin`) | B (mcp) / D | 1c | `mcp-server.test.ts` on win32: config root derives from `os.homedir()` with `HOME` unset |
| `src/app/api/artifact/route.ts:64`, `src/lib/projects/suggestionRoots.ts:34`, `src/app/api/orchestrator/seat/route.ts:33` | `HOME` preferred over `os.homedir()` | D | 1c | on win32 ignore `HOME` (Git Bash may export a POSIX-style value); `suggestionRoots.test.ts` on win32 with a bogus `HOME` |
| `src/lib/agent/transcript.ts:16-23` | slug = every non-alphanumeric → `-` | — | — | pure; `transcript.test.ts` on win32: `C:\work\proj` → `C--work-proj`. **Ground truth not CI-settleable** (see below) |
| `src/lib/scanner/describe.ts:194-201` (`.claude/worktrees`) | `path.sep + ".claude" + path.sep + "worktrees"` | — | — | already `path.sep`-based; `describe.test.ts` on win32 with backslash cwds, live and deleted |
| `describe.ts:212-222` (`worktrees/`, `.worktrees/`) | split on `path.sep` | — | — | same test file |
| `describe.ts:277-286` (`~/.codex/worktrees/<hash>/<Repo>`) | `path.sep`-based | N | 3 | Codex is a WSL route in phase 1 |
| `describe.ts:289-297` (`gitdir:` parsing) | `path.resolve(cwd, target)` | — | — | git on Windows writes `gitdir: C:/…/.git/worktrees/x` with forward slashes; `path.resolve` normalises; `describe.test.ts` case "gitdir with forward slashes on win32" |
| `describe.ts:398-400,423-437` (persisted worktree map) | keyed by the cwd string | D | 1d | same file; note case sensitivity below |
| `describe.ts:234` (`repoPathFromSlug` frontier root) | slugs start with `-` (POSIX root) | D | 2 | Windows slugs start with a drive letter; the deleted-cwd slug recovery returns null → session groups by its recorded `cwd` instead; `describe.test.ts` documents the null |
| `describe.ts:694-700` (`claude-<uid>` scratchpad recogniser) | `/^claude-\d+$/` container segment | D | 2 | **not CI-settleable** (Claude's Windows scratchpad layout unknown) |
| `src/lib/projects/identity.ts:39-47` | `fs.realpathSync.native` for directory identity | — | — | canonicalises drive-letter and path case on Windows; `identity.test.ts` on win32 |
| Every `startsWith(root + path.sep)` containment (`roots.ts:89,118`, `artifact/route.ts:74`, `image/route.ts:48`, `inboxFiles.ts:128`, …) | case-sensitive string prefix | D | 2 | a cwd recorded as `c:\…` and a root as `C:\…` miss each other; phase 2 normalises the drive letter on win32; phase 1 documents it |
| `bin/cli.mjs:711-724` (`linkSkills`) | creates symlinks | D | — | only from a git checkout; symlink creation without Developer Mode fails and is already caught |
| `src/lib/accounts/claude.ts:69,80,159-165`, `codex.ts:164-168`, `wakatime/sync.ts:953`, `telegram/*`, `runtimeImageStore.ts:777` | POSIX mode bits (`0o700`, `& 0o077`) and `uid === getuid()` | B (Main account reads as signed out; headless selection finds no account) / D | 1c | `accounts/claude.test.ts` on win32: `managedClaudeCredentialIsSafe` true for a plain file; `headlessSelection.test.ts` selects Main |
| `src/lib/runtime/integrationTestHome.ts` | `chmod 0o700` | — | — | tests only |

### C. Spawn and termination

| Location | Assumption | Class | Phase | How CI settles it |
|---|---|---|---|---|
| `claudeStreamBrokerHost.ts:241-247`, `codexAppServerHost.ts:227-251` | child env allow-list is POSIX-shaped | B | 1c | `claudeStreamBrokerHost.test.ts` (new case): a Bun child spawned with the allow-listed env on win32 can `require("node:http")` and exit 0 |
| `src/lib/agent/cli.ts:32-59` (`resolveBinary`) | probes `~/.bun/bin`, `/usr/local/bin`, … with `X_OK` | B | 1c | win32 probes `%USERPROFILE%\.local\bin\<name>.exe`, `%USERPROFILE%\.bun\bin\<name>.exe`, then bare name; `cli.test.ts` on win32 |
| `claudeStreamBrokerHost.ts:674,722-731` | `spawn(binary, args, { detached: true })` | — | 1c | `detached` on win32 means a new console; `windowsHide: true` added (already done for the MCP probe at `mcpProbeStdioTransport.ts:66`); CI spawns a stub `claude.exe` and reads a stream-json frame |
| `src/lib/processGroup.ts:8-20` | `process.kill(-pid)` reaches the group | B | 1c | win32 arm terminates the identity-verified ppid tree; `processGroup.test.ts` (new): a child that spawned a grandchild — both gone after one call |
| `structuredSpawn.ts:190-208`, `registry.ts:359-369`, `structuredHostControl.ts:400-430` | `SIGTERM` then `SIGKILL` ladder | D | 1c | both are `TerminateProcess` on win32; the ladder still converges; `structuredHostControl.test.ts` on win32 |
| `src/lib/headlessProcessReaper.ts:309-320` | `signalProcess(-pid)` | N | 2 | reaper is opt-in (`LLV_REAPER_ENABLED`) and stays dry-run on Windows |
| `src/lib/flows/exec.ts:140-148,341` | group signals for review flows (Codex) | N | 3 | Codex route |
| `src/lib/accounts/claudeLogin.ts:131` | `kill(-pid)` | D | 2 | with the login supervisor |
| `src/lib/workflows/provision.ts:85` | `spawn("sh", ["-c", …])` | N | — | workflow setup commands stay a POSIX feature; documented |
| `src/runtime-host/deploymentAdapter.ts:129,418`, `scripts/runtime-host-viewer-adapter.ts:135,415`, `scripts/bootstrap-runtime-host.ts` | `/bin/kill`, `/usr/bin/setpriv`, docker | N | — | deployments are Docker-only (`LLV_VIEWER_DEPLOYMENTS=1`) |
| `src/lib/scanner/fileScanWorker.ts:115`, `filesResponseWorker.ts:79-81` | `/usr/bin/nice` when it exists | — | — | `existsSync` guard; falls through on win32 |
| `src/lib/resources.ts:1354-1360` | `unshare` containment | N | — | linux guard |
| `src/app/api/proc/route.ts:73` | `SIGKILL` vs `SIGTERM` choice | D | — | both terminate; the UI's "force" step is a no-op on win32 (documented) |

### D. Runtime host and CLI supervision

| Location | Assumption | Class | Phase | How CI settles it |
|---|---|---|---|---|
| `src/runtime-host/socket.ts:26,37-38,102-103` | Unix socket path; `mkdir`, `unlink`, `chmod` around it | B | 1b | `socket.test.ts` on win32 with a `\\.\pipe\` name: request/response round-trip, connection caps |
| `src/lib/runtime/client.ts:112`, `bin/cli.mjs:404-418` | `net.createConnection(path)` | B | 1b | same test (client side) plus `server-runtime.test.ts` on win32 |
| `bin/server-runtime.mjs:69-83` | socket under the state dir; fence at `${socketPath}.lock` (`cli.mjs:420-431`, `runtime-host/main.ts:26,38`) | B | 1b | config returns `socketPath` and a separate `fencePath`; `server-runtime.test.ts` on win32 asserts both shapes |
| `src/runtime-host/runtimeHostFence.ts:12-13` | `O_CLOEXEC` constant is a Linux/Darwin number | B | 1b | 0 on win32 (libuv handles are non-inheritable by default); `runtimeHostFence.test.ts` on win32 |
| `runtimeHostFence.ts:30-45,121,150,208` | `flock` via `libc.so.6` / `libSystem` | B | 1b | `kernel32!LockFileEx`/`UnlockFileEx` via the same `bun:ffi` shape; `runtimeHostFence.test.ts` (two-contender race) on win32 with pipe-named listeners |
| `runtimeHostFence.ts:169-206` (`removeOwnedSocket`) | rename/link/unlink a socket inode | B | 1b | no-op for pipe names; covered by the fence test |
| `src/runtime-host/main.ts:132-133` | `SIGINT`/`SIGTERM` → `stop()` | D | 1b | Ctrl+C in the console reaches every process sharing it (Node raises `SIGINT` on win32); a `TerminateProcess` from the supervisor skips `stop()` — the WAL journal and the kernel-released lock recover. `main.test.ts` is out of scope; the package smoke proves restart-after-kill |
| `bin/cli.mjs:488-492` | `spawn(bunRuntime, ["--bun", entrypoint])` | — | — | `bun.exe` resolves through `PATH` (libuv appends `.exe`); package smoke |
| `bin/cli.mjs:630-652` (`stopChild`) | `SIGTERM`, 2 s, `SIGKILL` | D | — | both terminate on win32; the 2 s wait is harmless |
| `src/runtime-host/mcpHealthProbeAdmissionChannel.ts:29-31,58-60` | `libc` dlopen and a unix channel | N | — | reached only from the deployment MCP probe (`mcpProbeStdioTransport.ts:56`) |
| `src/lib/runtime/structuredSpawn.ts:122-127` | scratch dir `0o700` + `TMPDIR` | — | — | mode ignored on win32; Node reads `TEMP`/`TMP`, so `TMPDIR` is inert — read-only stages keep their scratch dir but the child's temp files land in `%TEMP%` (documented, D) |

### E. CLI surface

| Location | Assumption | Class | Phase | How CI settles it |
|---|---|---|---|---|
| `bin/cli.mjs:616-628` (`openBrowser`) | `xdg-open` / `open` | D | 1d | win32: `rundll32.exe url.dll,FileProtocolHandler <url>` (no shell, no quoting of `?k=` tokens); **CI-partial** — the spawn returns without an error; no browser is observable |
| `bin/cli.mjs:670-671` | `SIGINT`/`SIGTERM` handlers | — | — | `SIGINT` works on win32 consoles |
| `bin/cli.mjs:167-172` (`resolveServer`) | `dist/standalone/server.js` under `bun --bun` | B (the whole viewer) | 1d | package smoke on `windows-latest`: `/api/files` answers 200 |
| `package.json:21-24` | `"os": ["linux", "darwin"]` | B | 1d | the smoke job's `npm install` of the packed tarball |
| `bin/tailscale.mjs:114,270` | darwin app path; `tailscale` on `PATH` | D | 3 | `--tailscale` needs `tailscale.exe` on `PATH`; unverified, documented |
| `scripts/prepack.mjs:15,50` | spawns `node_modules/.bin/next` (a `.cmd` shim on Windows; Node refuses `.cmd` without a shell) | B for building *on* Windows only | 1d | the smoke job builds on Windows, so prepack invokes `node_modules/next/dist/bin/next` through `process.execPath` |
| `scripts/npm-package-smoke.mjs:256,265,388` | `process.kill(-pid)`, `SIGINT` shutdown | B for the smoke job | 1d | win32 arm: tree kill via the phase-1c helper; `npm-package-smoke.test.ts` on win32 |

### F. Shell and Python under `scripts/` and `bin/`

| Location | Assumption | Class |
|---|---|---|
| `scripts/rebuild.sh`, `install-legacy-tmux-supervisor.sh`, `ensure-legacy-tmux-session.sh`, `e2e-viewer-replacement.ts`, `deploy-staging.ts`, `bootstrap-runtime-host.ts`, `runtime-host-viewer-adapter.ts`, `migrate-legacy-tmux.ts` | maintainer deploy and Docker tooling | N |
| `scripts/install-mcp.sh` | registers the MCP server with `claude mcp add` via bash | N (docs: the README's manual registration command works from PowerShell; phase 3 revisits) |
| `scripts/setup-whisper.sh`, `scripts/whisper_transcribe.py`, `src/lib/transcribe/local.ts` | local dictation needs a POSIX venv | N (cloud backends are unaffected; local dictation is a WSL route) |
| `bin/telegram-login-bridge.py`, `bin/telegram-mcp-server.py`, `src/lib/telegram/connectorLog.ts:18,76` (`fcntl.flock`), `bin/provision-telegram-connector.mjs` | Telegram connector is Python + `fcntl` + uid checks | N (Telegram stays a WSL/Linux route) |
| `scripts/capture-*.ts`, `demo-capture.ts`, `demo-motion.ts` | tmux, `/tmp` literals, `claude-<uid>` fixtures | N (evidence tooling, maintainer-only) |
| `scripts/privacy-publication-gate.ts` | `tesseract`, `ffmpeg` | N (runs on `ubuntu-latest`) |

### G. Agents

| Agent | Status at the time of writing | Design consequence |
|---|---|---|
| Claude Code | Runs natively on Windows; the native installer places `claude.exe` under `%USERPROFILE%\.local\bin`; the npm route installs a `claude.cmd` shim, which `spawn` without a shell cannot run (Node raises `EINVAL` for `.cmd`/`.bat`). Transcripts go to `%USERPROFILE%\.claude\projects\<slug>\`. | `resolveBinary` probes the `.exe`; the README says "native installer, or put a `claude.exe` on `PATH`". The `.cmd` shim is unsupported in phase 1; wrapping it in `cmd.exe /c` sits in the deferred list. |
| Codex CLI | Upstream describes Windows as experimental and recommends WSL 2. `codex.cmd` has the same shim problem. | Codex remains a WSL route. The Codex host code is left untouched; the README says so. |

---

## The Windows process backend

`src/lib/proc/windows.ts`, implementing `ProcBackend` with `name: "windows"`.
Selection: `process.platform === "win32" ? windowsBackend : …` in
`src/lib/proc/index.ts`, with `VIEWER_PROC_BACKEND=windows` as the forced
value (the README table at `README.md:414` grows one word).

### Why these primitives

| Candidate | pid | ppid | command line | creation time | cwd | cost | Verdict |
|---|---|---|---|---|---|---|---|
| `tasklist /V /FO CSV` | yes | no | no | no | no | ~100 ms | rejected — no identity, no lineage |
| `wmic process get …` | yes | yes | yes | yes | no | ~200 ms | rejected — deprecated, absent from Windows 11 24H2 |
| `Get-Process` (PowerShell 5.1) | yes | no | no | `StartTime` | no | ~400 ms | rejected — no command line on 5.1; `pwsh` 7 has it but is optional |
| `Get-CimInstance Win32_Process` (PowerShell 5.1, always present) | yes | yes | yes | `CreationDate` | no | ~400–900 ms | **chosen** — one call, every column |
| PEB read via `bun:ffi` (`ntdll!NtQueryInformationProcess`, `kernel32!ReadProcessMemory`) | — | — | — | — | yes | ~0.1 ms/pid | **chosen for cwd** — the only route |

The snapshot call, run through `powershell.exe -NoProfile -NonInteractive
-Command` and cached for 5 s exactly like `portable.ts:147-155`:

```
Get-CimInstance Win32_Process |
  Select-Object ProcessId, ParentProcessId, CommandLine, WorkingSetSize,
    @{n='Created';e={$_.CreationDate.ToFileTimeUtc()}} |
  ConvertTo-Csv -NoTypeInformation
```

CSV, because Windows PowerShell 5.1 serialises dates in JSON as
`/Date(ms)/` and truncates to milliseconds; the `ToFileTimeUtc()` projection
keeps the kernel's 100 ns resolution as an integer.

### Identity token

`processIdentity(pid)` returns `` `${pid}:${created}` `` where `created` is
the FILETIME above — the process creation time the kernel reports through
`GetProcessTimes`, fixed for the life of the process. This is the same shape
`runtimeHostFenceOwner` in `bin/cli.mjs:420-431` already validates
(`startsWith(`${pid}:`)`).

Why the token carries so much weight on Windows: the kernel hands out PIDs as
multiples of 4 and reuses a freed PID within seconds. Every kill path in the
repo (`structuredHostControl.ts:281-303`, `structuredSpawn.ts:193-208`,
`registry.ts:359-369`, the fence's `ownerAlive`) re-reads the identity before
signalling, and that discipline is what makes `TerminateProcess` safe here.

**Stale parent links.** Windows does not re-parent orphans; a dead parent's PID
can be reused by an unrelated process, so a raw `ppidMap` can name a false
parent and a tree walk could reach the wrong process. The backend drops any
parent link whose parent was created *after* its child (both times are in the
snapshot). This is a pure function over the snapshot and is unit-tested
everywhere; the CI leg on Windows proves the snapshot supplies the two times.

### Working directory

`readCwd(pid)`: `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)` →
`NtQueryInformationProcess(ProcessBasicInformation)` for the PEB address →
`ReadProcessMemory` of `PEB.ProcessParameters` (x64 offset `0x20`) →
`RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath` (offset `0x38`, a
`UNICODE_STRING`) → the buffer. Around sixty lines in the shape of
`src/lib/proc/darwinIdentity.ts:47-66`, cached per pid for the snapshot TTL.

Returns `null` (and the process stays invisible to `agentProcesses`, exactly
the macOS behaviour when `lsof` reports no cwd) when `OpenProcess` is refused
(elevated or another user's process) or the target is a WOW64 32-bit process
(different PEB layout; checked with `IsWow64Process` and skipped). Claude Code's
native binary is 64-bit, so the common case is covered.

This is the riskiest sixty lines in phase 1 and the one piece that could slip
to phase 2 without breaking the rest. If it slips, the honest degrade is:
processes the viewer spawned itself carry `--session-id` and stay attributable
through argv (`transcripts.ts:250`), and `agentProcesses` would need a one-line
relaxation to keep null-cwd processes whose argv carries a session id.
Interactive `claude` sessions started from a terminal would be invisible
until the PEB read lands. The phase-1a test list makes the choice visible:
`readCwd` has its own test case, and the phase cannot ship green without it.

### The rest of the contract

| Method | Windows source | Note |
|---|---|---|
| `pidAlive` | `process.kill(pid, 0)` | as `portable.ts:157-166`; `EPERM` counts as alive |
| `readArgv` | `CommandLine` split with `CommandLineToArgvW` rules (quotes, backslash runs) | pure function, unit-tested on every OS; needed because `C:\Program Files\…` carries a space and the engine sniff reads `argv[0]` |
| `readPpid` | snapshot, after the stale-link filter | |
| `readEnvVar` | `null` | as macOS |
| `listProcesses` | snapshot + `readCwd` per engine-matching pid only | the PEB read runs only for rows whose argv already sniffed as `claude`/`codex`, so cost scales with the number of agents |
| `tty` | constant `1` | see below |
| `systemMemory` | `os.totalmem()`, `os.freemem()` (available physical memory on Windows), swap 0 | no PowerShell call |
| `processMemory` | `WorkingSetSize` from the snapshot, `swapBytes: 0` | |
| `ppidMap` | snapshot | |
| `scanFdTargetsUnder`, `scanFdTargetsFor`, `pidWritesPath`, `pidHoldsPath` | no-ops (`false` / no visits) | no shipped tool enumerates handles; deferred |

**Why `tty` is a constant.** The field is only ever compared against 0
(`types.ts:34-37`). Zero means "headless": it unlocks the reaper's candidacy
(`headlessProcessReaper.ts:71,152`) and *blocks* the cwd-fallback attribution
(`transcripts.ts:194,267`). Windows has no cheap "has a console" probe. Reporting
nonzero for everything keeps interactive Claude sessions attributable and keeps
the reaper — which is opt-in and not ported in phase 1 — from ever selecting a
Windows process. Viewer-spawned hosts are attributed by `--session-id` first, so
they lose nothing.

### What the phase-1a tests prove on `windows-latest`

`src/lib/proc/windows.test.ts` (new):

1. `listProcesses()` contains the test's own pid with `argv[0]` naming the Bun
   executable — proves PowerShell is present, the CSV parses, argv splitting
   handles a quoted path.
2. `processIdentity(process.pid)` is stable across two calls and matches the
   `pid:` prefix shape; a spawned child's identity differs from a second
   child's; after the child exits, `processIdentity` is `null` and `pidAlive`
   is `false`.
3. `readCwd(child.pid)` equals the directory the child was spawned in.
4. `ppidMap().get(child.pid) === process.pid`; a synthetic snapshot with a
   parent created after its child yields no link (pure).
5. `processMemory([process.pid])` reports a positive `rssBytes`.

`src/lib/proc/index.test.ts` (new): backend selection by platform and override.
`src/lib/proc/memory.test.ts` and `portable.test.ts` run unchanged to prove
the pure parsers are platform-clean.

---

## Paths on Windows

### Homes and state

- **Transcript roots** stay `~/.claude/projects` and `~/.codex/sessions`
  (`roots.ts:74-80`). `path.join(os.homedir(), ".claude/projects")` produces
  `%USERPROFILE%\.claude\projects`, which is where Claude Code writes on
  Windows.
- **State and config** stay `~/.config/agent-log-viewer` (`configDir.ts:13-18`).
  Decision c: one location on every platform beats an `%APPDATA%` split that
  would need a migration on the next move and a second code path in the CLI,
  the MCP launcher and the provisioner (`bin/server-runtime.mjs:72-73`,
  `bin/mcp-server.mjs:21-22`, `bin/provision-telegram-connector.mjs:130`).
  `XDG_CONFIG_HOME` keeps working as an override.
- **`HOME` is ignored on win32.** Three places read `process.env.HOME` before
  `os.homedir()` (`artifact/route.ts:64`, `suggestionRoots.ts:34`,
  `seat/route.ts:33`) and two default it to a Linux path
  (`mcp-server.mjs:21`, `claudeLogin.ts:600`). A shell such as Git Bash can
  export a POSIX-style `HOME` (`/c/Users/…`) that `path.resolve` mangles. The
  phase-1c change is one predicate: on win32 these readers take `os.homedir()`
  unconditionally. Tested with a deliberately wrong `HOME` in the environment.
- **Temp** is `%TEMP%` through `os.tmpdir()`; `TMPDIR` set for read-only stages
  (`structuredSpawn.ts:133`) is inert for Windows children — the scratch
  directory still exists, the child's temp files land in `%TEMP%`. Documented,
  no change.

### Slugs

`slugifyCwd` (`transcript.ts:16-18`) maps `C:\work\proj` to
`C--work-proj`. That is the convention Claude Code uses for its
`projects/<slug>` directory on Windows, and the function is pure, so the
mapping is asserted on the Windows leg. What CI cannot assert is that the
installed Claude Code writes precisely that directory for a given cwd; that
needs an authenticated run and is listed under
[What cannot be settled from CI alone](#what-cannot-be-settled-from-ci-alone).

`repoPathFromSlug` (`describe.ts:229-268`) only serves the *deleted cwd*
fallback and assumes a slug starts with `-` (a POSIX root). Windows slugs
start with a drive letter, so the walk returns `null` and such a session
groups by its recorded cwd through the ordinary resolver. Deferred to phase 2
(seed the frontier with each drive root encoded as `X--`); the degrade is
named in the README.

### The worktree recognisers, in Windows form

The AGENTS.md invariant — a worktree's grouping must survive the checkout being
deleted, and live and dead checkouts must resolve to the same project — holds
on Windows for every recogniser that is path-shaped, because each is written
over `path.sep`.

| # | Recogniser | Linux form | Windows form | Status |
|---|---|---|---|---|
| 1 | `projectInfoFromClaudeTaskCwd` (`describe.ts:694-700`) | `<tmp>/claude-<uid>/<slug>/<session>/scratchpad/…` | unknown — Windows has no uid; whatever Claude Code names the container there is not derivable from this repo | **not CI-settleable**; phase 2 once observed; degrade: scratchpad agents group by their recorded cwd |
| 2 | `worktreeFromPath` (`:194-201`) | `<repo>/.claude/worktrees/<name>/…` | `<repo>\.claude\worktrees\<name>\…` | works; tested live and deleted |
| 3 | `worktreeFromNested` (`:212-222`) | `<repo>/worktrees/<name>` | `<repo>\worktrees\<name>` | works; tested |
| 4 | `worktreeFromCodexPath` (`:277-286`) | `~/.codex/worktrees/<hash>/<Repo>` | `%USERPROFILE%\.codex\worktrees\<hash>\<Repo>` | Codex route; untested in phase 1 |
| 5 | `worktreeFromGitFile` (`:423-437`, `parseWorktreeGitdir` `:289-297`) | `.git` file `gitdir: /abs/.git/worktrees/<name>` | `gitdir: C:/abs/.git/worktrees/<name>` — git for Windows writes forward slashes; `path.resolve` normalises to backslashes | works; tested with a forward-slash pointer |
| 6 | `worktreeFromMemory` (`:398-400`) | `state/worktree-map.json` keyed by cwd | same | works; case caveat below |

**Case.** NTFS paths are case-insensitive; the recognisers and every
`startsWith(root + path.sep)` containment compare strings exactly. The one
realistic divergence is the drive letter (`c:` from an MSYS shell, `C:` from
`cmd`/PowerShell/`os.homedir()`), which would split one worktree's sessions
across two project keys. `fs.realpathSync.native` already canonicalises the
on-disk case for directory identities (`identity.ts:41`). Phase 2 upper-cases
the drive letter in one place (the cwd read at `describe.ts` entry); phase 1
documents the limitation.

**Long paths.** A deep cwd under `~/.claude/projects/<slug>/` can exceed
`MAX_PATH` without the OS long-path policy; Claude Code has the same exposure,
so this is documented only.

**WSL split.** Transcripts written by a WSL-installed Claude live in the WSL
filesystem and are invisible to a native Windows viewer (and vice versa). The
README states: run the viewer where the agents run.

---

## Spawn and termination on Windows

### Environment

Phase 1c adds, on win32 only, to both `CHILD_ENV_ALLOWLIST`s: `SystemRoot`,
`SystemDrive`, `windir`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`,
`LOCALAPPDATA`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `ComSpec`,
`PATHEXT`, `USERNAME`, `COMPUTERNAME`, `NUMBER_OF_PROCESSORS`,
`PROCESSOR_ARCHITECTURE`. Windows environment names are case-insensitive in
`process.env`, so the existing `PATH` entry keeps matching `Path`. The test
spawns a Bun child with *only* the allow-listed environment and requires it to
load `node:http` and exit 0 — without `SystemRoot` that child fails at startup.

### Binary resolution

`resolveBinary` (`cli.ts:32-59`) on win32 probes, in order:
`%USERPROFILE%\.local\bin\<name>.exe`, `%USERPROFILE%\.bun\bin\<name>.exe`,
then returns the bare name and lets `CreateProcess` search `PATH` (libuv tries
`.exe` and `.com`; never `.cmd`). `LLV_CLAUDE_BINARY` remains the override
(`claudeStreamBrokerHost.ts:674`). `fs.accessSync(…, X_OK)` is meaningless on
Windows, so the probe becomes an existence check there.

The README says plainly: install Claude Code with the native installer, or put
a `claude.exe` on `PATH`; an npm-only install exposes `claude.cmd`, which the
viewer does not run. Wrapping the shim in `cmd.exe /c` would put the system
prompt and every argument through `cmd` quoting — the over-engineering pass
cut that.

### Spawn

`spawn(binary, args, { detached: true, windowsHide: true, stdio: pipes })`. On
Windows `detached: true` gives the child its own console (Windows has no process
groups), so Ctrl+C in the viewer's console does not reach it — the desired
outcome, matching the Linux intent of the flag. `windowsHide` keeps that console
window off the desktop.

### Termination

Facts: `process.kill(pid, anySignal)` is `TerminateProcess`; `process.kill(-pid)`
throws; no handler runs in the child. Both hosts already call
`this.child.stdin.end()` before their first signal
(`claudeStreamBrokerHost.ts:1445`, `codexAppServerHost.ts` equivalent), which
is the one graceful stop `claude -p` honours. Nothing changes in the ladders.

What changes is `signalProcessGroup` (`processGroup.ts:8-20`), the seam every
host and the stale-spawn reaper already go through. On win32 it takes the
current `ppidMap()`, computes `descendantPids(pid)` (`proc/memory.ts`, pure),
verifies each member's identity against the snapshot, and calls
`process.kill(member, signal)` children-first, then the leader. `taskkill /T /F`
does the same walk without the identity check and without ordering, so the
in-process walk is preferred; it also reuses the stale-link filter from the
backend. Job Objects (kill-on-close) are the proper Windows primitive and are
deferred: they need more FFI and change how the child is created.

`terminateStructuredHostTree` (`structuredHostControl.ts:281-430`) already does
this walk on every platform when the group id is unavailable, so the resource
rail's kill needs no port beyond the backend.

### What the phase-1c tests prove on `windows-latest`

- `processGroup.test.ts` (new): a child that spawned a grandchild; after
  `signalProcessGroup(child.pid, "SIGTERM")` both are gone and an unrelated
  process that reused a pid is untouched (the identity check).
- `claudeStreamBrokerHost.test.ts` (existing + one case): a stub `claude.exe`
  — a tiny Bun script compiled with `bun build --compile` in the job, or a
  copied `bun.exe` renamed, since the sniff accepts `claude.exe` — receives
  the stream-json handshake, and `release()` leaves nothing running.
- `cli.test.ts`: `resolveBinary("claude")` finds a planted
  `%USERPROFILE%\.local\bin\claude.exe` under an isolated home.
- `accounts/claude.test.ts`, `headlessSelection.test.ts`: mode-bit predicate
  on win32.
- `mcp-server.test.ts`, `suggestionRoots.test.ts`: `HOME` ignored.

---

## Runtime host and CLI on Windows

### IPC

`cliRuntimeHostConfig` (`server-runtime.mjs:69-83`) returns, on win32,
`socketPath: \\.\pipe\agent-log-viewer-<installId>` and a new
`fencePath: <stateDir>\runtime-host-<installId>.lock`. `runtime-host/main.ts`
reads `LLV_RUNTIME_HOST_FENCE` for the fence and keeps
`LLV_RUNTIME_HOST_SOCKET` for the pipe; on POSIX both default to today's values
so nothing moves. `serveRuntimeHost` skips `mkdir`/`unlink`/`chmod` for a pipe
name; `removeOwnedSocket` is a no-op for one. `net.createServer().listen(pipe)`
and `net.createConnection(pipe)` are the Node APIs for named pipes and are what
`bin/cli.mjs:406` and `runtime/client.ts:112` already call.

Bun documents named-pipe support for these `node:net` calls on Windows; the
socket test on the Windows leg is the proof that the viewer's framing, timeouts
and connection caps behave the same over a pipe.

**Access control.** A Unix socket inherits the state directory's `0700` and is
`chmod 0600` (`socket.ts:102`). A named pipe created through libuv carries the
default DACL. Whether another local account can connect and write to it is
**not CI-settleable** with one runner user. Phase 1 documents the viewer as
single-user on Windows (it binds loopback and the state directory sits under
the user's profile, so the exposure is the same class as the SQLite journal
beside it); if a stronger guarantee is wanted later, the pipe gains a
per-boot secret handshake, which is protocol-level and testable.

### Singleton fence

`RuntimeHostFence` keeps its file, its `O_EXCL` create, its JSON owner record
and its identity-based stale-owner reclamation (`runtimeHostFence.ts:100-145`).
Only the lock primitive changes: on win32 the `bun:ffi` binding loads
`kernel32.dll` and calls `LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK |
LOCKFILE_FAIL_IMMEDIATELY, …)` / `UnlockFileEx` on the descriptor's OS handle
(`_get_osfhandle` via `msvcrt`, or Bun's `fd → HANDLE` helper). The kernel
releases the lock when the process dies, which is the property `flock` gives
on Linux. `O_CLOEXEC` becomes `0` on win32 (`:12-13`). The two-contender race
test (`runtimeHostFence.test.ts`) runs on the Windows leg with its listener
sockets renamed to pipes — it is the test that proves exactly one host wins.

### Supervision and shutdown

The CLI's supervisor (`cli.mjs:439-517`) needs no change: it spawns
`bun.exe --bun <entrypoint>`, probes the pipe, reads the fence owner, restarts
with backoff. `stopChild` terminates; the host's `stop()` does not run under
`TerminateProcess`, so the journal closes via SQLite WAL recovery and the fence
lock via the kernel. The package smoke's restart-after-kill case proves a
second boot acquires the fence and serves.

### Browser

`openBrowser` on win32 spawns `rundll32.exe url.dll,FileProtocolHandler <url>`
detached and unref'd. No shell means no quoting of the `?k=<token>` query
(`cmd /c start` would need it). CI proves the spawn returns; a browser opening
is **CI-partial**.

---

## Phases

Each phase is one PR, ships on its own, and reverts on its own. Linux and macOS
paths are untouched in every phase: every change is a `process.platform ===
"win32"` arm or a new file. The `os` field flips last, so a revert of that one
PR re-blocks Windows installs while leaving the internals in place.

### Phase 0 — CI scaffold (no product code)

`.github/workflows/platform-tests.yml` with `ubuntu-latest` and
`windows-latest` legs running the **existing** pure-path and proc tests listed
in the matrix. Expected first result: green on Ubuntu; on Windows, green for
the pure files and red for anything that hard-codes a POSIX path in the *test*
(fixed in the same PR — tests only). This phase is what turns every later
claim into something CI can refuse. Revert: delete the workflow.

### Phase 1a — process backend

`src/lib/proc/windows.ts`, the argv splitter, the stale-link filter, selection
and `VIEWER_PROC_BACKEND=windows`, the `"windows"` name in `types.ts`, the
README env-table word. Tests: the five cases above. Nothing outside
`src/lib/proc/` changes behaviour. Revert: remove the file and the selector arm.

### Phase 1b — runtime host on Windows

Pipe naming and `fencePath` in `bin/server-runtime.mjs`, `runtime-host/main.ts`
and `bin/cli.mjs`; pipe-aware `serveRuntimeHost`; `LockFileEx` fence arm;
`O_CLOEXEC = 0` on win32. Tests: `socket.test.ts`, `runtimeHostFence.test.ts`,
`server-runtime.test.ts` on the Windows leg. Revert: the win32 arms.

### Phase 1c — spawn, terminate, homes, mode bits

Allow-list additions, `resolveBinary` win32 probes, `windowsHide`,
`signalProcessGroup` win32 arm, `HOME` ignored on win32, mode-bit predicate on
win32. Tests: the phase-1c list above. Revert: the win32 arms.

### Phase 1d — package flip and smoke

`"os": ["linux", "darwin", "win32"]`, `openBrowser` win32, `prepack.mjs`
invoking `next` through `process.execPath`, the smoke script's win32 tree kill,
README "Platform support" rewritten (see below), CHANGELOG entry. Tests: the
`windows-latest` package-smoke job. Revert this PR alone and Windows installs
fail with `EBADPLATFORM` again, exactly as today.

### Phase 2 — degraded pieces worth finishing

In rough value order: managed-account mode checks beyond the predicate (ACL
read via `icacls` is over-built; likely stays as the predicate); drive-letter
case normalisation; `repoPathFromSlug` drive roots; the scratchpad recogniser
once the Windows container name is observed; `RuntimeImageStore` on win32
(drop `O_DIRECTORY`, accept the mode) so composer images work; the login
supervisor reading through the backend; the resources rail's portable
arms exercised on Windows; the reaper with a real console probe if anyone
needs it. Each is its own small PR with its own Windows-leg test.

### Phase 3 — routes that stay WSL until upstream moves

Native Codex host (blocked on upstream declaring Windows stable and on the
`.cmd` shim question); `--tailscale` on Windows; the MCP server's targeted read
without `/dev/fd`; Telegram connector; local dictation.

---

## CI matrix

### Workflow

`.github/workflows/platform-tests.yml`

- Triggers: `pull_request`, `push` to `main`, `workflow_dispatch` (for the
  Dependabot-refresh dispatch pattern the other workflows use).
- `permissions: contents: read`.
- `oven-sh/setup-bun` pinned to the same commit and `bun-version: 1.3.3` as
  `privacy-publication.yml`.
- `bun install --frozen-lockfile`.
- Isolation on every leg: `LLV_STATE_DIR`, `XDG_CONFIG_HOME`, `HOME` (Ubuntu)
  / `USERPROFILE` (Windows), `TMP`/`TEMP`/`TMPDIR` all pointed at fresh
  directories under `${{ runner.temp }}`. `bunfig.toml`'s preload already pins
  `LLV_STATE_DIR` for the test process; the job-level values cover child
  processes the tests spawn.
- Tests run **by path**, one explicit list per leg. Never a directory sweep
  (AGENTS.md: sweeping `src/lib/agent/` or `src/app/api/runtime/` acts on live
  registry state; on a runner that state is empty, but the rule is the rule and
  the list is what keeps the job under ten minutes).

### Test list per leg

| File | Ubuntu | Windows | Phase | What the Windows pass proves |
|---|---|---|---|---|
| `src/lib/proc/memory.test.ts` | ✓ | ✓ | 0 | pure parsers |
| `src/lib/proc/portable.test.ts` | ✓ | ✓ | 0 | portable parser |
| `src/lib/proc/darwinIdentity.test.ts` | ✓ | ✓ | 0 | assertion is a no-op off Darwin |
| `src/lib/scanner/claudeNative.test.ts` | ✓ | ✓ | 0 | subagent lineage over `\` |
| `src/lib/scanner/transcriptIdentity.test.ts` | ✓ | ✓ | 0 | |
| `src/lib/scanner/projectDirectories.test.ts` | ✓ | ✓ | 0 | |
| `src/lib/agent/transcript.test.ts` | ✓ | ✓ | 0 | `slugifyCwd` on a drive path |
| `src/lib/projects/identity.test.ts` | ✓ | ✓ | 0 | `realpathSync.native` identity |
| `src/lib/scanner/describe.test.ts` | ✓ | ✓ | 0 (+ cases in 1d) | recognisers 2, 3, 5, 6 live and deleted; slug fallback returns null |
| `src/lib/scanner/roots.claude.test.ts` | ✓ | ✓ | 0 | roots under `%USERPROFILE%` |
| `src/lib/configDir.test.ts`, `configDir.staging.test.ts` | ✓ | ✓ | 0 | state dir shape |
| `src/lib/runtime/flags.test.ts`, `spawnTransport.test.ts` | ✓ | ✓ | 0 | |
| `src/lib/proc/index.test.ts` (new) | ✓ | ✓ | 1a | selection |
| `src/lib/proc/windows.test.ts` (new) | skipped | ✓ | 1a | the five backend cases |
| `src/lib/scanner/process.test.ts` | ✓ | ✓ | 1a | engine sniff with `claude.exe` |
| `src/runtime-host/socket.test.ts` | ✓ | ✓ | 1b | pipe round-trip |
| `src/runtime-host/runtimeHostFence.test.ts` | ✓ | ✓ | 1b | single winner over `LockFileEx` |
| `bin/server-runtime.test.ts` | ✓ | ✓ | 1b | pipe and fence paths |
| `src/lib/processGroup.test.ts` (new) | ✓ | ✓ | 1c | tree kill with identity check |
| `src/lib/runtime/structuredHostControl.test.ts` | ✓ | ✓ | 1c | sweep without a group id |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | ✓ | ✓ | 1c | allow-listed env boots a child; stub `claude.exe` handshake |
| `src/lib/agent/cli.test.ts` | ✓ | ✓ | 1c | `.exe` probe |
| `src/lib/accounts/claude.test.ts`, `headlessSelection.test.ts` | ✓ | ✓ | 1c | mode predicate |
| `bin/mcp-server.test.ts`, `src/lib/projects/suggestionRoots.test.ts` | ✓ | ✓ | 1c | `HOME` ignored |
| `src/lib/scanner/transcripts.test.ts`, `activity.test.ts` | ✓ | ✓ | 1c | attribution and liveness without fd holders |

The Ubuntu leg runs the same list so the "Linux unchanged" claim has a witness
for every touched file. macOS has no leg: the maintainer's machine is Linux and
the Darwin paths are unchanged by design; a `macos-latest` leg is a one-line
addition if that ever changes.

### Package smoke (phase 1d, `windows-latest` only)

A second job in the same workflow, `package-smoke-windows`, gated on
`pull_request` paths touching `bin/`, `scripts/prepack.mjs`, `package.json`,
`src/runtime-host/` or `src/lib/proc/`, and on `push` to `main`:

1. `bun install --frozen-lockfile`; `actions/setup-node` (the CLI's shim runs
   under Node, as it does for users).
2. `bun scripts/prepack.mjs` — proves the standalone build and the runtime-host
   bundle produce on Windows.
3. `npm pack`, then `npm install -g <tarball>` into an isolated prefix —
   proves the `os` field admits win32 and the `bin` shims install.
4. `bun scripts/npm-package-smoke.mjs` under isolated `USERPROFILE`,
   `XDG_CONFIG_HOME`, `LLV_STATE_DIR`, `TEMP` — proves the CLI boots the
   runtime host over the pipe, the viewer answers `/api/files`, a fake
   `claude.exe` planted in `%USERPROFILE%\.local\bin` is spawned and
   terminated, and a second CLI boot after a hard kill reacquires the fence.

Budget: `next build --webpack` on a Windows runner is the long pole (several
minutes); the whole job should stay under fifteen. It is the one job that
proves the acceptance sentence "`agent-log-viewer` starts the viewer".

### Agent probes (manual dispatch, network)

`workflow_dispatch` only: on `windows-latest`, install Claude Code with the
documented native installer command and run `claude --version`; `npm i -g
@openai/codex` and run `codex --version`. Each proves the binary resolves the
way `resolveBinary` expects (the `.exe` under `%USERPROFILE%\.local\bin` for
Claude; a `.cmd` shim for both npm routes). Neither needs credentials. Neither
is a PR gate — they are the re-check for the "at the time of writing" facts
in section G.

---

## What stays unsupported or degraded in phase 1

Unsupported on native Windows (documented in the README's platform section):

- Codex CLI hosting, review flows and every Codex-side feature — **WSL remains
  the supported route for Codex.**
- Telegram connector — **WSL remains the supported route.**
- Local dictation (faster-whisper); cloud dictation backends are unaffected.
- Workflow setup commands (`sh -c`) and the pipeline/flow features that shell
  out through POSIX tools.
- The in-app Claude login supervisor; log in from a terminal with `claude`.
- Managed (multi) Claude accounts: the Main account is the one that works.
- Composer image attachments to structured hosts (`RuntimeImageStore`).
- `--tailscale`.
- The MCP server (`agent-log-viewer-mcp`) for orchestrator agents.
- Docker deployments, staging, `scripts/rebuild.sh` — Linux-only by nature.
- An npm-installed Claude Code (`claude.cmd`); use the native installer.

Degraded on native Windows (the feature narrows, nothing crashes):

- Live-writer detection has no handle scan: a transcript shows `live` from
  mtime recency and its process from `--session-id` argv or cwd, never from an
  open-file holder. Background-task `.output` files cannot be mapped to a pid.
- Process memory shows working set only; no swap; no per-process swap.
- Kill is immediate on every path (`TerminateProcess`); the "force" step in
  the task header is a second immediate kill.
- Claude background tasks (`claude-tasks` root) and scratchpad grouping depend
  on a Windows layout nobody has observed; until then the root is absent and
  scratchpad sessions group by their recorded cwd.
- A session whose recorded cwd differs from its root only by drive-letter case
  forms its own project.
- The `--session-id`-less interactive session started from a terminal is
  visible only while the PEB read succeeds for it (it will not for an elevated
  console).
- Read-only stages keep their scratch directory while the child's temp files
  land in `%TEMP%`.
- The host's `stop()` handler does not run when the CLI terminates it; the
  journal relies on WAL recovery.

---

## What cannot be settled from CI alone

Stated plainly, so nobody reads a green matrix as proof of these:

1. **Claude Code's on-disk layout on Windows** — the exact `projects/<slug>`
   directory it writes for a cwd, the background-task container under `%TEMP%`,
   and the scratchpad path shape. A public runner has no Claude session.
   Mitigation: `slugifyCwd` is the documented convention and is asserted as a
   pure function; the other two are phase 2 and degrade to "absent".
   A maintainer-only `workflow_dispatch` job that reads an
   `ANTHROPIC_API_KEY` secret and runs `claude -p "hi" --session-id …` on
   `windows-latest` would settle the first two; it is proposed as optional
   because it spends money and needs a secret the repository does not hold.
2. **Named-pipe access from another local account.** One runner user cannot
   test cross-user connection. Documented as single-user.
3. **A browser actually opening** from `rundll32`. Headless runner.
4. **Behaviour under an elevated (Administrator) console** — `OpenProcess`
   rights, the profile paths — differs from the runner's unelevated session.
5. **Codex's native Windows behaviour** beyond `codex --version`. Out of scope
   by decision f.
6. **Real user hardware**: antivirus interfering with `bun.exe` spawning
   `claude.exe`, corporate policies blocking PowerShell. The README asks the
   reporting user to run the CLI with `--no-open` and paste the log; that is
   the feedback channel this design relies on after phase 1d ships.

Everything else in this document is covered by a named test on the Windows leg.

---

## README changes (phase 1d)

The "Platform support" section (`README.md:309-325`) becomes: Linux native via
`/proc`; macOS via the portable backend; **Windows native (phase 1)** with the
list above of what works and what stays WSL; the tmux paragraph is replaced by
one sentence saying the structured transport needs no tmux. The env table adds
`windows` to `VIEWER_PROC_BACKEND`. A "Windows notes" paragraph states: native
Claude installer required; run the viewer where the agents run (WSL vs native
transcripts do not mix); state lives under `%USERPROFILE%\.config\agent-log-viewer`.

---

## Hard-to-reverse decisions

Two choices persist into files and would need a migration to change later;
they are recorded here, without separate ADRs, because neither trade-off
is large:

- **State under `%USERPROFILE%\.config`** (decision c). Moving to `%APPDATA%`
  later means a `migrateLegacyDir` pass like `configDir.ts:60-110`. Accepted
  because one path on every platform removes three code paths today.
- **Identity token = `pid:FILETIME`** (decision b). It is written into registry
  rows and the fence file. Any other Windows source (e.g. a `Get-Process`
  `StartTime` in ticks) would need a translation. Accepted because it is the
  kernel's own value and matches what the two other backends store.

---

## Deferred — not currently justified

Kept here so the scope is visible; none is demanded by the originating
requirement.

- **Job Objects** for kill-on-close termination. Correct, but needs FFI on the
  spawn side and changes how every child is created. The ppid walk with
  identity checks is what Linux already falls back to.
- **A TCP loopback runtime socket with a token.** Would
  give cross-platform ACL semantics; costs a new authentication step on every
  platform.
- **`taskkill /T`** as the group primitive. Fewer lines than the walk, no
  identity check, force-only; rejected for the seam every host uses.
- **`%APPDATA%` state directory**; see decision c.
- **Resolving `claude.cmd` shims** to their `node …\cli.js` target, or wrapping
  them in `cmd.exe /c`. The native installer makes it unnecessary.
- **Handle enumeration** (`NtQuerySystemInformation` handle tables) to restore
  fd-holder detection. Large, fragile, and mtime plus `--session-id` already
  answer the questions the viewer asks.
- **`Win32_PageFileUsage` swap accounting**; a second PowerShell call for a
  number the rail only displays.
- **A macOS CI leg**. Nothing here changes Darwin behaviour.
- **Parameterising the recognisers over `path.win32`** so Windows shapes could
  be tested on Linux. The Windows leg tests the real thing; the refactor would
  touch every recogniser for no user-visible gain.
- **Native Codex host** and everything in phase 3.

---

## Over-engineering pass

What was on the table and cut, with the simpler mechanism kept:

| Considered | Kept instead |
|---|---|
| Two PowerShell calls (`Get-Process` for start time + CIM for command line) | one CIM call with a `ToFileTimeUtc()` projection |
| JSON transport from PowerShell | CSV (5.1's JSON dates lose precision) |
| A PowerShell `Add-Type` C# helper for cwd | `bun:ffi`, already the pattern on Darwin |
| Job Objects | ppid walk through the existing `signalProcessGroup` seam |
| `cmd /c start` with quoting rules | `rundll32 url.dll,FileProtocolHandler` |
| Separate `%APPDATA%` layout | `~/.config` everywhere |
| Rewriting every containment check for case-insensitivity | one drive-letter normalisation, phase 2 |
| A full Windows port of the resources worker, reaper and login supervisor in phase 1 | portable arms and "unavailable" states; phase 2 |
| A macOS matrix leg | none |

The phase-1 change set is: one new backend file (~250 lines plus FFI), one
argv splitter, one lock primitive, one pipe-name rule, one allow-list
extension, one `.exe` probe, one predicate for mode bits, one predicate for
`HOME`, one tree-kill arm, one browser opener, one `prepack` invocation change,
one `os` field entry, and the tests that prove each of them.

---

## Validation against the originating requirement

> Add Windows support. Today `package.json` declares `"os": ["linux", "darwin"]`,
> so `npm install` on Windows fails with `EBADPLATFORM`; README says "WSL works
> as Linux". There is no Windows process backend.

- "`npm install` fails with `EBADPLATFORM`" → phase 1d flips the `os` field,
  and the smoke job's `npm install` of the packed tarball on `windows-latest`
  is the proof.
- "There is no Windows process backend" → phase 1a adds one, with the identity
  token the issue asked to be named concretely (`pid:FILETIME` from
  `Win32_Process.CreationDate`), and says which of PowerShell / `tasklist` /
  WMI supplies it and why.
- "README says WSL works as Linux" → the README keeps that sentence for the
  routes that stay WSL (Codex, Telegram, local dictation) and adds the native
  section.
- The issue's phase-1 acceptance: install succeeds (1d smoke), the viewer
  starts (1d smoke), transcripts under the Windows home are discovered (0/1d
  roots and describe tests), running `claude` processes show (1a backend
  tests), a structured Claude host spawns and is killed (1c host and group
  tests over a stub `claude.exe`; the real binary is the manual probe),
  Linux/macOS unchanged (Ubuntu leg on every touched file), a `windows-latest`
  job exists (phase 0), the README states what is native and what needs WSL
  (1d).

Every phase serves that sentence; nothing in phase 1 goes beyond it. Whether
a working subset beats completeness was decided the issue's way: phase 1 makes
Claude-on-Windows usable and leaves the rest named for later.
