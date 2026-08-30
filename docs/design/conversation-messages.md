# `conversation_messages` — one page-bounded read of any conversation (#1311)

Design stage, 2026-08-30. Decides how a newest-first, kind-filtered page of
one conversation is served with cost bounded by the page, specifies the tool,
the read function, identity, bounding, the rotation mandate and the tests.
No product code is written here; the fixture generator and the measurement
harness live under `scripts/`.

## Originating requirement

From issue #1311, operator directive of 2026-08-30, "given after watching a
rotation successor write a one-off Python JSONL dumper to read its
predecessor's last turns":

> One Viewer MCP tool that reads the messages of **any** conversation — Claude
> or Codex, the predecessor at rotation or any worker at any time — as
> engine-normalized records, filterable by kind (user text, assistant text,
> tool calls, tool results, reasoning), newest-first, and **fast**. Agents must
> never guess the transcript format again, and they must not fall back to
> `curl` against the internal API: **MCP is the priority surface, HTTP the
> fallback.** The operator also asked that the read be served from SQLite
> rather than by re-parsing JSONL, since the Viewer already keeps
> transcript-derived state there.

Everything below is validated against that paragraph.

## Decision

**Serve the page with a reverse tail-window reader over the transcript,
stopping when the page is full. Leave the transcript-search SQLite index as it
is.** The operator's preference for SQLite is not followed to the letter, and
this section says why with the numbers; the intent behind it — never re-parse
the rollout to answer "what did this agent last say" — is met exactly: a first
page from a 116 MB rollout parses 300 of its 24 621 lines.

### What was measured

Fixtures come from `scripts/conversation-messages-fixture.ts` (synthetic,
deterministic, record mix taken from the type histograms of a real 102 MB
rollout and a real 27 MB Claude session — token-count events, encrypted
reasoning blobs, doubled message representations, hook attachments, tool
outputs carrying most of the bytes; no real content). The harness is
`scripts/conversation-messages-bench.ts`; it refuses to run without
`LLV_STATE_DIR`, so the index build can never touch the live
`transcript-search.sqlite`. Reproduce with:

```
bun scripts/conversation-messages-fixture.ts /tmp/llv-1311/fixtures
LLV_STATE_DIR=/tmp/llv-1311/state bun scripts/conversation-messages-bench.ts /tmp/llv-1311/fixtures
```

Codex rollout: 115 765 454 bytes, 335 turns, 24 621 records, 1 462 distinct
user/assistant messages. Claude transcript: 32 014 747 bytes, 55 turns, 2 726
records, 173 messages. Page = `limit: 20`, `kinds: ["message"]` unless stated.
Medians of 20 runs, warm page cache, Bun 1.3.3.

| Read | Codex 116 MB | Claude 32 MB |
| --- | --- | --- |
| Today: `readSession` (parses the last 8 MiB) | 27.5 ms | 20.6 ms |
| (a) index: build / rebuild after one append (full re-read) | 395 ms / 387 ms | 84 ms / 95 ms |
| (a) index: first page, bodies from the index, transcript bytes read | 0.03 ms, 0 B | 0.03 ms, 0 B |
| (a) index: tenth page | 0.04 ms, 0 B | — (9 pages exist) |
| (a) index: first page hydrated from byte offsets | 0.33 ms, 1.17 MB¹ | 0.29 ms, 1.25 MB¹ |
| (b) reverse reader: first page | **4.5 ms, 1.84 MB, 300 lines** | **6.0 ms, 2.36 MB, 275 lines** |
| (b) reverse reader: tenth page | 4.3 ms, 1.84 MB, 326 lines | 5.8 ms, 2.36 MB, 275 lines |
| (b) `roles: ["user"]` first page (rarest kind) | 18.7 ms, 7.3 MB, 1 492 lines | 30.2 ms, 11.5 MB, 1 015 lines |
| (b) `kinds: ["tool_call","tool_result"]` first page | 0.5 ms, 256 KB, 50 lines | 2.1 ms, 768 KB, 49 lines |
| (b) `limit: 200`, all five kinds | 4.3 ms, 1.84 MB, 276 lines | 9.1 ms, 3.4 MB, 375 lines |
| (b) nothing matches, per-call scan ceiling 16 MiB | 42 ms, 16 MiB, 3 547 lines | 65 ms, 16 MiB, 1 422 lines |
| (b) full cursor walk: pages / records / unique / descending | 74 / 1 462 / 1 462 / yes | 9 / 173 / 173 / yes |

¹ The index stores a byte offset and no line length, so hydration reads 64 KiB
per row and finds the newline; the lines themselves are far smaller.

The cursor walk's record count equals the index's message count for both
files: the reader's collapse of Codex's doubled messages agrees with the
index's, and paging has no repeats and no gaps.

### Why the tail reader, given the SQLite preference

Both approaches bound the *query* by the page. They differ in what else the
read depends on, and the shape of this read — the newest records of a file
that is being appended to right now — is exactly where those differences bite:

1. **Freshness.** The index is refreshed after a completed corpus scan
   republishes the catalog (`src/lib/scanner/fileScanWorker.ts:231`,
   `src/lib/search/transcriptFeed.ts`), and the writer answers an append by
   dropping the file's rows and re-reading the whole file
   (`indexTranscriptSources`, `removeTranscript` then re-insert). Between two
   scans a page served from the index is missing everything appended since —
   for "what did this agent last say", the part the caller wants most. Closing
   that gap means reading the tail past the indexed size, which *is* the
   reverse reader; (a) is therefore (b) plus an index plus a staleness rule.
   Under `NODE_ENV=test` indexing is never scheduled at all.
2. **Coverage.** The index holds user/assistant message bodies only. Serving
   `tool_call`, `tool_result`, `reasoning` and `trace` from it means 24 621
   rows for this rollout instead of 1 462 (17×), and either storing tool
   outputs — the bulk of the bytes, so the index approaches the size of the
   corpus — or storing offsets and hydrating from the file, which is a file
   read again, now needing line lengths the schema does not have (footnote 1).
3. **Cursor stability.** Byte offsets never move under append, so a reverse
   cursor is stable by construction. Index paging over `message_index` with an
   offset shifts after every append and needs a keyset cursor plus a rule for
   the moment the file is re-indexed.
4. **Availability.** A conversation spawned since the last scan, a transcript
   the catalog has not measured yet, or any target under `NODE_ENV=test` has
   no index rows; the file is always there.

Against that, the index's page is ~100× faster in absolute terms: 0.03 ms
versus 4–6 ms. Both are invisible next to the 30 s tool deadline
(`src/lib/mcp/server.ts:2185`) and the seconds an agent turn costs, and the
tail reader's worst case — a filter that matches nothing — is capped at one
16 MiB window per call (42–65 ms) and returns an empty page with a cursor.
The tail reader is clearly better for this shape of read because it is
correct on a live file with no second mechanism, and it costs 1.6 % of the
rollout per page. If a later need appears for deep seeks with rare filters,
the same tool contract can be served index-assisted without a schema change;
that is recorded under "Deferred".

## The tool

Name stays `conversation_messages`; nothing in the issue argues for another.

### Parameters

| Parameter | Type | Default | Clamp / validation |
| --- | --- | --- | --- |
| `clientRequestId` | string | required | as every tool |
| `conversationId` | string | — | `conversation_…` id; one of the three identity forms is required |
| `transcriptPath` | string | — | must lie under a scanner root (`pathAllowed`, root containment) |
| `selectedContext` | `selectedContextSchema` | — | same acceptance and refusals as `get_conversation` |
| `kinds` | array of `message \| reasoning \| tool_call \| tool_result \| trace` | `["message"]` | non-empty, deduplicated |
| `roles` | array of `user \| assistant \| system \| tool` | all four | non-empty, deduplicated |
| `since` | string | — | ISO-8601 with offset; invalid → refusal `conversation_messages_since_invalid` |
| `limit` | integer | 20 | 1..200, clamped via `MCP_BOUNDED_NUMERIC_ARGS` |
| `maxChars` | integer | 4 000 | 1..16 000, clamped via `MCP_BOUNDED_NUMERIC_ARGS` |
| `cursor` | string | — | opaque token from the previous page; wrong scope or stale → refusal |

`limit` and `maxChars` are registered in `MCP_BOUNDED_NUMERIC_ARGS` so
`schemaParity.test.ts` checks the clamps automatically; `kinds`, `roles` and
`since` are Zod enums/strings in `TOOL_INPUT_SCHEMAS`. The description in
`TOOL_DESCRIPTIONS` states the contract so a first call succeeds:

> Read one conversation's messages newest-first as engine-normalized records
> (Claude and Codex look identical; hook attachments, usage envelopes and
> token counts never appear). Identity: conversationId, transcriptPath or
> selectedContext, resolved like get_conversation. kinds ⊆ message | reasoning
> | tool_call | tool_result | trace (default message); roles ⊆ user |
> assistant | system | tool (default all); since = ISO timestamp lower bound.
> limit 1..200 (default 20); each record's text is cut at maxChars (default
> 4000) with truncated: true. Pass the returned cursor for the next-older
> page while hasMore is true. Cost is bounded by the page: a 100 MB rollout is
> never parsed. An empty page is a normal answer.

`get_conversation`'s description gains one trailing sentence — "For
normalized, filtered, paged messages use conversation_messages." — and its
parameters and responses do not change.

### Response

```jsonc
{
  "conversationId": "conversation_…" | null,
  "transcriptPath": "…",
  "engine": "claude" | "codex",
  "lastRecordAt": "2026-08-30T10:12:03.000Z" | null,   // newest timestamp in the file, any kind, unfiltered
  "records": [ /* newest first */
    { "seq": 115700123, "kind": "message", "role": "assistant", "ts": "…", "text": "…" },
    { "seq": 115698871, "part": 1, "kind": "tool_result", "role": "tool", "ts": "…", "text": "…", "truncated": true, "name": "shell" },
    { "seq": 115690002, "kind": "message", "role": "user", "ts": "…", "text": "…", "phase": "commentary" }
  ],
  "hasMore": true,
  "cursor": "…" | null,
  "scanned": { "bytes": 1835008, "lines": 300, "capped": false },
  "selectedContext": { … }                              // echo, only when selectedContext was used
}
```

Record shape, identical for both engines: `{ seq, part?, kind, role, ts, text,
truncated?, name?, phase? }`. `seq` is the byte offset of the record's source
line and is monotonic within the transcript; `part` is present only when one
line yields several records (a Claude user record carrying several
`tool_result` blocks) and orders them within the line. `name` is the tool name
for `tool_call`/`tool_result` and the trace type for `trace`; `phase` is
Codex's message phase when the rollout carries one. `ts` is the record's ISO
timestamp or null. `scanned` is what the call cost, so an empty page with
`hasMore: true` explains itself (the scan ceiling was hit before a match) and
so the test can compare the self-report with the bytes actually read.

Ordering is newest first across pages: page 1 holds the newest records, the
cursor names the position just older than the oldest record returned.
`since` is a lower bound (records with `ts >= since`); the scan stops at the
first record older than `since` and returns `hasMore: false`. A record with no
timestamp never stops the scan.

### Cursor

`base64url(JSON)` of `{ v: 1, o: <offset>, p: <part>, s: <scope>, r: [...] }`:

- `o` — byte offset of the line to resume at; `p` — the part index below which
  that line's records are still unread (0 = resume with the previous line).
- `s` — sixteen hex characters of `sha256(transcriptPath, sorted kinds, sorted
  roles, since ?? "")`, the pattern `search_transcripts` uses
  (`cursorScope`). A cursor presented with different filters or against
  another transcript is refused with `conversation_messages_cursor_invalid`;
  it is never silently re-scoped.
- `r` — up to 8 entries `{ h, t, e }`: the twin-collapse window (hash of
  role+normalized body, timestamp ms, representation `e`vent or `r`esponse)
  carried across the page boundary so a Codex message whose two
  representations straddle two pages is still collapsed once.
- `o` greater than the file's current size means the transcript was truncated
  or replaced: refusal `conversation_messages_cursor_stale`; the caller starts
  over without a cursor.

## The read function

`src/lib/session/messagesPage.ts`:

```ts
export interface MessagesPageSource {
  descriptor: number;               // pinned, O_NOFOLLOW, already identity-checked by the binding
  size: number;                     // fstat at open
  engine: "claude" | "codex";
}
export interface MessagesPageQuery {
  kinds: ReadonlySet<SessionRecordKind>;
  roles: ReadonlySet<SessionRecord["role"]>;
  since?: string;
  limit: number;
  maxChars: number;
  cursor?: MessagesPageCursor | null;
}
export interface ConversationMessage extends SessionRecord { seq: number; part?: number; truncated?: true }
export interface MessagesPage {
  records: ConversationMessage[];
  cursor: MessagesPageCursor | null;
  hasMore: boolean;
  lastRecordAt: string | null;
  scanned: { bytes: number; lines: number; capped: boolean };
}
export function readMessagesPage(source: MessagesPageSource, query: MessagesPageQuery): MessagesPage;
export function encodeMessagesCursor(cursor: MessagesPageCursor, scope: string): string;
export function decodeMessagesCursor(token: string, scope: string): MessagesPageCursor;   // throws InvalidMessagesCursorError
```

Algorithm (the prototype in `scripts/conversation-messages-bench.ts` is the
reference; the product version differs only in using the shared normalizer):

1. `end = cursor?.o ?? size`. If `cursor.p > 0`, read forward from `cursor.o`
   to the next newline (one line) and emit that line's parts `< p`, newest
   part first.
2. Read the window `[max(0, end − 256 KiB), end)` with `fs.readSync` on the
   descriptor. Prepend the previous window's carry (the bytes before its first
   newline, i.e. the head of a line that started earlier). The absolute offset
   of window byte `i` is `start + i`. When a window has no newline and
   `start > 0`, the whole window is carry; a carry past 16 MiB is an oversized
   line, dropped and counted, and the scan continues.
3. Walk the complete lines of the window from the last to the first. Each
   line is `JSON.parse`d once and handed to the shared normalizer; the
   records come back newest-part-first, run through the twin collapse, then
   `kinds`/`roles`/`since`, and are appended with `seq = start + lineStart`.
   Unparsable lines are skipped.
4. Stop when `limit` records are held (cursor = the position of the first
   record not taken), when a record is older than `since` (`hasMore: false`),
   when offset 0 has been consumed (`hasMore: false`), or when the call has
   read 16 MiB (`capped: true`, `hasMore: true`, cursor = current `end`).
5. `lastRecordAt` is the timestamp of the file's last line, taken from the
   first window on an uncursored call and from one extra tail read (at most
   one window) on a cursored one.
6. Reads are synchronous on a pinned descriptor, like
   `boundedTailFromDescriptor`; the 16 MiB ceiling bounds the blocking time
   (≈45–65 ms measured). The MCP server is its own process per agent, so this
   never blocks the Viewer.

Twin collapse, Codex only: rollouts write every user/assistant message twice
(`response_item` `message` and `event_msg` `user_message`/`agent_message`,
same timestamp, adjacent). The reader keeps the first seen (the later in the
file) and drops the older twin when role and whitespace-normalized body match,
the representation differs and the timestamps are within 2 s — the rule
`readTranscriptMessages` in `src/lib/search/transcriptSearch.ts` already
applies when indexing, which is why the walk count equals the index count.
`readSession` does not collapse twins today; `get_conversation` keeps
returning both, unchanged.

Normalizer extraction in `src/lib/session/reader.ts`: the bodies of
`readClaude` and `readCodex` become `normalizeSessionLine(engine, obj):
Array<{ record: SessionRecord; representation?: "event" | "response" }>`,
and `readClaude`/`readCodex` loop over it and `push(out, record)`. `readSession`'s
output is unchanged (guarded by `reader.test.ts` and the existing
`get_conversation` tests). Two Codex mappings in the shared normalizer are
corrected because the new tool exposes `reasoning` and today's mapping hides
it: `event_msg/agent_reasoning` becomes `kind: "reasoning"` (today a trace),
and `response_item/reasoning` takes its text from `summary[].text` (today it
looks at `payload.text` and drops the record; `encrypted_content` is opaque
and never emitted). Neither reaches `get_conversation`, which returns only
`messages` and `tools`, nor `incumbent.ts`, which counts traces named
`compact`.

What is never a record, by the existing normalizer: Claude `attachment`,
`system`, `last-prompt`, `ai-title`, `mode`, `queue-operation`,
`permission-mode`, `file-history-*`; Codex `session_meta`, `turn_context`,
`compacted`, and any payload without a type. Claude task notifications stay
`trace`/`task-notification`; Codex `token_count`, `task_started`, and the
rest of `event_msg` stay `trace` under their payload type.

## Identity resolution — reuse of `get_conversation`'s paths

The binding `conversationMessages()` in `src/lib/mcp/bindings.ts` contains no
engine knowledge; it resolves a target, opens it pinned, calls
`readMessagesPage`, bounds and redacts.

1. `resolveSelectedContext(args, text(args.conversationId), selectedDependencies)`
   — the same call and the same refusals as `get_conversation`
   (`selected_context_invalid`, `selected_context_empty`,
   `selected_context_unresolved`, `selected_context_conflict`).
2. With a `conversationId`: the identity half of `selectedConversationTail`
   (`src/lib/mcp/selectedContextTarget.ts`) is extracted into
   `selectedConversationTarget(request, deps)` returning the
   `SelectedConversationRecord` — one keyed registry lookup, then the
   `pathAllowed` gate — with its refusals unchanged
   (`selected_context_unresolved`, `selected_conversation_has_no_transcript`,
   `selected_conversation_outside_roots`); `selectedConversationTail` calls it
   and then reads its tail as before. The record supplies `path`, `engine`,
   `conversationId`. This is the bounded identity path `get_conversation`
   takes with `tailLines`.
3. With a `transcriptPath`: the first half of `targetedConversationAtPath` —
   `pathAllowed`, `rootForTranscript`, `O_NOFOLLOW` open, `fstat`,
   `sameOpenedTranscript` — is extracted into
   `openPinnedTranscript(pathname, { roots, pathAllowed }) → { descriptor,
   stat, rootName } | undefined`, and `targetedConversationAtPath` uses it.
   The engine comes from the root: `codex-sessions` → codex,
   `claude-projects` → claude, anything else (OpenClaw) → refusal
   `conversation_messages_engine_unsupported`. `conversationId` is
   `agentRegistry().conversationForPath(path)?.id ?? null`. No `describe()`,
   no `readSession`, no `/proc/self/fd` symlink: the reader takes the
   descriptor directly.
4. Both routes end in the same `openPinnedTranscript` call (the registry-minted
   path from step 2 is gated too, as `selectedConversationTail` gates it), so
   there is one open path and one identity re-check. Neither identity form
   consults the completed catalog or any scan; the tool keeps answering while
   the corpus scan is degraded, as `get_conversation` with `tailLines` does.
5. Test seam: `ViewerMcpDomainDependencies` gains `pinnedTranscript?:
   (pathname) => PinnedTranscript | undefined` beside `targetedFileEntry`,
   defaulting to `openPinnedTranscript` with `scanRootEntries()`; tests inject
   roots pointing at a temp directory.

The tool is read-only: it is not added to `MUTATING_MCP_TOOL_NAMES`, receipt
retention is `bounded`. `presentation.ts` gets a card beside
`get_conversation`'s ("Reading messages: <id or path>", link to the
conversation when an id is known).

## Redaction and bounding

- Per record, in this order: the normalizer's text, then `hardenedRedact` on
  the full text (patterns need the whole string to match), then cut to
  `maxChars` characters with `truncated: true` when anything was cut.
- The assembled payload then passes through `redactPayload` exactly as every
  other tool's does (string redaction plus `SENSITIVE_PAYLOAD_KEY` key
  masking). No record key matches that pattern, so `name`/`phase` survive.
- Per-call bounds: `limit ≤ 200`, `maxChars ≤ 16 000`, so a response is at
  most 3.2 MB of text and 80 KB by default; per-call file cost `≤ 16 MiB`
  read; an individual line above 16 MiB is skipped, never buffered.
- `text` of a `trace` is the JSON of the payload (today's behaviour), bounded
  the same way. Codex `encrypted_content` never becomes text.

## Rotation mandate

`src/lib/orchestrator/seatCommand.ts:775-777` currently renders, when a path is
known, "Your predecessor's full transcript — decisions, blockers, in-flight
work — is at: <path>. Review its recent turns before acting." That sentence is
what produces hand-rolled readers. It becomes one unconditional line (the
incumbent's id is always known, so the "path is not recorded" branch goes):

> Your predecessor's recent turns — decisions, blockers, in-flight work — are
> one call away: `conversation_messages` with `conversationId`
> "<incumbent.conversationId>", `roles` ["user","assistant"], `limit` 40
> (newest first; pass the returned `cursor` for older turns). Read them before
> acting, and never open the transcript file. If the call reports that the
> conversation has no transcript, reconstruct state from the board.

`predecessor.path` still feeds `summarizeHandoffs` (internal digest input,
unchanged) and `rotatedFrom.path` stays in the response. The sentence in
`docs/orchestrator.md:134` ("the predecessor's identity and transcript path")
changes to name the identity and the `conversation_messages` call.

## Test plan

All runs by path under an isolated `HOME`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR`
and `TMPDIR`; nothing sweeps `src/lib/agent/` or `src/app/api/runtime/`.

`src/lib/session/messagesPage.test.ts` (hand-written small fixtures):
- Same record shape from a Claude transcript and a Codex rollout carrying the
  noise the histograms show (attachments, `last-prompt`, `system` hook
  summaries, usage envelopes; `token_count`, `turn_context`, `session_meta`,
  encrypted reasoning): none of it appears; a user text, an assistant text, a
  tool call, a tool result and a reasoning record come out with identical
  keys for both engines.
- Codex twins collapse to one record, including a twin split across a page
  boundary (limit chosen to land between the two representations).
- `kinds`, `roles`, `since` filter server-side; `since` stops the scan and
  reports `hasMore: false`; a `since` newer than everything returns an empty
  page with no error.
- Cursor walk with `limit: 1` and with `limit: 7` over a fixture containing a
  Claude user record with three `tool_result` parts: the union of pages equals
  the forward sequence, no repeats, no gaps, `part` resumes mid-line.
- `limit` and `maxChars` clamps; `truncated` appears only on cut records.
- Nothing matches: empty page, `hasMore: true`, `scanned.capped: true`, and
  following the cursor eventually reaches `hasMore: false`.
- A 20 MiB single line is skipped and later lines are still returned.
- Cursor from another scope and cursor past the file's size are refused with
  their codes.
- Redaction: a fixture record holding a token-shaped string comes back
  `[redacted]`.

`src/lib/session/messagesPage.performance.test.ts` — the no-whole-file-read
assertion. The generator in `scripts/conversation-messages-fixture.ts` is made
importable (`generateCodexRollout(path, bytes, seed)` with the CLI under
`import.meta.main`) and writes a ≥100 MB rollout into the test's temp dir
(~2 s). The test wraps `fs.readSync` with `spyOn(fs, "readSync")` (a property
spy on the module object, no `mock.module`, so nothing leaks across files) and
asserts, for the first page and for the tenth page reached through cursors:
- the sum of bytes returned by `readSync` during the call is below 4 MiB and
  below 5 % of the file size;
- `scanned.bytes` equals that sum (the self-report is honest);
- `fs.readFileSync`, `fs.createReadStream` and `fs.promises.readFile` were not
  called with the fixture path;
- wall time under 250 ms (the measurement says ~5 ms; the margin absorbs CI).
The same test reads the Claude fixture at 30 MB with the same assertions.

`src/lib/mcp/bindings.test.ts`:
- `conversation_messages` by `conversationId` (injected resolver whose scan
  methods throw), by `transcriptPath` (injected roots at a temp dir), by
  `selectedContext`; each returns `engine`, `transcriptPath`,
  `conversationId`, `lastRecordAt`, records, `hasMore`, `cursor`.
- Refusals: missing identity, path outside roots, OpenClaw root, stale
  cursor.
- `get_conversation` and `agent_activity` existing tests pass unchanged (that
  is the byte-identical guarantee; no new test is needed for it).

`src/lib/mcp/schemaParity.test.ts` — unchanged file; it iterates
`MCP_TOOL_NAMES` and `MCP_BOUNDED_NUMERIC_ARGS`, so the new tool's clamps are
covered once registered. `src/lib/mcp/presentation.test.ts` gets the card.

`src/lib/orchestrator/seatCommand.test.ts` — the composed successor mandate
contains `conversation_messages` and the incumbent's id and does not contain
the predecessor's path.

`src/lib/session/reader.test.ts` — unchanged; guards the normalizer
extraction.

Gates for the builder: `bunx tsc --noEmit --incremental false`; the files
above by path; `bun scripts/build-mcp.ts` (the bundle changes);
`bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD origin/main)`.
Lint is broken repo-wide (#1259) and is not a gate.

## Flagged and cut

- **Extending the transcript-search index to tool/reasoning records** (the
  issue's option (a)). Cut for the reasons measured above; the index keeps
  serving `search_transcripts` unchanged.
- **A second HTTP surface.** The issue names HTTP only as the fallback;
  `/api/session` already exists for the Viewer. Nothing new.
- **An ADR.** The decision is reversible behind the tool contract (an
  index-assisted seek could serve the same schema later), so no ADR.
- **Cooperative async reads with yields.** The 16 MiB ceiling bounds a
  synchronous read to tens of milliseconds inside the agent's own MCP
  process; an async reader with `yieldToRuntime` is not justified.

## Deferred — not currently justified

- Index-assisted seeks: extend `transcript_messages` with `kind`, `role`,
  `name`, `line_length`, keyset paging on `message_index`, and a tail-delta
  read from `transcript_files.size` to EOF, so a page deep in a multi-GB
  rollout under a rare filter (`roles: ["system"]`) resolves in one call. The
  measured worst case today is 42–65 ms per 16 MiB call with a cursor to
  continue; revisit if a caller actually pages that deep.
- Collapsing Codex twins in `readSession`/`get_conversation`. Out of scope
  because `get_conversation` must stay byte-identical.
- A total-response character bound beyond `limit × maxChars`.
