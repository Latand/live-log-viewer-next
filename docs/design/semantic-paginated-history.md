# Semantic paginated history

## Originating requirement

> Live = byte stream, History = indexed semantic pages. The pagination unit must become the semantic item/turn, kept in a disposable SQLite projection over the JSONL (which stays the source of truth — the index is NEVER canonical; a wrong projection is deleted and rebuilt). The next step is a design doc docs/design/semantic-paginated-history.md engineered against the current useLogTail -> FeedSession -> LogFeed pipeline, including the SQLite schema, cursor semantics and the tricky boundary cases. Do not rewrite useLogTail; the live logBus/SSE path stays as is.

Source: operator direction, 2026-08-31, embedded as the requirements anchor in issue #1327.

This design was verified against repository commit `0fc855c3a6a52a0b7e785e79ffd343740d3335bc`.

## Decision

Add a `SemanticHistoryIndex` module with one read interface: fetch a bounded page of normalized feed summaries for a conversation. The module owns an incremental SQLite projection and derives every row from the JSONL transcript. It also mints opaque cursors and body references. Callers never supply a transcript path or SQLite row id.

Keep the existing byte stream as the live lane. `useLogTail`, `logBus`, `/api/logs/stream`, the polling fallback, and `readTailChunk` keep their current responsibilities. `LogFeed` combines a bounded live lane with semantic history pages at the feed-entry seam. Loading earlier history no longer prepends raw lines into `FeedSession`.

Store bounded previews and render facts in SQLite. Store no canonical body copy. Expanding a card resolves its opaque `bodyRef`, reads the named source byte range from JSONL, applies the same normalization and redaction rules, and returns the full logical body.

Use the existing `transcript-search.sqlite` database and its Bun SQLite setup for the new projection tables. `src/lib/search/transcriptSearch.ts:158-224` already owns the database location, WAL mode, foreign keys, writer and read-only connections, and private file permissions. Phase 6 moves transcript search onto the semantic rows and removes the older message-only tables after parity is proved. This avoids a second database, dependency, writer loop, and corpus scan.

## Current code facts

The following facts define the migration seams. They describe the pinned commit above.

- `src/app/api/log/route.ts:24-69` exposes two byte-oriented modes. `offset` reads forward and `before` reads the preceding byte chunk. Both accept a path after the server applies the allowed-root check.
- `src/lib/logRead.ts:15-46` bounds each forward read. A subscriber whose offset is far behind jumps to the final `MAX_CHUNK`, which prevents a reconnect from replaying a very large transcript.
- `src/lib/logTailStream.ts:164-213` advances each subscription by byte offset under a shared batch budget. `src/lib/logTailStream.ts:253-289` publishes the chunks over SSE and closes a response that has stopped accepting data.
- `src/hooks/useLogTail.ts:31-73` keeps a browser-wide LRU of bounded tail snapshots. `src/hooks/useLogTail.ts:192-264` subscribes through `logBus`, handles truncation, completes partial lines, and caps the live line window. `src/hooks/useLogTail.ts:266-305` implements `loadOlder()` by fetching one or more `before` chunks and prepending complete raw lines.
- `src/components/feed/parse.ts:251-283` gives each `FeedEntry` a React key and source-position anchor. Its public contract says a backward-moving window resets the session. The implementation at `src/components/feed/parse.ts:2382-2404` performs that reset when the start moves backward, the end retreats, or a gap appears.
- `FeedSession` carries cross-record state. Tool calls live in a call-id map (`src/components/feed/parse.ts:1451-1455`), later results update the same entry copy-on-write (`src/components/feed/parse.ts:1537-1651`), adjacent Codex assistant representations deduplicate (`src/components/feed/parse.ts:1326-1387`), and consecutive tools fold into command groups (`src/components/feed/parse.ts:2294-2379`). A semantic page must preserve these behaviors at page edges.
- `src/components/LogFeed.tsx:49-64` limits rendered rows and the live line window separately for compact and focused panes. `src/components/LogFeed.tsx:351-397` still gives `FeedSession` the complete retained raw-line window and retains those lines for raw-record lookup.
- `src/components/LogFeed.tsx:412-475` preserves the viewport while history is prepended and implements “show earlier.” `src/components/LogFeed.tsx:73-112` also stores a stable row anchor for remount restoration.
- `src/components/LogFeed.tsx:492-548` publishes transcript echo observations so durable user rows retire their matching outbox bubbles. `src/components/LogFeed.tsx:622-630` publishes assistant and tool claims, then removes runtime overlay rows as their durable transcript twins appear.
- `src/components/LogFeed.tsx:779-797` maps every retained `FeedEntry` to a DOM row. CSS `content-visibility` helps compact panes skip layout and paint, while every entry and its strings remain in the JavaScript heap.
- The existing search projection indexes only user and assistant message bodies (`src/lib/search/transcriptSearch.ts:10-68`, `src/lib/search/transcriptSearch.ts:264-384`). A changed file is removed and read again from byte zero (`src/lib/search/transcriptSearch.ts:386-471`). It provides a useful SQLite and FTS precedent, but its update contract cannot serve live semantic history.

The cost problem follows directly from these facts. Adding 500 older lines to a 5,000-line window moves `start` backward, clears `FeedSession`, parses 5,500 lines, retains the larger raw-line array, and then renders only a slice of the resulting semantic entries.

## Options considered

### Keep byte pages and improve client parsing

This would reduce the reset cost after a substantial `FeedSession` change. Raw tool results would still cross the network and remain in the browser heap. Pagination would still count source chunks or lines, so a page could contain almost no visible cards or one very large result. It does not satisfy the originating requirement.

### Store source offsets and parse each page in the browser

This keeps SQLite small. Every browser would need the engine parser and enough lookbehind to reconstruct calls, results, grouping, and duplicate suppression. The `/api/history` response could not provide normalized `FeedEntrySummary[]` directly. Parser drift would become likely because the server index and client parser would make separate semantic decisions.

### Store normalized summaries and source spans in SQLite

This is the selected option. A pure, locale-neutral projector owns semantic decisions. The index stores its bounded output and source coordinates. The page interface stays small, while engine parsing, incremental checkpoints, cursor validation, and rebuild handling remain inside one module. The same projector feeds the existing live `FeedSession` adapter, which keeps one normalization contract for both lanes.

## Module and interface

The external seam is a server-only module. Route code resolves HTTP parameters and maps typed errors. Indexing, generation checks, pagination, cursor encoding, and body-reference validation stay behind the interface.

```ts
interface SemanticHistoryIndex {
  page(query: HistoryPageQuery): Promise<HistoryPage>;
  body(ref: string): Promise<HistoryBody>;
  catchUp(conversation: ConversationBinding): Promise<IndexProgress>;
}
```

`ConversationBinding` is resolved from the conversation catalog. It contains the stable conversation identity, current native generation, engine, format, and an already validated transcript source. The module opens and stats the file itself. Route callers cannot substitute another path.

The projector is an internal seam:

```ts
projectRecord(state, record, sourceSpan): ProjectionDelta
```

`ProjectionDelta` may insert entries, update a prior entry, record hidden-service counts, and replace the persisted parser checkpoint. The projector emits locale-neutral facts such as `status: "running"` or `toolFamily: "shell"`. `FeedItem` continues to translate labels at render time. The live adapter can retain the current `Item` shape while using the same semantic decisions.

No separate index daemon is required. The existing catalog refresh can enqueue catch-up work, and every history request calls `catchUp` before reading. Two processes can race safely: `BEGIN IMMEDIATE` serializes the short write transaction, and the second writer re-reads `indexed_through` after acquiring the lock.

## SQLite projection

The following tables are added to the existing disposable database. Integers that hold byte offsets or sizes use SQLite's signed 64-bit integer storage.

```sql
CREATE TABLE history_files (
  conversation_id       TEXT NOT NULL,
  native_generation     INTEGER NOT NULL DEFAULT -1,
  transcript_path       TEXT NOT NULL,
  file_generation       TEXT NOT NULL UNIQUE,
  engine                 TEXT NOT NULL,
  format                 TEXT NOT NULL,
  source_device          TEXT,
  source_inode           TEXT,
  source_birth_ms        INTEGER,
  source_size            INTEGER NOT NULL,
  source_mtime_ms        INTEGER NOT NULL,
  indexed_through        INTEGER NOT NULL,
  complete_line_count    INTEGER NOT NULL,
  next_ordinal           INTEGER NOT NULL,
  normalizer_version     INTEGER NOT NULL,
  projection_revision    INTEGER NOT NULL,
  continuity_root        BLOB NOT NULL,
  parser_state_json      TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN ('ready', 'building', 'invalid')),
  updated_at_ms           INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, native_generation, transcript_path)
);

CREATE TABLE history_entries (
  file_generation       TEXT NOT NULL,
  ordinal               INTEGER NOT NULL,
  source_part           INTEGER NOT NULL,
  entry_id              TEXT NOT NULL,
  turn_id               TEXT,
  item_id               TEXT,
  kind                  TEXT NOT NULL,
  timestamp_ms          INTEGER,
  byte_start            INTEGER NOT NULL,
  byte_end              INTEGER NOT NULL,
  preview               TEXT NOT NULL,
  body_size             INTEGER NOT NULL,
  summary_json          TEXT NOT NULL,
  settled               INTEGER NOT NULL CHECK(settled IN (0, 1)),
  revision              INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (file_generation, ordinal),
  UNIQUE (file_generation, entry_id),
  FOREIGN KEY (file_generation) REFERENCES history_files(file_generation) ON DELETE CASCADE,
  CHECK (ordinal >= 0),
  CHECK (source_part >= 0),
  CHECK (byte_start >= 0 AND byte_end >= byte_start),
  CHECK (body_size >= 0)
);

CREATE INDEX history_entries_page
  ON history_entries(file_generation, ordinal DESC);
CREATE INDEX history_entries_turn
  ON history_entries(file_generation, turn_id, ordinal);
CREATE INDEX history_entries_item
  ON history_entries(file_generation, item_id);

CREATE TABLE history_open_calls (
  file_generation       TEXT NOT NULL,
  item_id               TEXT NOT NULL,
  entry_ordinal         INTEGER NOT NULL,
  PRIMARY KEY (file_generation, item_id),
  FOREIGN KEY (file_generation, entry_ordinal)
    REFERENCES history_entries(file_generation, ordinal) ON DELETE CASCADE
);

CREATE TABLE history_checkpoints (
  file_generation       TEXT NOT NULL,
  byte_offset           INTEGER NOT NULL,
  next_ordinal          INTEGER NOT NULL,
  continuity_root       BLOB NOT NULL,
  state_json            TEXT NOT NULL,
  PRIMARY KEY (file_generation, byte_offset),
  FOREIGN KEY (file_generation) REFERENCES history_files(file_generation) ON DELETE CASCADE
);

CREATE TABLE history_source_chunks (
  file_generation       TEXT NOT NULL,
  byte_start            INTEGER NOT NULL,
  byte_end              INTEGER NOT NULL,
  digest                BLOB NOT NULL,
  PRIMARY KEY (file_generation, byte_start),
  FOREIGN KEY (file_generation) REFERENCES history_files(file_generation) ON DELETE CASCADE,
  CHECK (byte_start >= 0 AND byte_end > byte_start)
);
```

`ordinal` is the deterministic source-order position of one atomic semantic entry. One source record can emit several entries, so `source_part` records the projector's stable order within that record. Appends only allocate larger ordinals. A tool result updates the tool call's existing ordinal.

`turn_id` uses an engine turn identity when the transcript supplies one. The projector otherwise derives it from the ordinal of the user or turn-opening entry. Records outside a turn may use `NULL`. `item_id` carries a native response, message, or tool-call identity when one exists.

`native_generation = -1` represents a legacy catalog entry with no projected native generation. This keeps the composite primary key total and deterministic.

`entry_id` is the stable feed identity. At first emission it uses a namespaced native item identity when that identity is available and unique. The fallback is a hash of conversation scope, native generation, source byte coordinate, raw-record digest, and `source_part`. A native identity learned from a later twin goes into `item_id` and does not rewrite `entry_id`. This preserves the current parser's first-entry key behavior and recreates the same identity after a clean projection rebuild. A command group's presentation identity uses the first member's `entry_id`. SQLite row ids and the random `file_generation` never participate.

`preview` is valid UTF-8 capped at 512 bytes after redaction. `summary_json` contains kind-specific render facts and has an 8 KiB encoded ceiling. Lists inside it have their own item and string caps. The projector converts any excess to counts and truncation flags. `body_size` is the UTF-8 size of the full redacted logical body. The source body remains in JSONL.

`parser_state_json`, `history_open_calls`, and periodic checkpoints persist the minimum state needed to resume after `indexed_through`: the current turn, pending Codex user representation, adjacent assistant dedupe fingerprint, trailing command run, compaction marker, and other engine state already held by `FeedSession`. Open call identities use their own table because correctness requires retaining every unresolved call.

`continuity_root` is a deterministic Merkle root over fixed-size source chunks in `[0, indexed_through)`. Each leaf hashes its domain tag, byte start, byte length, and exact source bytes. Parent hashes preserve child order and covered length. A partial final chunk is a distinct length-bound leaf. `history_source_chunks` stores the leaves; a projection rebuild recreates the same tree from JSONL.

A cursor freezes a source continuity identity containing the stable conversation scope, its `continuity_length`, and the Merkle root for exactly that prefix. Appending bytes after `continuity_length` leaves this identity unchanged. A truncation or rewrite anywhere inside the prefix changes it. This identity comes from source bytes and survives deletion of the SQLite projection. `file_generation` remains the cache epoch and can rotate during a projection-only rebuild.

## Incremental indexing contract

1. Resolve the conversation to its current transcript through the catalog and apply the same allowed-root and regular-file requirements used by `/api/log`.
2. Open one descriptor and take the source stat from that descriptor. Compare its file identity, size, mtime, and source continuity root through `indexed_through` with `history_files`.
3. For an append, start at `indexed_through`, carry an incomplete final JSONL record across read buffers, and parse each complete record once. Byte spans use the original bytes, so multibyte UTF-8 text cannot skew offsets.
4. Apply every `ProjectionDelta` and its new parser state in one transaction. Advance `indexed_through` only through the final complete newline committed in that transaction. Increment `projection_revision` once when the transaction inserts or updates a semantic row or changes page-edge state exposed to clients. A crash leaves the previous rows, revision, and checkpoint intact.
5. Keep `file_generation` unchanged for valid appends. Update earlier rows in place when a later source record settles a call, joins a duplicate representation, or completes another open semantic item. Increment the entry `revision`, extend `byte_end`, and mark the row settled when its edge state closes.
6. Schedule catch-up from the existing catalog refresh. A request also performs bounded suffix catch-up. A missing projection begins a full build. During a long build, the route reports `rebuilding`; the UI keeps its bounded live lane visible and never interprets an incomplete index as an empty conversation.

The common rebuild triggers are:

- source size below `indexed_through`;
- a changed device or inode identity;
- a changed source continuity root for already indexed bytes;
- a same-size source with a new mtime;
- a failed SQLite integrity check, schema-version mismatch, impossible offset, duplicate deterministic identity, or projector invariant failure;
- an explicit normalizer-version change that has no proven in-place migration.

A replacement or rewrite marks the old generation invalid, deletes its rows and checkpoints in one transaction, creates a new random `file_generation`, and starts at byte zero. Database corruption closes the database, removes the disposable database plus its WAL and shared-memory files, and rebuilds every projection from JSONL. No repair path copies rows out of a suspect projection.

The append fast path verifies the file identity and prior suffix before consuming new bytes. It carries forward the already verified full-chunk leaves below the previous `indexed_through`, extends or replaces only the final partial leaf, and hashes the appended suffix. A low-priority audit checks stored source-chunk hashes across older regions. If an in-place writer changed an earlier region and then appended, that audit rotates the generation and rebuilds. Cursor rebinding has a stronger rule: after any `file_generation` mismatch, the server accepts the cursor only after the rebuilt chunk manifest reproduces the cursor's complete source continuity identity. The local coordinate digest alone can never authorize a rebind. Until the rebuild or validation finishes, the route reports rebuilding and the live byte lane remains available.

## Page contract

### Request

```http
GET /api/history?conversation=...&before=...&limit=150
```

- `conversation` is required and resolves through the server catalog.
- `before` is absent for the newest page. Later calls send the previous response's `beforeCursor`.
- `limit` defaults to 150 and is clamped to `1..150`.
- `showSvc=1` includes service rows. Omission excludes them and reports their count in `hiddenServiceCount`. `LogFeed` passes its current `showSvc` value, and the flag belongs to the cursor scope.
- The server also enforces a 64 KiB page budget over the UTF-8 JSON encoding of the `entries` array.

The endpoint returns entries in chronological order. This lets the client prepend the returned array directly. The SQL query walks ordinals in descending order to apply the limits, then reverses the chosen rows before serialization.

```ts
interface FeedEntrySummary {
  id: string;
  anchorKey: string;
  ordinal: number;
  turnId: string | null;
  itemId: string | null;
  kind: string;
  timestamp: string | null;
  preview: string;
  bodySize: number;
  bodyRef: string | null;
  byteRange: { start: number; end: number };
  summary: Record<string, unknown>;
}

interface SemanticPosition {
  ordinal: number;
  sourcePart: number;
}

type PageBoundary = SemanticPosition | { endAtByte: number };

interface HistoryPage {
  entries: FeedEntrySummary[];
  beforeCursor: string | null;
  hasMore: boolean;
  fileGeneration: string;
  projectionRevision: number;
  queryScope: string;
  sourceSize: number;
  indexedThroughByte: number;
  caughtUp: boolean;
  byteRange: { start: number; end: number } | null;
  pageRange: {
    requestedBefore: PageBoundary;
    nextBefore: SemanticPosition | null;
  };
  hiddenServiceCount: number;
  cacheable: boolean;
  pageEtag: string;
  edge: PageEdgeState;
}
```

The row limit and byte limit both apply. The server scans rows from newest to oldest and tracks the last consumed semantic position. A service row excluded by `showSvc` is consumed, advances that position, and contributes to `hiddenServiceCount`. A visible candidate that would exceed the row limit or byte limit after at least one visible row has been returned is left unconsumed. The next request can return it. If the first visible candidate alone exceeds 64 KiB, the server returns and consumes that one row. This single-oversized-row exception prevents a permanently stuck cursor. Preview and summary caps should make the exception rare, while the contract remains safe if a new kind grows.

`hasMore` is derived from the existence of an older ordinal in the verified projection. A projection in `building` or `invalid` state cannot produce `hasMore: false`.

`queryScope` is the full SHA-256 digest of a versioned canonical serialization containing the stable conversation scope and every query option that changes the row sequence, including `showSvc` and the normalizer version. `pageRange` records both semantic cursor boundaries with ordinal and `sourcePart`. The initial upper boundary records `endAtByte: indexedThroughByte`, so an append cannot reuse an older newest-page entry. The client stores a cacheable page under `[fileGeneration, queryScope, pageRange.requestedBefore, pageRange.nextBefore, byteRange]`. The key is encoded as one canonical JSON array, which avoids delimiter and field-order aliases. The semantic boundaries distinguish pages that split several entries sharing one source byte range. `queryScope` distinguishes filtered variants with identical source ranges.

`cacheable` is true only when every returned entry is settled and both page edges are closed. Older cacheable pages are immutable under append. Empty source ranges use `byteRange: null`; their semantic boundaries still produce a unique cache identity.

Every loaded page with `cacheable: false` retains its original request cursor, `projectionRevision`, and `pageEtag`, regardless of its distance from the tail. The history controller refreshes the newest semantic page whenever `useLogTail.size` advances. It retries while `caughtUp` is false; `caughtUp: true` means the indexer reached the response's `sourceSize` and any remaining bytes form one incomplete JSONL record. A higher `projectionRevision` causes a conditional refetch of every loaded non-cacheable page from its original cursor. The server returns 304 when that page's entries and edge state still match `pageEtag`; otherwise the client replaces the page by stable `entry_id` and its new cache identity. A page enters the LRU after the response marks it cacheable. The loaded-page set is bounded; an evicted page is fetched from the index when the reader returns to it.

Revalidation can change serialized row sizes and therefore move the page's lower semantic boundary. When a replacement's `pageRange.nextBefore` differs from the prior value, the controller invalidates every loaded older descendant in that cursor chain. The next older fetch starts from the replacement's new `beforeCursor`. Stable entry ids and the existing viewport anchor preserve the reader's position while this older chain reloads. This rule prevents a late update from leaving a gap or duplicate at the following page seam.

This revision flow covers long-distance joins. A tool call remains unsettled and keeps its page non-cacheable until its result arrives. A result hundreds of entries later increments both the tool entry revision and `projectionRevision`. Refreshing the newest page observes that revision even after the bounded live lane has evicted the call, then triggers the older page's conditional refetch.

### Errors

| Status | Code | Resolution |
| --- | --- | --- |
| 400 | `history_request_invalid` | Fix a missing conversation, malformed cursor, or invalid limit. |
| 403 | `history_conversation_forbidden` | The resolved transcript failed the allowed-source check. |
| 404 | `history_conversation_missing` | The catalog has no current transcript for the conversation. |
| 409 | `history_cursor_stale` | Restart from the newest page. The source changed or the normalizer version moved. |
| 409 | `history_body_stale` | Refresh the owning page before expanding the body again. |
| 503 | `history_rebuilding` | Keep the live lane visible and retry with bounded backoff. |

## Cursor semantics

Ordering uses `ordinal`, never timestamp. Timestamps can be absent, duplicated, or out of source order. A cursor names the exclusive lower boundary after every row consumed for the current page. With service rows included, this normally equals the position of the oldest returned entry. With service rows omitted, it can equal a skipped service position below that entry.

The opaque token carries a version, `queryScope`, the normalizer version, the last consumed ordinal and `sourcePart`, the corresponding source coordinate, a local coordinate digest, and the complete source continuity identity frozen by the first page in this cursor chain. Every descendant cursor inherits the same `continuity_length` and root even when the source appends. It carries no path and no SQLite row id. The decoder limits token size, validates every integer, and rejects a scope mismatch.

Validation opens the current source descriptor and requires its size to reach `continuity_length`. A same-generation append keeps the verified leaves below the prior `indexed_through`; the validator combines those leaves with at most one re-read partial chunk to reconstruct the frozen prefix root. Its work is bounded by one source chunk plus the Merkle path and does not grow with transcript size. Full-prefix verification is reserved for projection rebuilds, `file_generation` mismatches, explicit audits, and source changes that fail the append checks. A missing byte, changed leaf, changed covered length, or changed root makes the cursor stale.

Cursor behavior is:

- Append stability: existing ordinals and source coordinates stay fixed. The frozen continuity prefix stays byte-identical under append, so an older-page cursor remains valid while the file grows.
- Projection rebuild stability: a rebuild under the same normalizer deterministically recreates ordinals and the fixed-prefix continuity root. The server rebinds the cursor to the new `file_generation` only after the complete prefix identity matches.
- Rewrite safety: truncation, replacement, or a changed byte anywhere inside the frozen prefix returns `history_cursor_stale`. A matching local coordinate digest cannot override a failed prefix identity. The caller starts from the newest page.
- Normalizer changes: a new normalizer version invalidates older tokens. A semantic rule change can alter entry counts, so automatic reinterpretation would risk gaps or duplicates.

The cursor is exclusive. If an unfiltered page consumes ordinals 900 through 1,049, `beforeCursor` addresses ordinal 900 and the next query selects ordinals below 900. If visible ordinal 899 was inspected for size and rejected, it remains unconsumed and is the first eligible row on that next query. In a filtered query, a page can return through visible ordinal 900, consume hidden service ordinals 899 and 898, then reject visible ordinal 897 for size. That page's `beforeCursor` addresses ordinal 898, so the following query can return 897. If 897 alone exceeds 64 KiB, that following query returns and consumes it under the single-oversized-row exception. Every nonterminal response consumes at least one row, and no over-budget visible candidate is skipped.

## Body on demand

A summary with omitted content carries an opaque `bodyRef`. The token binds conversation scope, normalizer version, entry identity, `file_generation`, `byte_start`, `byte_end`, and the source digest. The UI requests:

```http
GET /api/history/body?conversation=...&ref=...
```

The server resolves the current source, validates the reference, reads exactly `[byte_start, byte_end)`, and projects only the requested semantic entry. It returns the complete redacted logical body and its UTF-8 byte size. The route never returns the surrounding raw JSONL records. A composite tool row can span from its call record through its result record; the projector selects the call arguments and result that belong to the requested item id.

Body reads do not populate the page cache. A small body cache may live inside the expanded card and is released when that card unmounts. The source range can be large for a long-running interleaved tool call. That cost occurs only after explicit expansion, and `bodySize` lets the UI disclose it before fetching.

A digest or generation mismatch returns `history_body_stale` and causes a page refresh. The server never serves a body from an unverified range after a rewrite.

## Page-edge rules

`PageEdgeState` is bounded metadata generated with each page. It describes only the first and last semantic runs: unresolved call identities relevant to returned rows, the leading and trailing command-run identity, the adjacent prose fingerprint, pending user-representation fingerprint, turn continuity, and whether either edge is open. The page cache stores this state with the entries.

When an older page is prepended, the client reconciles the two edge states and touches only the two edge runs. It does not pass the combined history through `FeedSession`.

| Boundary case | Resolution |
| --- | --- |
| A JSONL record crosses indexer read buffers | Keep raw byte carry until a complete newline arrives. Commit no partial record. The live lane owns the unfinished tail. |
| The bounded tail contains over 150 entries while the newest semantic page is capped at 150 | Commit the caught-up `indexedThroughByte` watermark, render the loaded summaries below it, and remove every unmatched pre-watermark tail row from the live lane. Older rows return only through `beforeCursor`. |
| A released viewport anchor falls in an unloaded pre-watermark row | Freeze that one row and follow semantic cursors until its twin loads. Replace it under the same presentation key before committing the watermark. |
| One source record emits several cards | Assign deterministic `source_part` values and consecutive ordinals. Every card keeps the same source range and a distinct `entry_id`. |
| A tool call and result fall in different pages | Index the call once at its original ordinal. The result updates that row by `item_id`, extends its source range, settles it, and increments `projectionRevision`. The call's loaded page remains non-cacheable and is conditionally refetched after the newest page observes that revision. |
| A tool call starts below the watermark and settles above it | Keep history ownership from the call's immutable `originByteStart`. Patch a loaded summary in place until its durable revision arrives. Keep an unloaded call hidden. |
| A result has no indexed call | Preserve current parser behavior: expose a bounded service or malformed-record summary only when service rows are enabled. Never invent a tool card. |
| A command run crosses a page edge | Mark the older page's trailing run and the newer page's leading run with the same run identity. Prepend reconciliation replaces the two partial presentations with one group keyed by the first member. |
| Adjacent Codex assistant representations cross a page edge | Carry the previous representation, normalized-text digest, timestamp, and shape. Apply the adjacency and time rule used by `sameCodexTextAtTime`; retain one semantic entry and attach the native response identity when it arrives. |
| A provisional Codex user row and its event echo cross an edge | Carry the pending-user fingerprint. The echo updates the provisional entry and its source range. Authorship stays unchanged. |
| A turn crosses a page edge | Keep the same `turn_id` on both pages. Page limits may split a turn because a turn can exceed every safe byte bound. The UI draws one continued turn without duplicating a header. |
| The newest command group is still active | Return it as an open edge and set `cacheable: false`. A later page refresh or live item update settles the same group identity. |
| One summary exceeds 64 KiB | Return that row alone, set `beforeCursor` below it, and continue normally on the next request. |
| The source truncates or changes while indexing | Discard the uncommitted delta, rotate `file_generation`, and rebuild from byte zero. No mixed-generation rows become visible. |
| SQLite is missing or corrupt while JSONL is readable | Report rebuilding, delete the disposable projection files, and recreate the index. An empty index is never presented as complete history. |
| The source disappears after a page was cached | Keep the rendered cached page for the current mount, disable body expansion, and report the source as unavailable. A fresh mount follows the catalog's missing-conversation behavior. |

## Live and durable reconciliation

`LogFeed` will render one ordered feed from three inputs:

1. cached and fetched semantic history entries;
2. the bounded `FeedSession` output produced from `useLogTail`;
3. the outbox and runtime live-turn overlay already rendered at the tail.

### Lane ownership watermark

A caught-up newest page establishes `historyWatermark = indexedThroughByte`. This offset is immediately after the final complete JSONL record covered by that page snapshot. The watermark is monotonic within one `fileGeneration` and resets when that generation changes.

Every semantic entry has an immutable `originByteStart`, taken from the first source record that emitted it, plus a `sourceByteEnd` that can extend when a later record settles it. Lane ownership uses `originByteStart`:

- history owns every entry with `originByteStart < historyWatermark`, including entries whose result or dedupe twin arrives after the watermark;
- live owns every entry with `originByteStart >= historyWatermark`;
- an unfinished JSONL record emits no entry and stays in the byte decoder until its newline arrives.

The history lane renders only summaries present in loaded semantic pages. A history-owned entry absent from those pages stays absent until cursor navigation loads its page. The live lane filters it out even when the bounded raw tail still contains its source line. This keeps raw tail depth from bypassing the 150-entry semantic page.

`useLogTail` keeps its transport and window behavior. Its decoder adds source-span metadata beside each complete line before trimming text, and the cache and cap move each line with its span. `FeedSession` carries the first and last source spans into each live `FeedEntry`. This is an additive output detail; reconnect offsets, LRU policy, cap, pause behavior, and SSE-to-poll fallback remain unchanged.

Before the first caught-up page arrives, the first observed `useLogTail.size` becomes `provisionalLiveStart`. Decoded rows below that offset form a private bootstrap buffer. Rows whose `originByteStart` is at or above it may render as new live activity; the runtime overlay and outbox also remain visible. Raw bootstrap history stays withheld. When the caught-up page arrives, its durable watermark replaces the provisional value through the same transition transaction. A normal glued open therefore fetches and renders one newest semantic page plus bytes written after the open began.

### Watermark transition

Advancing the watermark is one feed-store transaction:

1. Capture the current viewport anchor and every live presentation key.
2. Match every loaded semantic page against live entries, beginning with the newest page, by native `itemId`; tool groups compare every member call id. Entries without a native id use the projector's source-span identity.
3. Replace matched pre-watermark live rows under their existing presentation keys. Remove every other pre-watermark live row from the renderable live lane. Those removed rows become ordinary unloaded history and can return only through semantic cursor navigation.
4. Keep entries at or above the watermark in source order as the live lane. Publish the merged durable list to assistant claims and transcript echo reconciliation once.
5. Restore the captured anchor, then commit the new watermark. A glued pane uses the existing bottom glue.

A released viewport can be anchored to a pre-watermark live row that the newest page does not contain, for example when one catch-up covers more than 150 semantic entries. The controller holds the prior watermark, freezes that anchor row, and follows `beforeCursor` page by page until the semantic twin is loaded. It then replaces the frozen row under the same presentation key and commits the watermark. Other pre-watermark rows are unavailable through “show earlier” during this short bridge. A missing or rewritten source cancels the bridge and restores the nearest surviving successor with the existing pixel-offset compensation.

An open item keeps the lane chosen by its first source record. A tool call below the watermark remains history-owned when a result arrives above it. A loaded summary receives the live result as a temporary patch under the same presentation key, then `projectionRevision` replaces that patch with the durable updated summary. An unloaded call remains hidden until its semantic page loads. The result cannot recreate a separate live row.

`anchorKey` becomes the durable `entry_id` after replacement. During that frame, the store retains an alias from the prior live anchor. The existing `viewportAnchor` lookup can restore either key, and the prepend height compensation at `src/components/LogFeed.tsx:412-420` keeps the reader's row at the same screen offset.

Unified durable entries are passed to `publishCanonicalAssistantClaims`. Their response ids and tool-call ids already match the identities consumed by `visibleRuntimeLiveTurnItems`, so a runtime row yields as soon as its durable twin is visible. Unified user rows are passed once to `publishTranscriptEchoes`. The echo ledger rekeys a live anchor to the durable `entry_id` during replacement, preserving one occurrence. Repeated identical messages still retire outbox entries one at a time through the existing occurrence accounting. Runtime overlay and outbox rows keep their current tail order after the merged durable feed.

The current `FeedSession` reset remains valid for a bounded live truncation or source replacement. Earlier-history navigation never moves its input window backward after this split, so loading a page cannot trigger the whole-history reset at `src/components/feed/parse.ts:2382-2394`.

## Rollout

The rollout order follows the originating priority exactly. Each phase has its own feature gate and can be disabled without changing JSONL.

### Phase 1: semantic history pages

- Add the locale-neutral projector, schema, incremental indexer, cursor codec, and `GET /api/history`.
- On initial open, request one newest page with `limit=150`; request no older raw chunks.
- Keep `useLogTail` subscribed through the existing live path.
- Add the `LogFeed` history controller, source-span sidecar, ownership watermark, and semantic-entry merge. “Show earlier” consumes `beforeCursor`.
- Treat rebuilding as an explicit temporary state. Continue showing the bounded live lane.

Exit proof: a normal initial open returns at most one semantic page, page walking has no gaps or repeats, append catch-up reads only the suffix, and loading older history never calls `useLogTail.loadOlder()`. Every rendered live entry starts at or above the committed watermark.

### Phase 2: body on demand

- Replace any remaining inline page body with `preview`, `bodySize`, and `bodyRef`.
- Add the body route and expansion states.
- Keep raw source lookup for the bounded live lane until each live row receives its durable twin.

Exit proof: a collapsed large tool result contributes only bounded summary bytes to the page and browser heap; expansion reads its verified source range and returns the complete redacted body.

### Phase 3: incremental prepend and page cache

- Add the bounded LRU keyed by file generation, query scope, semantic page boundaries, and byte range.
- Persist and return page-edge state for tool pairing, command grouping, user and assistant representation joins, and turn continuity.
- Publish `projectionRevision` and conditionally refetch every loaded non-cacheable page after semantic progress, including pages outside the bounded live window.
- Reconcile only the added page and its adjoining edge. Remove the old raw-history prepend call from `LogFeed`.

Exit proof: prepending a page performs work proportional to that page plus its two edge runs. A test spies on the parser and proves no previously settled page or live window is parsed again. A late result refreshes and settles its loaded call page even when more than 150 semantic entries separate them.

### Phase 4: viewport virtualization

- Virtualize the semantic entry list with variable-height measurement.
- Use `entry_id` as the item key and preserve the existing anchor plus offset restoration contract.
- Keep the page LRU as the data-retention limit. The virtualizer controls mounted DOM rows only.

Exit proof: scrolling and prepend preserve the first visible entry and pixel offset, expanded rows retain their measurement, and the number of mounted rows stays bounded while several pages are loaded.

### Phase 5: aggressive scheme panes

- A compact board node requests one page capped at 80 summaries and renders at most the final two `turn_id` groups. Typical turns produce about 30 to 80 cards; short turns produce fewer.
- Keep the live lane and runtime overlay mounted.
- Focusing the node enters full-history mode, reuses its cached page, and hydrates the newest focused page immediately. Older pages hydrate as the reader navigates.

Exit proof: compact nodes do not hydrate the full transcript, the latest one or two turns remain coherent, and focus produces no duplicate live or outbox row.

### Phase 6: search through the semantic index

- Build a contentless FTS5 table from normalized searchable text emitted during semantic projection. Join hits to the bounded entry preview. JSONL bodies remain the source for expansion.
- Return `fileGeneration`, hit `ordinal`, target `entry_id`, and an opaque page cursor positioned so a regular `/api/history` request includes the hit.
- Open that page, restore the target anchor, and highlight the hit after the page mounts.
- Prove parity with the current message search before removing the message-only index tables and their full-file reindexer.

Exit proof: selecting a search result reads one semantic page around the hit. The browser does not load a transcript to scan it.

## Verification

All tests use an isolated state directory and synthetic transcripts. They never open the operator registry or runtime state.

Required tests include:

- deterministic ordinals and entry ids across a projection rebuild;
- cursor stability after append and after a clean rebuild;
- same-generation append followed by older cursor navigation reading at most one source hash chunk, with source bytes read independent of frozen-prefix length;
- stale-cursor rejection after truncation, replacement, earlier-byte rewrite, or normalizer-version change;
- stale-cursor rejection when a projection rebuild follows a rewrite outside the cursor's local coordinate-digest range;
- byte-accurate indexing across UTF-8 and read-buffer splits;
- call and result pairing across a page edge;
- command grouping and Codex prose dedupe across a page edge;
- a pending user representation that completes on the next page;
- a turn larger than the row and byte budgets;
- row and byte limits together, including the single-oversized-row progress case;
- two pages split between entries with the same source byte range receiving distinct cache identities;
- `showSvc` variants with the same byte range receiving distinct cache identities;
- a visible row rejected after the byte budget remaining eligible on the next page while filtered service rows advance the cursor;
- a raw tail containing more than 150 pre-watermark semantic entries rendering only the newest semantic page and no unmatched raw-history rows;
- a watermark advancing across more than 150 live entries while a released unloaded anchor keeps its position until semantic replacement;
- a tool call below the watermark and result above it retaining one history-owned presentation with no live duplicate;
- a tool result more than 150 semantic entries after its call incrementing `projectionRevision` and refreshing the loaded non-tail call page after live-window eviction;
- a late update that changes a page's byte-budget boundary invalidating and restarting its older cursor chain without gaps or duplicates;
- index corruption producing a rebuilding response while the JSONL source remains intact;
- one live row replaced by one durable twin with the same DOM presentation key;
- stable viewport offset during prepend and live-to-durable replacement;
- one outbox retirement for one echo before and after replacement;
- runtime prose and tool overlays yielding to matching durable identities;
- compact panes mounting only their bounded latest turn set;
- a search hit opening the semantic page that contains its ordinal.

Instrumentation should report source bytes read, records parsed, inserted rows, updated rows, projection revision, page rows, serialized page bytes, non-cacheable page revalidations, rebuild reason, and whether a page came from cache. These are diagnostic counters. They do not become authority for transcript completeness.

## Non-goals

- Replacing or rewriting `useLogTail`, `logBus`, SSE, the polling fallback, `readTailChunk`, or `/api/log`.
- Treating SQLite as a source of record, a recovery source, or evidence that missing JSONL content never existed.
- Loading full bodies during page fetch.
- Guaranteeing that one whole turn fits in one page.
- Running virtualization before semantic paging and body removal bound browser data.
- Changing transcript formats or asking engine writers to emit new records.
- Accepting arbitrary source paths through the history or body routes.

## Deferred — not currently justified

- A standalone indexing process. The existing Viewer process, SQLite transaction, and catalog-triggered catch-up provide the required ownership.
- A second history database. The current disposable search database already supplies the runtime, security, and FTS foundation.
- Locale-specific indexed summaries. Locale-neutral facts keep one projection valid for every client.
- User-configurable page-byte budgets. One server budget keeps memory and cursor behavior predictable.
- Server-rendered feed cards or cached HTML. The existing `FeedItem` rendering seam remains useful.
- Cross-conversation ranking, recommendations, or semantic embeddings. Phase 6 needs indexed text and an exact page-opening cursor.

## Validation against the originating requirement

The requirement directly calls for this work. The design preserves the live byte path, changes history to semantic pages, makes SQLite disposable, keeps JSONL authoritative, defines the required schema and cursor rules, resolves the difficult page edges, removes bodies from collapsed pages, and follows the six requested rollout priorities.

The over-engineering pass removes a new daemon, a second database, server-rendered cards, embeddings, and configurable paging machinery. The first slice consists of one deep module, one route, one normalized summary type, one incremental projection, and the `LogFeed` merge needed to consume it.
