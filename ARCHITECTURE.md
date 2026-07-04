# Live Log Viewer — Next.js rewrite

Rewrite of the working Python prototype at
`the original single-file Python prototype (../live-log-viewer/server.py)` (READ IT FIRST — it is the
behavioral reference; every feature it has must survive the port unless this
document overrides it).

Local single-user tool. Tails Codex/Claude agent logs into a chat-style UI.
Runs with `bun dev` (dev) / `bun run build && bun start` on **127.0.0.1:8899**.

## Hard constraints

- The app process binds loopback by default; remote access exists only through
  `tailscale serve` behind the `src/proxy.ts` token gate. API routes must reject
  any `path` outside the whitelisted roots (port `path_allowed` exactly:
  realpath + prefix check).
- No database, no external services. Filesystem only.
- Keep the light design language: white panels, soft borders/shadows,
  bg `#f6f6f8`, Codex teal `#0d8a72` (+soft `#e3f4f0`), Claude coral `#d97757`
  (+soft `#faeee9`), accent `#5a51e0`. Ukrainian UI labels, same wording as the
  prototype.
- All UI text/labels, icons (✳ ⤷ ⌘ ⚙ ❯), chips (model / project / activity)
  as in the prototype.
- TypeScript strict. Tailwind utilities, no CSS files besides `globals.css`
  (tokens + reset only).

## Data roots (same as prototype)

| root key         | path                                                        |
|------------------|-------------------------------------------------------------|
| codex-jobs       | ~/.claude/plugins/data/codex-openai-codex/state             |
| codex-sessions   | ~/.codex/sessions                                           |
| claude-projects  | ~/.claude/projects                                          |
| claude-tasks     | /tmp/claude-1000 (ONLY `<slug>/<sid>/tasks/*.output` files) |

## Stack (verified 2026-07-03)

Next.js 16.2.10 (LTS, App Router, Turbopack), React 19.2, Tailwind CSS 4.3
(CSS-first `@theme` config — tokens already defined in `src/app/globals.css`),
TypeScript 5 strict, bun.

## bin/

`bin/cli.mjs` is the published `agent-log-viewer` entrypoint. It resolves the
package root from its own file location, chooses a standalone server when one is
available, falls back to local `next start`, sets `PORT` and `HOSTNAME`
explicitly for the child, polls readiness on `127.0.0.1`, and owns shutdown for
the server and optional Tailscale child.

`bin/tailscale.mjs` contains Tailscale-specific orchestration for the CLI:
binary detection, `tailscale status --json` parsing, foreground
`tailscale serve <port>`, operator-permission hints, and the persistent
`0600` token file under `${XDG_CONFIG_HOME:-~/.config}/agent-log-viewer/token`.

## Token proxy

`src/proxy.ts` is the Next.js Proxy file. When `LLV_TOKEN` is empty, it passes
requests through unchanged. When a remote request arrives, it accepts a matching
`llv_auth` cookie or a matching `?k=` query parameter; valid query-key requests
are redirected with `k` stripped and an HttpOnly cookie set. The matcher is
`/((?!_next/static|favicon.ico).*)`, so static chunks and favicon bypass the
token gate.

`src/lib/sameOrigin.ts` protects mutating API routes from browser cross-origin
requests. Its allowed hosts are the loopback names plus
`hostWithoutPort(process.env.LLV_TS_HOST)` when the CLI sets a tailnet DNS name.
Both the `Host` header and any `Origin` header must resolve to that allowlist.

## Environment contract

| variable | set by | effect |
|----------|--------|--------|
| `LLV_TOKEN` | CLI for `--tailscale` and non-loopback binds | Enables the proxy token gate for remote requests. Empty or absent means passthrough. |
| `LLV_TS_HOST` | CLI after `tailscale status --json` | Adds the tailnet DNS name to same-origin allowed hosts. |
| `LLV_TS_URL` | CLI when `--tailscale` is used | Full tailnet URL (with `?k=` token) returned by `GET /api/access` for the in-app QR button. Absent means the button shows the "start with --tailscale" hint. |
| `LLV_STANDALONE` | `scripts/prepack.mjs` | Enables `output: "standalone"` during publish packaging only. |

## File tree and ownership

Already implemented by the architect — DO NOT rewrite, build on top:

```
src/lib/types.ts               shared DTOs (FileEntry, LogChunk) — the API contract
src/lib/scanner/roots.ts       ROOTS, EXTS, MAX_CHUNK, FILE_CAP, pathAllowed()
src/lib/scanner/caches.ts      globalCache<V>(name) — globalThis-backed Maps
src/app/api/log/route.ts       chunked tail endpoint (complete, security-critical)
src/app/api/files/route.ts     thin wrapper over listFiles()
src/app/globals.css            Tailwind import + @theme design tokens
src/app/layout.tsx             fonts, lang=uk, viewport shell
src/app/page.tsx               renders <Viewer/>
src/hooks/useFiles.ts          10 s polling hook (complete)
```

To implement (stubs with contracts exist where noted):

```
src/lib/scanner/discover.ts    walk + filter + cap                (new)
src/lib/scanner/describe.ts    titles/kind/engine/fmt/project     (new)
src/lib/scanner/activity.ts    tail records + turn state          (new)
src/lib/scanner/model.ts       model extraction                   (new)
src/lib/scanner/needle.ts      incremental byte scanner           (new)
src/lib/scanner/links.ts       parentage + bg command recovery    (new)
src/lib/scanner/index.ts       listFiles() pipeline               (stub)
src/hooks/useLogTail.ts        1.2 s tail polling                 (stub, contract in file)
src/components/Viewer.tsx      app shell                          (stub)
src/components/Sidebar.tsx     search, mode toggle, groups, tree  (new)
src/components/FileRow.tsx     icon + title + chips row           (new)
src/components/LogFeed.tsx     feed container + follow logic      (new)
src/components/TaskHeader.tsx  pinned bg-task command card        (new)
src/components/feed/*.tsx      renderClaude/renderCodex/renderPlain (new)
```

Keep components small and prop-driven; server logic stays in `src/lib/scanner`
(pure functions + caches, no Next imports) so it is unit-testable.

## Server side (Node runtime, App Router route handlers)

### Agent questions and notifications

Live Claude transcripts are checked for a pending `AskUserQuestion` or
`ExitPlanMode` only at the tail: the scanner considers the latest assistant
message and ignores older unanswered tool calls once the assistant has moved
on. `src/lib/scanner/questions.ts` normalizes the structured payload into
`FileEntry.pendingQuestion`; `src/lib/scanner/waitingInput.ts` supplies the
scrape fallback for non-structured TUI prompts after a stable screen and a
prompt-like tail.

Answers go through `src/app/api/answer/route.ts`. The route trusts only scanner
known live transcripts, resolves the tmux pane from the scanner pid, verifies a
short normalized fragment of the question on screen, navigates with arrows, and
checks the highlighted option label before pressing `Enter` or `Space`.
Confirmation polls the single transcript for the matching `tool_result`.

Question visibility rides on the normal `/api/files` poll. Feed cards live in
`src/components/feed/QuestionCard.tsx`; overview promotion is handled by the
switchboard/project rail state. In-app notifications use the page title, a
dismissible toast, and the question chime. Closed-tab notifications use the
Push API: VAPID keys and subscriptions live under `~/.claude/viewer-state`,
payloads are encrypted with `aes128gcm`, and the service worker opens the
deep link for the waiting session.

`src/app/api/files/route.ts` — GET, returns the shortlisted file entries
(same JSON shape as the prototype `/files`: path, root, name, project, title,
engine, kind, fmt, parent, mtime, size, activity, model, cmd, cmdDesc).

`src/app/api/log/route.ts` — GET `?path&offset` — chunked tail read, same
semantics as prototype `/log` (MAX_CHUNK 768 KiB, offset reset, utf-8 replace).

Port the scanner pipeline from server.py into `src/lib/scanner/*.ts`, keeping
the caching strategy (all caches are module-level singletons on `globalThis`
so dev hot-reload does not wipe them):

- `discover.ts` — walk roots, filter extensions, skip tool-results and
  scratchpads, cap at 400 by mtime desc.
- `describe.ts` — project/title/kind/engine/fmt (port `describe`,
  `_scan_jsonl_title`, `_project_from_slug` incl. `-home-<user>` → `<user>`).
- `activity.ts` — port `_tail_records`, `_jsonl_turn_state`, `_activity`
  (age-gated, size-keyed cache).
- `model.ts` — port `_entry_model` + `_short_model` (meta.json → tail records →
  head-40-lines fallback; ignore `<synthetic>`).
- `links.ts` — port `_link_entries`: background-task command recovery
  (`_bg_command` needle search), subagent parentage via meta.json toolUseId,
  codex-jobs parentage via job JSON sessionId + job-id needle, rollout↔job via
  threadId in filename, project inheritance from root ancestor.
- `needle.ts` — port `_find_needle` (append-only incremental byte scanner).

Performance budget: warm `/api/files` under ~150 ms (measure). Do the same
optimizations the prototype does; never re-read unchanged files.

## Client (src/components + hooks)

- `Sidebar` — search, «Дерево / Стрічка» toggle (persisted), project groups,
  virtual-friendly plain rendering is fine (400 rows max).
- `FileRow` — type icon (✳ session-claude / ⤷ subagent / ⌘ codex session /
  ⚙ codex job / ❯ bash task), title, chips: model, kind, project (flat mode
  only), activity (`працює` pulsing green / `закінчив` amber), age · size.
  Non-conversation rows (jobs, bash tasks) are "aux": mono font, dimmed,
  1-line clamp, tighter padding.
- `LogFeed` — poll `/api/log` every 1.2 s with a generation token (no stale
  chunk races), partial-line buffer, 2500-node cap, follow-mode autoscroll that
  auto-disables when the user scrolls up and re-enables at bottom, placeholders
  («Завантаження…», «Ще без виводу — файл поки порожній»).
- Renderers (port 1:1 from prototype): `renderClaude`, `renderCodex`,
  `renderPlain` — user bubbles, assistant prose (dedupe consecutive identical),
  cmd cards with ✓ ok / ✗ exit N / ✗ помилка statuses (tool_result arrival =
  finished; use is_error), edit cards, service lines behind «Службові» toggle,
  line filter input.
- `TaskHeader` — pinned card for claude-tasks files: description + `$ command`,
  or explicit «Команду … не знайдено у транскриптах сесії».
- Header bar: engine badge + model chip + kind + title (path in tooltip),
  Follow / Пауза / Службові buttons, status (size · time).

## Sorting and collapsing — THE PART THE USER CARES ABOUT MOST

Tree mode:
1. Project groups: **stable alphabetical order** (uk locale). Groups NEVER
   reorder because of activity.
2. Inside an expanded project: roots AND children sorted by **subtree
   last-update DESC** — the freshest item is always on top within a project.
3. Collapse everywhere:
   - project headers collapsible (chevron ▶/▼, hidden count + `N live` badge);
   - every tree node with children collapsible with its own chevron;
   - **default state: collapsed**, except (a) subtrees containing a `live`
     entry, (b) ancestors of the currently opened file;
   - manual expand/collapse always wins over defaults and persists in
     localStorage (`llvProjOpen`, `llvNodeOpen` maps);
   - collapsed node shows `+N` hidden-descendants chip (with green dot if a
     live item is hidden inside);
   - active search temporarily expands everything that matches.

Flat mode («Стрічка»): single global list by mtime DESC, no group headers,
project chip + model chip on every row.

## State persistence (localStorage)

`llvTree` (mode), `llvProjOpen`, `llvNodeOpen`, last opened file path
(restore selection on reload if the file still exists).

## Verification (must pass before you finish)

1. `bun run build` — green, no type errors.
2. `bun dev --port 8899` (background) and exercise with curl:
   `/api/files` returns entries with parent links, models, recovered task
   commands; `/api/log?path=...` streams chunks; disallowed path → 403.
3. Compare a few entries against the running prototype at
   http://127.0.0.1:8799/ (`curl http://127.0.0.1:8799/files`) — same files,
   same titles/parents.
