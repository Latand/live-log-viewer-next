# Issue 25 runtime spike: Codex app-server and Claude stream-json

Run date: 2026-07-12, Europe/Kyiv. Worktree branch: `agent/issue-25-runtime`.

## Result

Start the migration with Codex app-server. It provides native multi-client subscriptions, same-turn steering, interruption, structured approvals, persisted threads, and ChatGPT subscription authentication. Put Claude behind a durable broker that owns one stream-json process and supplies replay, fan-out, queue accounting, and delivery idempotency.

The two prototypes ran on this machine with Codex CLI 0.144.1 and Claude Code 2.1.197. Child processes received no OpenAI or Anthropic API-key environment variables.

| Probe | Observed result | Evidence |
| --- | --- | --- |
| Codex auth | `accountType:"chatgpt"`, `planType:"pro"` | [`codex-app-server.jsonl`](../../spikes/issue-25/evidence/codex-app-server.jsonl) |
| Codex late attach | Second OS process resumed an active thread with one replayed turn and received live item/turn events | same log |
| Codex injection | `turn/steer` accepted the original active turn ID; both clients observed that turn complete with `STEERED-OK` | same log |
| Codex recovery | Fresh app-server process resumed the persisted thread and recalled `ZEBRA-25` | same log |
| Claude auth | `authMethod:"claude.ai"`, `subscriptionType:"max"`, `system/init.apiKeySource:"none"` | [`claude-stream-json.jsonl`](../../spikes/issue-25/evidence/claude-stream-json.jsonl) |
| Claude late attach | Second OS process joined during partial output with replay sequences 1-6 and received 68 later events | same log |
| Claude injection | Broker acknowledged the stdin write as `queued`; the following turn returned `INJECTED-OK` | same log |
| Claude recovery | Restarted broker used `--resume`, kept the same session ID, and recalled `ORCHID-25` | same log |

The issue-specific scripts live in [`spikes/issue-25/`](../../spikes/issue-25/README.md). A broader earlier probe report remains in [`docs/research/runtime-host-spike-2026-07.md`](../research/runtime-host-spike-2026-07.md).

## Comparison with the tmux host

| Capability | Codex app-server | Claude stream-json with broker | Current tmux path |
| --- | --- | --- | --- |
| Live attach | A second WebSocket client calls `thread/resume`, receives stored turns, then receives current notifications | Broker replays events after a sequence and fans new events to every subscriber | Human attaches to a pane; LLV snapshots rendered terminal cells |
| Mid-run message | `turn/steer` appends input to the active turn and requires `expectedTurnId` | A user line written during an active turn waits for the following turn | LLV pastes text into the TUI composer and verifies rendered output |
| Interrupt | `turn/interrupt` cancels a named active turn | Claude control protocol supports an explicit interrupt request; the broker must expose it as a separate action | LLV sends terminal keystrokes and infers the result from the pane |
| Resume after host restart | A fresh app-server calls `thread/resume` against the persisted Codex rollout | A fresh broker starts Claude with `--resume <session-id>` against the persisted transcript | tmux preserves the process while tmux lives; dead panes require CLI resume logic |
| Late-view replay | Thread response includes stored turn history; live notifications follow | Broker owns the replay window; production needs a durable event cursor | Terminal scrollback provides presentation-oriented history |
| Raw TTY takeover | `codex --remote` can connect the Codex terminal UI to an app-server listener; structured clients cover LLV control | stream-json exposes structured stdio; it has no shared human TTY | Native feature of tmux |

LLV machine control no longer needs raw TTY takeover after these adapters ship. Keep a human escape hatch during migration. For Claude, handoff must release the broker writer claim before an interactive `claude --resume` session starts. Codex can use its remote terminal client against the app-server endpoint where the deployed CLI supports that transport.

## Research questions

### 1. Steering, queueing, and interruption

Codex steering changes the active turn. The second process sent `expectedTurnId` and app-server returned that same ID. `STEERED-OK` arrived before the original turn completed. A stale turn ID gives #12 a protocol-level compare-and-swap failure that the queue can retry after refreshing state.

Claude stream-json accepts another user line while generation is active. The live run queued it and produced a second `user`/`assistant`/`result` sequence after the original result. The broker must record that disposition as `queued-next-turn`. Urgent replacement requires an explicit interrupt control request followed by a new user message. Queue policy must never turn a normal send into an implicit interrupt.

### 2. Multi-client and late attach

Codex app-server handled two WebSocket clients connected to one server. The later process resumed the active thread, read stored turn state, received live item deltas, steered the current turn, and received the shared terminal event.

Claude owns one stdio pair. The broker became the sole writer and assigned every engine event a monotonic sequence. On connection it sent all retained events after the viewer cursor, then added the viewer to live fan-out. The prototype observed replay sequences 1-6 followed by 68 live events. Production should persist the cursor and delivery ledger so a broker restart can reconstruct replay from the Claude transcript.

### 3. Crash and restart recovery

Codex persists thread rollouts under `~/.codex/sessions`. The prototype stopped its app-server child, launched a new one, called `thread/resume`, and completed a context-recall turn. The thread ID and rollout path stayed stable.

Claude persists session transcripts and accepts `--resume <session-id>`. The prototype stopped its broker and Claude child after both queued turns, launched a new broker, resumed the same ID, and completed a context-recall turn. A process crash during generation loses the in-flight turn after its last persisted event; the supervisor can adopt the session and start another turn.

### 4. Subscription authentication

The Codex app-server returned ChatGPT account type `chatgpt` and plan `pro` while `OPENAI_API_KEY` was absent from its environment.

`claude auth status` reported a first-party `claude.ai` login with subscription type `max`. Claude emitted `system/init.apiKeySource:"none"` while `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` were absent. The installed CLI read its existing subscription OAuth/keychain login. The prototype uses Claude Code CLI stream-json mode. Anthropic's public Agent SDK documentation directs third-party products to API-key authentication, so LLV should keep the local single-user subscription adapter on the CLI surface unless Anthropic publishes a supported subscription SDK contract.

The Claude probe uses `--safe-mode` because `--bare` disables OAuth/keychain reads in Claude Code 2.1.197. Safe mode removes local skills, hooks, plugins, MCP servers, memory, and `CLAUDE.md` customizations while leaving authentication active.

### 5. Waiting and idle state

Replace pane heuristics with an event-derived state machine:

1. `running`: a Codex `turn/started` lacks its matching terminal event, or Claude has accepted a user input whose `result` has not arrived.
2. `attention`: the engine emitted a structured approval, tool-mediated user question, or elicitation request that lacks a response.
3. `idle`: the latest turn ended, no tool item remains open, no attention request remains open, the outbound queue has no sending entry, and the host health check succeeds.
4. `idle_maybe_waiting`: the state meets `idle` and the final assistant text looks like a free-form question or request for a reply.

Only `attention` carries a hard waiting-for-input guarantee. Free-form prose has no protocol-level waiting flag. LLV can display `idle_maybe_waiting` as a soft cue and route the next send as a new turn. This policy avoids blocking delivery on punctuation or terminal rendering.

Codex state inputs are `thread/status/changed`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, and server requests such as `item/*/requestApproval`. Claude state inputs are replayed user messages, assistant events with `stop_reason`, tool use/results, control requests, and terminal `result` events.

## Recommendation and migration seams

Ship the Codex adapter first. Its protocol already supplies the hardest ownership features: multi-client subscription, active-turn fencing through `expectedTurnId`, client delivery IDs through `clientUserMessageId`, explicit interruption, account state, and structured approvals.

Replace machine-side `tmux attach` with one host interface shared by two adapters:

```ts
interface EngineHost {
  attach(afterSeq: number): AsyncIterable<RuntimeEvent>;
  send(entry: QueueEntry): Promise<DeliveryReceipt>;
  interrupt(turnRef: string): Promise<void>;
  answer(attentionRef: string, value: unknown): Promise<void>;
  health(): Promise<HostState>;
  release(): Promise<void>;
}
```

`CodexAppServerHost` maps this interface to app-server JSON-RPC. `ClaudeStreamBrokerHost` maps it to the broker WebSocket and the owned stream-json stdin/stdout pair.

For registry issue #10, store the engine session key as durable identity: Codex thread ID or Claude session ID. Host kind, endpoint, PID plus process start time, event cursor, CLI/protocol version, writer-claim epoch, active turn reference, and pending attention belong in mutable host columns. On LLV restart, the registry adopts each row through `thread/resume` or `claude --resume`.

For queue issue #12, persist the queue entry before actuation. Codex sends the entry ID as `clientUserMessageId` and uses `expectedTurnId` for steering. A retry first scans persisted thread items for that client ID. Claude needs a durable broker ledger that records the queue entry before writing stdin and confirms delivery from `--replay-user-messages` or the transcript. The prototype ledger and replay buffer live in memory, so production durability belongs in #10/#12 storage.

Keep legacy tmux hosting behind its current adapter while sessions migrate. Remove pane parsing and composer paste from structured-host sessions as each engine adapter reaches production verification.

## Sources

- [Codex app-server protocol](https://developers.openai.com/codex/app-server)
- [Claude Code programmatic and stream-json usage](https://code.claude.com/docs/en/headless)
- [Claude Agent SDK overview and authentication policy](https://code.claude.com/docs/en/agent-sdk/overview)
