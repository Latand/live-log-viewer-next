# Backlog: sticky plan limits, per-agent context usage, effort-coded visuals

Recorded 2026-07-05 from user feedback. Three independent problems, no
implementation yet — each needs its own small spec pass before coding.

## 1. Plan limits flicker in and out

Symptom: the Claude/Codex plan-limit numbers in the sidebar footer
(`/api/limits`, commit 7824abe) appear and disappear between polls —
«то есть, то нет». Once a value has been shown it must never blank out.

Direction:
- Server: cache the last successful limits read (globalThis cache +
  `~/.claude/viewer-state/limits-cache.json` so it survives restarts).
  A failed/empty refresh returns the cached value with a `staleSince`
  timestamp instead of nothing.
- Client: keep the last non-empty payload; render stale values dimmed with
  an age hint («станом на 14:02») rather than dropping the block.
- While at it, log WHY reads fail (source file missing? parse error? rate
  window rolled over?) — the root cause of the flicker is unknown.

## 2. Per-agent context-window usage

The user cannot see how full each agent's context is; wants it per agent,
everywhere an agent is shown (dashboard cards, switchboard, header).

Signals available today:
- codex rollouts: `token_count` records in the transcript tail carry total
  tokens and the model context window (the TUI footer «Context N% used»
  derives from them).
- claude transcripts: assistant records carry `message.usage`
  (input_tokens + cache_read_input_tokens + cache_creation_input_tokens);
  window size must come from a model→window map (200k default, 1M for
  models running with the 1M beta).

Direction: scanner extracts `ctx: {usedTokens, windowTokens, pct}` per
transcript in the tail pass (size-keyed cache like turn state), FileEntry
gains the field, UI renders a compact chip/bar (e.g. «ctx 31%») with
amber ≥70% and red ≥90%.

## 3. Visual encoding of reasoning effort per agent

The user wants to SEE at a glance which effort tier an agent runs —
color/brightness/intensity of the agent's card or chip.

Known tiers:
- codex: `model_reasoning_effort` = minimal | low | medium | high | xhigh
  (session_meta in the rollout head; also `-c` argv of the live process).
- claude: no per-session effort flag today; proxies are the model itself
  (haiku/sonnet/opus/fable) and thinking budget (`MAX_THINKING_TOKENS`,
  ultrathink) — VERIFY current claude CLI/API effort options at
  implementation time before designing the scale.

Direction: scanner extracts an `effort` field where detectable (codex
head record / argv; claude left null until a reliable source exists);
UI maps tiers to a brightness/saturation ramp of the engine color
(dim → vivid as effort rises) plus a tooltip with the raw value, so the
encoding works for both engines and stays legible for color-blind users
(brightness, not hue alone).

## 4. Worktree sessions must group under their parent project

Symptom (screenshot 2026-07-05): every git worktree cwd
(`<repo>/.claude/worktrees/<name>`) becomes its own project in the rail —
truncated slugs like «-agents-tools-live-lo…» and «limits-sticky» sit next
to «live-log-viewer-next» instead of inside it.

Direction: collapse the worktree segment in the DISPLAY project derivation
(`src/lib/scanner/describe.ts` — both the claude slug path and the codex
head-cwd path): a cwd containing `/.claude/worktrees/<name>` maps to the
parent repo's project; keep the worktree name visible on the entry itself
(small chip/suffix, e.g. «wt: limits-sticky»). Do NOT touch pid-attribution
keys in `src/lib/scanner/transcripts.ts` — those must keep matching the real
cwd, only the grouping label changes.
