# Manual tmux procedure — viewer down only

Use this only after the probe `curl -sS http://127.0.0.1:8898/api/files >/dev/null` fails. It replicates the viewer's own spawn path (`spawnAgentWithPrompt` in `src/lib/tmux.ts`). Viewer tmux socket: `/run/user/1000/agent-log-viewer/tmux-1000/default`.

## Spawning

1. `PANE=$(tmux new-window -d -P -F "#{pane_id}" -t <active-session>: -n <window-name> -c <cwd>)` — pick the active session via `tmux list-clients -F "#{client_activity} #{client_session}"` (freshest wins), fallback `list-sessions`.
2. Type the boot command literally, then Enter:
   - claude: `claude --dangerously-skip-permissions --session-id $(uuidgen)` (+ `--model <m>`); the session-id makes the transcript path knowable: `~/.claude/projects/<cwd with non-alnum → "-">/<sid>.jsonl`.
   - codex: `codex -c model_reasoning_effort=<low|medium|high|xhigh>` (+ `-m <model>`).
3. Poll readiness every ~1s (≤60s): `tmux capture-pane -p -t $PANE`. Ready markers: `? for shortcuts`, `Context N% used`, `⏎ send`, `Press up to edit`. Startup gates (`Do you trust`, `Press enter to continue`, `Resume from summary`) default to the safe option — answer with Enter and keep polling. If the foreground command falls back to a shell, the agent died: read the screen tail for the error.
4. Deliver the prompt as a bracketed paste (multi-line text corrupts over raw send-keys):
   `tmux load-buffer -b <buf> <file>` → `tmux paste-buffer -d -p -b <buf> -t $PANE` → sleep ~0.5s → `tmux send-keys -t $PANE Enter`.
5. Verify submission: if the composer line (last line starting with `❯` or `›`) still shows the prompt head or `[Pasted text`, press Enter again (an extra Enter on an empty composer is a no-op).
6. Record lineage so the board links the child under its parent: add `{"<child transcript path>": "<parent transcript path>"}` to the `children` map in `~/.config/agent-log-viewer/state/handoff-lineage.json` (for codex, find the rollout by grepping `~/.codex/sessions/YYYY/MM/DD/*.jsonl` for a prompt fragment). Edit this file only while the viewer is stopped — the running server caches it in memory and overwrites external edits; if the viewer restarted meanwhile, restart it after the edit.

Done when: the pane shows a ready composer, the prompt is submitted, and the lineage entry exists.

## Messaging

Find the pane by walking `/proc` ppid chains from the target process to `tmux list-panes -a` pids, then use the same paste-verify procedure (steps 4–5). Before sending, read the screen: a shell prompt means no agent lives there; an approval or rate-limit wall means resolve that first, then paste.
