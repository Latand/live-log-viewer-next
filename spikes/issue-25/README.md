# Issue 25 structured-runtime prototypes

These Bun prototypes exercise the installed Codex and Claude Code CLIs through their structured local channels. They remove `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` from every child environment. Both CLIs then use their existing local subscription login.

## Prototype A: Codex app-server

```bash
bun spikes/issue-25/codex-app-server-demo.ts
```

The demo performs this sequence:

1. Starts `codex app-server` on a loopback WebSocket.
2. Connects an owner client, confirms `account.type: "chatgpt"`, starts a thread, and starts a turn that remains active during `sleep 8`.
3. Spawns `codex-late-viewer.ts` as a second OS process.
4. The later client calls `thread/resume`, receives replay and live events, then calls `turn/steer` with the active turn ID.
5. Both clients observe completion of the same turn.
6. The demo stops its app-server child, starts a fresh app-server process, resumes the thread, and verifies retained conversation context.

The default listener is `ws://127.0.0.1:8977`. Override it with `--port`. The demo writes sanitized evidence to `evidence/codex-app-server.jsonl`; override the path with `--log`.

## Prototype B: Claude stream-json broker

```bash
bun spikes/issue-25/claude-stream-json-demo.ts
```

`claude-broker.ts` owns one long-lived process with the required flags:

```text
claude -p --input-format stream-json --output-format stream-json --verbose
```

It also enables partial messages, replayed user messages, safe mode, a deterministic probe prompt, and no tools. Safe mode keeps machine-local customizations out of the evidence while preserving OAuth/keychain login. The broker exposes a loopback WebSocket with monotonically increasing event sequences and a bounded replay buffer.

The demo connects an owner, waits for live partial output, then spawns `claude-late-viewer.ts` as a second OS process. The later viewer receives replay, subscribes to live events, and writes another user message to the same Claude stdin. Claude queues that message for the next turn. The demo then restarts the broker with `--resume <session-id>` and verifies retained context.

The default listener is `ws://127.0.0.1:8987/events`. Override it with `--port`. The demo writes sanitized evidence to `evidence/claude-stream-json.jsonl`; override the path with `--log`.

## Tests

```bash
bun test spikes/issue-25/lib.test.ts
```

The tests cover replay sequencing, bounded history, evidence redaction, and fragmented Codex text assembly. The live demos provide the protocol integration checks.
