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
- `src/components/LogFeed.tsx:386-388` slices retained `feed.items` into `visibleItems`, and `src/components/LogFeed.tsx:779-797` maps only that slice to DOM rows. The complete `feed.items` collection and its strings remain in the JavaScript heap; CSS `content-visibility` further reduces layout and paint for mounted compact rows.
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
  resolveCheckpoint(ref: string, facts: LeadingRecordFacts): Promise<CheckpointResolution>;
  catchUp(conversation: ConversationBinding): Promise<IndexProgress>;
}
```

`ConversationBinding` is resolved from the conversation catalog. It contains the stable conversation identity, current native generation, engine, format, and an already validated transcript source. The module opens and stats the file itself. Route callers cannot substitute another path.

The projector is an internal seam:

```ts
projectRecord(state, record, sourceSpan): ProjectionDelta
```

`ProjectionDelta` may insert entries, update a prior entry, record hidden-service counts, and replace the persisted parser checkpoint. The projector emits locale-neutral facts such as `status: "running"` or `toolFamily: "shell"`. `FeedItem` continues to translate labels at render time. The live adapter can retain the current `Item` shape while using the same semantic decisions.

No separate index daemon is required. The existing catalog refresh can enqueue catch-up work, and every history request calls `catchUp` before reading. One projection-scoped lease and fencing epoch select the worker across processes. Short compare-and-set transactions publish only the current lease owner's deltas.

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
  source_ctime_ns        INTEGER NOT NULL,
  scan_through           INTEGER NOT NULL,
  indexed_through        INTEGER NOT NULL,
  complete_line_count    INTEGER NOT NULL,
  next_ordinal           INTEGER NOT NULL,
  normalizer_version     INTEGER NOT NULL,
  projection_revision    INTEGER NOT NULL,
  continuity_root        BLOB NOT NULL,
  merkle_frontier_json   TEXT NOT NULL,
  audit_next_chunk       INTEGER NOT NULL DEFAULT 0,
  audit_cycle_end_chunk  INTEGER NOT NULL DEFAULT 0,
  parser_state_json      TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN ('ready', 'validating', 'building', 'invalid')),
  updated_at_ms           INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, native_generation, transcript_path)
);

CREATE TABLE history_entries (
  file_generation       TEXT NOT NULL,
  ordinal               INTEGER NOT NULL,
  source_line_number    INTEGER NOT NULL,
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
  CHECK (source_line_number >= 0),
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
  inline_state_json     TEXT NOT NULL,
  checkpoint_ref        TEXT NOT NULL UNIQUE,
  PRIMARY KEY (file_generation, byte_offset),
  FOREIGN KEY (file_generation) REFERENCES history_files(file_generation) ON DELETE CASCADE,
  CHECK (length(CAST(inline_state_json AS BLOB)) <= 12288)
);

CREATE TABLE history_checkpoint_state (
  checkpoint_ref        TEXT NOT NULL,
  state_kind            TEXT NOT NULL,
  state_key             TEXT NOT NULL,
  source_byte_start     INTEGER,
  source_byte_end       INTEGER,
  state_json            TEXT NOT NULL,
  PRIMARY KEY (checkpoint_ref, state_kind, state_key),
  FOREIGN KEY (checkpoint_ref) REFERENCES history_checkpoints(checkpoint_ref) ON DELETE CASCADE,
  CHECK (length(CAST(state_json AS BLOB)) <= 2048)
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

CREATE TABLE history_index_jobs (
  file_generation       TEXT PRIMARY KEY,
  fencing_epoch         INTEGER NOT NULL,
  expected_through      INTEGER NOT NULL,
  observed_size         INTEGER NOT NULL,
  observed_revision_json TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  lease_until_ms        INTEGER NOT NULL,
  FOREIGN KEY (file_generation) REFERENCES history_files(file_generation) ON DELETE CASCADE
);
```

`ordinal` is the deterministic source-order position of one atomic semantic entry. `source_line_number` is the zero-based physical newline-delimited line number and counts blank lines even though they emit no semantic entry. One source line can emit several entries, so `source_part` records the projector's stable birth order within that line. Appends only allocate larger ordinals and line numbers. A later echo or tool result updates the entry while its birth line and part remain immutable.

`turn_id` uses an engine turn identity when the transcript supplies one. The projector otherwise derives it from the ordinal of the user or turn-opening entry. Records outside a turn may use `NULL`. `item_id` carries a native response, message, or tool-call identity when one exists.

`native_generation = -1` represents a legacy catalog entry with no projected native generation. This keeps the composite primary key total and deterministic.

`entry_id` is the stable feed identity. At first emission it uses a namespaced native item identity when that identity is available and unique. The fallback is a hash of conversation scope, native generation, source byte coordinate, raw-record digest, and `source_part`. A native identity learned from a later twin goes into `item_id` and does not rewrite `entry_id`. This preserves the current parser's first-entry key behavior and recreates the same identity after a clean projection rebuild. A command group's presentation identity uses the first member's `entry_id`. SQLite row ids and the random `file_generation` never participate.

`preview` is valid UTF-8 capped at 512 bytes after redaction. `summary_json` contains kind-specific render facts and has an 8 KiB encoded ceiling. Lists inside it have their own item and string caps. The projector converts any excess to counts and truncation flags. `body_size` is the UTF-8 size of the full redacted logical body. The source body remains in JSONL.

`parser_state_json`, `history_open_calls`, and periodic checkpoints persist the minimum state needed to resume after `indexed_through`: the current turn, pending Codex user representation, adjacent assistant dedupe fingerprint, trailing command run, compaction marker, and other engine state already held by `FeedSession`. Open call identities use their own table because correctness requires retaining every unresolved call.

`continuity_root` is a deterministic Merkle root over fixed-size source chunks in `[0, indexed_through)`. Each leaf hashes its domain tag, byte start, byte length, and exact source bytes. Parent hashes preserve child order and covered length. A partial final chunk is a distinct length-bound leaf. `history_source_chunks` stores the leaves, and `merkle_frontier_json` stores the O(log chunks) frontier needed to extend the root during append. A projection rebuild recreates both from JSONL.

A cursor freezes a source continuity identity containing the stable conversation scope, its `continuity_length`, and the Merkle root for exactly that prefix. Appending bytes after `continuity_length` leaves this identity unchanged. A truncation or rewrite anywhere inside the prefix changes it. This identity comes from source bytes and survives deletion of the SQLite projection. `file_generation` remains the cache epoch and can rotate during a projection-only rebuild.

## Incremental indexing contract

1. Resolve the conversation to its current transcript through the catalog and apply the same allowed-root and regular-file requirements used by `/api/log`.
2. Resolve the catalog-bound pathname, open it with no symlink following, and take bigint descriptor stats. Device, inode, size, mtime, and nanosecond ctime form the observed source revision. Re-read the catalog binding and pathname identity before publication.
3. Before prefix validation starts, set the projection to `validating` and acquire its single `history_index_jobs` row keyed only by `file_generation`. Expected offset and observed revision are mutable owner-CAS fields inside that row. Acquisition or lease takeover increments `fencing_epoch`. The owning process keeps one `globalThis` worker keyed by file generation; requests observing later offsets or sizes join it, update pending intent, and create no second job. Other requests attach abortable waiters or return `history_validating`; waiter cancellation never cancels the worker. The worker renews a short lease, and another process may recover it after expiry with a higher epoch.
4. Validate every stored source chunk in `[0, indexed_through)` once for this job. The successful proof belongs to the frozen descriptor revision and is reused across all bounded suffix passes in the job. A restart or lease takeover repeats validation. Total prefix-validation bytes stay O(indexed prefix) for the whole catch-up epoch; each later pass reuses the proof.
5. One semantic pass stops after the earlier of `INDEX_CATCH_UP_BYTES = MAX_CHUNK` (768 KiB), 2,000 complete source records, or the frozen observed size. Byte spans use the original bytes, so multibyte UTF-8 text cannot skew offsets. Later passes continue from the committed newline while reusing the same prefix proof.
6. If no newline appears within the byte budget, detached background work scans fixed-size buffers for the first newline and retains only `[recordStart, recordEnd)` plus its digest. After finding the newline, it invokes the shared full-record projector once as the single-oversized-record exception. The worker records peak RSS and record bytes for this path. The projection still stores only bounded preview, summary facts, body size, and source range; the full record is released after projection.
7. Immediately before each commit, fstat the descriptor, stat the bound pathname, and re-read the catalog binding. Device, inode, size, mtime, and ctime must equal the frozen revision captured before prefix validation. A pathname identity or binding change also aborts. Any concurrent append, truncate, or rewrite discards the whole job and starts a later coalesced epoch. This stable observation window makes prefix validation authoritative before catch-up publication.
8. Treat a failed prefix or suffix check, shrink, device or inode change, same-size ctime change, catalog-generation change, or audited chunk-digest mismatch as a replacement generation. Mark the old projection invalid, rotate `file_generation`, and rebuild from byte zero.
9. Apply every `ProjectionDelta`, source-chunk update, Merkle frontier, and parser state in one short transaction. The transaction compare-and-sets `file_generation`, `fencing_epoch`, owner id, lease validity, and expected `indexed_through`; a failed CAS discards the worker result. Advance `indexed_through` only through the final complete newline committed in that transaction. Set `source_size` to the frozen observed size and `scan_through` to the byte reached by this pass. A pass or background range scan that reaches stable EOF with one incomplete final record sets `scan_through = source_size` and leaves `indexed_through` at the preceding newline. Increment `projection_revision` once when the transaction inserts or updates a semantic row or changes page-edge state exposed to clients.
10. Keep `file_generation` unchanged after a validated append. Update earlier rows in place when a later source record settles a call, joins a duplicate representation, or completes another open semantic item. Increment the entry `revision`, extend `byte_end`, and mark the row settled when its edge state closes.
11. Schedule another bounded pass while `scan_through < source_size`. A request joins through `HISTORY_REQUEST_JOIN_MS = 25`, then receives `history_validating`; no indexed rows are served from that generation until the full job reaches its frozen size and returns the state to `ready`. A missing projection follows the same bounded build from byte zero and returns rebuilding. The unchanged bounded raw tail remains provisional until caught-up handoff.

The common rebuild triggers are:

- source size below `indexed_through`;
- a changed device or inode identity;
- a changed source continuity root for already indexed bytes;
- a same-size source with a new mtime or ctime;
- a failed SQLite integrity check, schema-version mismatch, impossible offset, duplicate deterministic identity, or projector invariant failure;
- an explicit normalizer-version change that has no proven in-place migration.

A replacement or rewrite marks the old generation invalid, deletes its rows and checkpoints in one transaction, creates a new random `file_generation`, and starts at byte zero. Database corruption closes the database, removes the disposable database plus its WAL and shared-memory files, and rebuilds every projection from JSONL. No repair path copies rows out of a suspect projection.

The semantic projector parses only the appended suffix, while the pre-publication integrity pass reads the committed prefix. This extra sequential I/O is the cost of detecting same-inode rewrite-plus-append without writer cooperation. It runs in background, coalesces concurrent growth, and never extends the request join deadline. A future writer-coordinated append-continuity token can remove the prefix scan without changing the page interface.

Audits use a fixed `AUDIT_CHUNKS_PER_PASS = 4` budget. At cycle start, `audit_cycle_end_chunk` freezes the current chunk count. `audit_next_chunk` advances only through that fixed range; chunks appended during the cycle wait for the next one. Reaching the frozen end resets the pointer to zero and captures a new end count. Each catalog refresh that observes the conversation and each history request runs one pass. A cycle containing `N` chunks completes within `ceil(N / 4)` passes even while the file grows. A mismatch invalidates the projection before that request can return indexed rows. Detection remains conditional on the Viewer receiving refreshes or requests; the coverage bound applies once maintenance is running.

SQLite remains disposable. Cursors bind their projection generation, body references validate their exact source range, and any observed inconsistency deletes the projection. Cursor rebinding after a generation mismatch requires the rebuilt chunk manifest to reproduce the cursor's complete source continuity identity.

## Page contract

### Request

```http
GET /api/history?conversation=...&before=...&limit=150
```

- `conversation` is required and resolves through the server catalog.
- `before` is absent for the newest page. Later calls send the previous response's `beforeCursor`.
- `limit` defaults to 150 and is clamped to `1..150`.
- `showSvc=1` includes service rows. Omission excludes them and reports their count in `hiddenServiceCount`. `LogFeed` passes its current `showSvc` value, and the flag belongs to the cursor scope.
- `unmatchedItemId` may repeat up to 64 times to classify hidden live results by native item id. Each value has a strict length cap. This metadata query does not change page ordering and stays outside `queryScope`.
- The server also enforces a 64 KiB page budget over the UTF-8 JSON encoding of the `entries` array.

The endpoint returns entries in chronological order. This lets the client prepend the returned array directly. The SQL query walks ordinals in descending order to apply the limits, then reverses the chosen rows before serialization.

```ts
interface FeedEntrySummary {
  id: string;
  anchorKey: string;
  ordinal: number;
  sourceLineNumber: number;
  sourcePart: number;
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
  validatedThroughRevision: number;
  queryScope: string;
  sourceSize: number;
  completeLineCount: number;
  scannedThroughByte: number;
  indexedThroughByte: number;
  caughtUp: boolean;
  byteRange: { start: number; end: number } | null;
  pageRange: {
    requestedBefore: PageBoundary;
    nextBefore: SemanticPosition | null;
  };
  hiddenServiceCount: number;
  resultOwnership: Record<string, "history" | "unmatched">;
  activeWakeupItemId: string | null;
  wakeupRevision: number;
  cacheable: boolean;
  pageEtag: string;
  edge: PageEdgeState;
}
```

The row limit and byte limit both apply. The server scans rows from newest to oldest and tracks the last consumed semantic position. A service row excluded by `showSvc` is consumed, advances that position, and contributes to `hiddenServiceCount`. A visible candidate that would exceed the row limit or byte limit after at least one visible row has been returned is left unconsumed. The next request can return it. If the first visible candidate alone exceeds 64 KiB, the server returns and consumes that one row. This single-oversized-row exception prevents a permanently stuck cursor. Preview and summary caps should make the exception rare, while the contract remains safe if a new kind grows.

`resultOwnership` is computed after catch-up from `history_entries.item_id` plus `history_open_calls`. A requested id is `history` when any indexed semantic call owns it, including a settled call outside loaded pages. It is `unmatched` only when the response is caught up and neither table owns it. While catch-up is pending, the id stays absent from the map and the client keeps the result hidden.

The page LRU stores only invariant page fields: entries, cursors, page range, edge state, and page ETag. `resultOwnership` is computed after any page-cache lookup and attached only to the current network response, so different id sets cannot alias through a cached envelope. The client sends one batch at a time and immediately issues another newest-page request while unmatched ids remain beyond the 64-id cap. This drain continues after a caught-up response and without a source-size event.

`hasMore` is derived from the existence of an older ordinal in the verified projection. A projection in `validating`, `building`, or `invalid` state cannot produce a history page.

`queryScope` is the full SHA-256 digest of a versioned canonical serialization containing the stable conversation scope and every query option that changes the row sequence, including `showSvc` and the normalizer version. `pageRange` records both semantic cursor boundaries with ordinal and `sourcePart`. The initial upper boundary records `endAtByte: indexedThroughByte`, so an append cannot reuse an older newest-page entry. The client stores a cacheable page under `[fileGeneration, queryScope, pageRange.requestedBefore, pageRange.nextBefore, byteRange]`. The key is encoded as one canonical JSON array, which avoids delimiter and field-order aliases. The semantic boundaries distinguish pages that split several entries sharing one source byte range. `queryScope` distinguishes filtered variants with identical source ranges.

`cacheable` is true only when every returned entry is settled and both page edges are closed. A wakeup entry settles when its own result is known; its requested schedule, resolved schedule, and failure fact are immutable page data. File-global `activeWakeupItemId` identifies the newest successful wakeup. The renderer derives each cached wakeup's active or superseded state by comparing its `itemId` with that global identity. A later successful or failed wakeup changes `activeWakeupItemId` and `wakeupRevision` in the unconditional newest-page response, so cached historical rows re-render without page refetch. Other older cacheable pages are immutable under append. Empty source ranges use `byteRange: null`; their semantic boundaries still produce a unique cache identity.

Every loaded page with `cacheable: false` retains its original request cursor, `projectionRevision`, `validatedThroughRevision`, and `pageEtag`, regardless of its distance from the tail. The history controller refreshes the newest semantic page whenever `useLogTail.size` advances and on a mounted `HISTORY_REVALIDATE_MS = 5000` cadence independent of `/api/files` 304 publication. Returning a hidden tab to visible state triggers an immediate refresh. A projection with catch-up work returns `history_validating`, and the controller keeps the bounded raw fallback plus retry backoff. A 200 response comes only from `ready`, always carries the current global `projectionRevision`, and has `caughtUp: true` because `scannedThroughByte === sourceSize`. `indexedThroughByte` may remain at the prior complete newline while one incomplete final record occupies the remaining bytes. The independent cadence observes completed background work and audit-driven generation changes on static-size files, then clears stale page-cache keys before rebuilt pages install.

A higher newest-page `projectionRevision` causes a conditional refetch of every loaded non-cacheable older page whose `validatedThroughRevision` is lower. The request sends its `pageEtag` and target revision. A 200 response updates the page and sets both revision fields to the checked global revision. A 304 response includes `X-History-Validated-Through-Revision`; the client advances `validatedThroughRevision` to that header while retaining the page content. A concurrent later commit has a larger revision and therefore schedules another check. A page enters the LRU after the response marks it cacheable. The loaded-page set is bounded; an evicted page is fetched from the index when the reader returns to it.

The conditional route reads `fileGeneration`, global revision, page rows, edge state, and the prior ETag comparison inside one SQLite read transaction. It computes `pageEtag` and decides 200 or 304 from that single snapshot. The 304 acknowledgement header carries the revision read in the same transaction. A writer committing after that snapshot receives a larger revision and cannot be accidentally acknowledged by the earlier response.

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
| 503 | `history_validating` | Keep the provisional raw tail visible while one bounded validation job owns catch-up. |
| 503 | `history_rebuilding` | Keep the live lane visible and retry with bounded backoff. |

## Cursor semantics

Ordering uses `ordinal`, never timestamp. Timestamps can be absent, duplicated, or out of source order. A cursor names the exclusive lower boundary after every row consumed for the current page. With service rows included, this normally equals the position of the oldest returned entry. With service rows omitted, it can equal a skipped service position below that entry.

The opaque token carries a version, `fileGeneration`, `queryScope`, the normalizer version, the last consumed ordinal and `sourcePart`, the corresponding source coordinate, a local coordinate digest, and the complete source continuity identity frozen by the first page in this cursor epoch. Descendant cursors within that epoch inherit its `fileGeneration`, `continuity_length`, and root while the source appends. The server authenticates the canonical payload with HMAC-SHA-256 using a state-local mode-`0600` key; rotation of that key invalidates outstanding cursors. The token carries no path and no SQLite row id. The decoder limits token size, verifies the MAC before fields are trusted, validates every integer, and rejects a scope mismatch.

Validation compares the authenticated token's `fileGeneration` with the current projection. A match trusts the committed generation and performs the local coordinate check; it reads no chunk-manifest rows and hashes no Merkle path. A mismatch captures one source-revision digest over descriptor device, inode, size, mtime, ctime, pathname identity, and catalog binding, then runs full-prefix verification without a SQLite write transaction. It re-fstats the descriptor, pathname, and binding afterward; any digest change restarts verification.

Page selection then uses one SQLite read transaction. That snapshot reads the current ready generation, every stored source-revision field, page rows, edge state, and revision together. The stored revision must equal the verified digest and the continuity root must match. Failure restarts or returns `history_cursor_stale`. Success forces a 200 response that starts a new cursor epoch: the returned cursor and every descendant token carry the generation read in that snapshot while retaining the original frozen `continuity_length` and root. A rotation or source-revision commit after the read snapshot is handled on the next request.

Cursor behavior is:

- Append stability: existing ordinals and source coordinates stay fixed. The frozen continuity prefix stays byte-identical under append, so an older-page cursor remains valid while the file grows.
- Projection rebuild stability: a rebuild under the same normalizer deterministically recreates ordinals and the fixed-prefix continuity root. The server detects the cursor's old `fileGeneration` and rebinds it only after the complete prefix identity matches.
- Rewrite safety: pre-publication prefix validation catches rewrite-plus-append, while truncation, replacement, same-size ctime change, or an audited changed byte also rotates the projection. An old cursor then passes through full-prefix verification. A failed prefix identity returns `history_cursor_stale`; a matching local coordinate digest cannot override it.
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

`PageEdgeState` has two roles. Its visible-run fields describe the first and last semantic runs for page prepend: leading and trailing command-run identity, adjacent prose fingerprint, turn continuity, and whether either edge is open. Its versioned `afterCheckpoint` is the projector checkpoint immediately after every physical source line through the page's upper byte boundary, computed before `showSvc` or other display filtering.

`afterCheckpoint` has at most 12 KiB of inline state plus opaque `checkpointRef`. Inline fields cover assistant representation shape and fingerprint, `codexCompacted`, OpenClaw provider/model baseline, current turn, trailing group, and bounded recent identities. Every unbounded family is row-oriented in `history_checkpoint_state`: one row per pending user fingerprint, wakeup entry reference, model boundary, or open ownership key. Each state row is capped at 2 KiB and stores identifiers, fingerprints, counters, or source ranges. An open multiline plain block stores its source byte range and digest, never its complete text.

The fresh live parser accepts the inline seed only when checkpoint version and normalizer version match. If a leading live record needs an out-of-line family, the controller calls `SemanticHistoryIndex.resolveCheckpoint(checkpointRef, leadingRecordFacts)` through a bounded checkpoint-resolution request. The server returns only the matching transition facts; it reads a referenced plain-block range only when that transition actually closes the block. Resolution responses have a 16 KiB limit and the same generation binding as the page. `resultOwnership` remains the specialized call-id path.

The normal history response has an 80 KiB envelope budget: 64 KiB for `entries`, 12 KiB for inline checkpoint state, and the remaining envelope fields. Every limit measures UTF-8 bytes. The server encodes the complete response once before send and removes oldest candidate entries until the full envelope fits, updating its consumed boundary accordingly. The single-oversized-entry exception can exceed the entry portion for one row, while checkpoint and other envelope metadata remain capped.

When an older page is prepended, the client reconciles the two edge states and touches only the two edge runs. It does not pass the combined history through `FeedSession`.

| Boundary case | Resolution |
| --- | --- |
| A JSONL record crosses indexer read buffers | Keep raw byte carry until a complete newline arrives. Commit no partial record. The live lane owns the unfinished tail. |
| The bounded tail contains over 150 entries while the newest semantic page is capped at 150 | Commit the caught-up logical fence, render the loaded summaries, and remove every unmatched pre-fence tail row. Older rows return only through `beforeCursor`. |
| A released viewport anchor falls in an unloaded pre-fence row | Freeze that one row and follow semantic cursors until its twin loads. Replace it under the same presentation key before committing the fence. |
| One source record emits several cards | Assign deterministic `source_part` values and consecutive ordinals. Every card keeps the same source range and a distinct `entry_id`. |
| A tool call and result fall in different pages | Index the call once at its original ordinal. The result updates that row by `item_id`, extends its source range, settles it, and increments `projectionRevision`. The call's loaded page remains non-cacheable and is conditionally refetched after the newest page observes that revision. |
| A tool call is below `liveFenceLine` and settles after it | Keep the unmatched result hidden until `resultOwnership` confirms the indexed call. Patch a loaded summary in place or suppress the unloaded history-owned result. |
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

`historyWatermark = indexedThroughByte` remains the server's body and cursor boundary. `readTailChunk` adds nullable `lastCompleteLineEnd`, computed from the last raw `0x0a` in its `Buffer` before UTF-8 decoding. All existing log transports carry that scalar beside the unchanged text and offsets. `useLogTail` stores it atomically with the line window and exposes it as read-only `completeRecordOffset`; bytes retained in `tailRef` do not advance it. This adds no fetch, decoding, cap, polling, or SSE scheduling behavior.

`TailSnapshot` persists the full bounded reconciliation sidecar atomically with its lines: epoch start byte, last requested and acknowledged offsets, complete physical-line count, aligned physical ordinals, `completeRecordOffset`, partial start, and partial disposition. A legacy cache entry without this sidecar is unmappable; its provisional rows retire wholesale at handoff and cannot become the released viewport anchor. The next transport chunk starts a fresh mapped epoch.

For reconciliation only, `useLogTail` captures the requested offset before each chunk. `chunk.start !== requestedOffset` starts a new `reconciliationEpoch`, clears `tailRef` and partial decoder ownership, and enters `discardUntilNewline`. Bytes through the next raw newline are discarded because their missing prefix makes the record unparseable; complete lines after that newline can enter the new epoch. The history controller drops provisional rows from earlier epochs with viewport compensation and never maps them into source coordinates.

Within the current epoch, every decoded newline increments a physical-line counter before whitespace filtering. Each retained nonblank line carries its epoch-local physical-line ordinal in a sidecar aligned with `tail.lines`. Blank lines therefore affect coordinate math even though they never enter the parser. The hook exposes read-only epoch id, complete physical-line count, first byte start, aligned physical ordinals, and partial disposition beside the existing window.

Before handoff, the existing bounded `FeedSession` tail is a provisional fallback. “Show earlier” cannot call raw history while this fallback is active. The ordinary fence requires `useLogTail.completeRecordOffset === indexedThroughByte` for a caught-up newest response. A complete-record offset below the watermark still owes history lines; an offset above it proves newer complete data already entered the logical window and triggers another semantic catch-up before handoff. At equality, the controller records `liveFenceLine = tail.linesStart + tail.lines.length` in the same render commit that installs the page.

There is one cold oversized-partial case: the current reconciliation epoch contains zero complete physical lines, its first byte start is at or after `indexedThroughByte`, and the caught-up history page proves that no later newline exists. The fence may install while `discardUntilNewline` remains active. A future newline discards that incomplete record from the live parser; the semantic index owns it after catch-up. Every complete line admitted by either fence belongs to semantic history, and only later logical lines feed the live parser.

This fence retires the whole pre-handoff raw window, including rows older than the newest 150 summaries. Loaded semantic twins replace matching rows by native item id or exact source-record coordinate. Unmatched rows disappear into unloaded history and can return only through `beforeCursor`. Bytes appended after the fence continue through the unchanged live parser. A later caught-up newest page can advance both `historyWatermark` and `liveFenceLine` through the same transaction.

At handoff, `completeLineCount` and the current epoch's complete physical-line count map every retained birth line to the index: `sourceLineNumber = completeLineCount - (epochCompleteLines - bornEpochPhysicalLine)`. `FeedSession` exposes immutable `bornEpochPhysicalLine` plus stable birth emission order `sourcePart`; later dedupe or echo updates can move its current source pointer without changing identity. The pair `(sourceLineNumber, sourcePart)` matches the durable summary without relying on preview text or timestamp. Native `itemId` remains the first choice for tool and response ownership.

If `/api/history` remains rebuilding or behind the current tail, `LogFeed` keeps rendering the bounded raw tail as explicitly provisional content. This fallback provides availability during cold rebuilds and sustained catch-up; it never enters the semantic page cache or claims `hasMore: false`. The eventual caught-up page exits fallback through the fence transaction below.

### Watermark transition

Advancing the fence is one feed-store transaction:

1. Capture the current viewport anchor and every live presentation key.
2. Match every loaded semantic page against live entries, beginning with the newest page, by native `itemId`; tool groups compare every member call id. Entries without a native id use mapped birth `sourceLineNumber` plus `sourcePart`.
3. Replace matched pre-fence live rows under their existing presentation keys. Remove every other pre-fence live row from the renderable live lane. Those removed rows become ordinary unloaded history and can return only through semantic cursor navigation.
4. Start a fresh live parser at `liveFenceLine`, seed it from the newest page's trailing `PageEdgeState`, and feed it only later logical lines. Publish the merged durable list to assistant claims and transcript echo reconciliation once.
5. Restore the captured anchor, then commit the semantic watermark and logical fence. A glued pane uses the existing bottom glue.

A released viewport can be anchored to a pre-fence live row that the newest page does not contain. The controller freezes that one presentation row and follows `beforeCursor` page by page for its exact source-record coordinate. Its twin replaces it under the same key. Other pre-fence rows cannot be revealed through raw “show earlier” during this bridge. A missing or rewritten source restores the nearest surviving successor with the existing pixel-offset compensation.

The live seed is `afterCheckpoint`, including compaction and OpenClaw model state as well as prose, command, user, turn, wakeup, and open-item state. It carries no body text. The first post-fence records can therefore finish a prose dedupe, continue one command group, complete a pending user pair, collapse a compaction twin, or emit a model switch against the correct baseline. `resultOwnership` remains the fallback for a call outside the bounded ownership subset.

An open item keeps the lane chosen by its call. `FeedSession` retains a result whose call is absent from its bounded window as a hidden reconciliation record carrying item id and bounded preview; it does not emit the service row yet. The next newest-page request submits that id for `resultOwnership` classification. `history` suppresses the live record and patches a loaded summary under its presentation key when available. `unmatched` after a caught-up response releases the record through the existing `showSvc` service-row behavior. Pending classification stays hidden. A call behind the fence therefore remains history-owned when its result arrives later, even after both the call row and its page left memory.

`anchorKey` becomes the durable `entry_id` after replacement. During that frame, the store retains an alias from the prior live anchor. The existing `viewportAnchor` lookup can restore either key, and the prepend height compensation at `src/components/LogFeed.tsx:412-420` keeps the reader's row at the same screen offset.

Unified durable entries are passed to `publishCanonicalAssistantClaims`. Their response ids and tool-call ids already match the identities consumed by `visibleRuntimeLiveTurnItems`, so a runtime row yields as soon as its durable twin is visible. Unified user rows are passed once to `publishTranscriptEchoes`. The echo ledger rekeys a live anchor to the durable `entry_id` during replacement, preserving one occurrence. Repeated identical messages still retire outbox entries one at a time through the existing occurrence accounting. Runtime overlay and outbox rows keep their current tail order after the merged durable feed.

The current `FeedSession` reset remains valid for a bounded live truncation or source replacement. Earlier-history navigation never moves its input window backward after this split, so loading a page cannot trigger the whole-history reset at `src/components/feed/parse.ts:2382-2394`.

## Rollout

The rollout order follows the originating priority exactly. Each phase has its own feature gate and can be disabled without changing JSONL.

### Phase 1: semantic history pages

- Add the locale-neutral projector, schema, incremental indexer, cursor codec, and `GET /api/history`.
- On initial open, request one newest page with `limit=150`; request no older raw chunks.
- Keep `useLogTail` subscribed through the existing live path.
- Add the `LogFeed` history controller, logical handoff fence, and semantic-entry merge. “Show earlier” consumes `beforeCursor`.
- Persist and return the newest page's exact unfiltered `afterCheckpoint`, resolve any referenced leading state, and seed the post-fence live parser in Phase 1.
- Treat validation and rebuilding as explicit temporary states. Continue showing the bounded live lane.

Exit proof: a normal initial open returns at most one semantic page, page walking has no gaps or repeats, append catch-up parses only the suffix after a background prefix-integrity pass, bounded audits progress independently, and loading older history never calls `useLogTail.loadOlder()`. After handoff, every live parser input has a logical line index at or above `liveFenceLine`.

### Phase 2: body on demand

- Replace any remaining inline page body with `preview`, `bodySize`, and `bodyRef`.
- Add the body route and expansion states.
- Keep raw source lookup for the bounded live lane until each live row receives its durable twin.

Exit proof: a collapsed large tool result contributes only bounded summary bytes to the page and browser heap; expansion reads its verified source range and returns the complete redacted body.

### Phase 3: incremental prepend and page cache

- Add the bounded LRU keyed by file generation, query scope, semantic page boundaries, and byte range.
- Add leading and trailing visible-run state for incremental prepend reconciliation and cache it beside the Phase 1 trailing checkpoint.
- Publish `projectionRevision` and conditionally refetch every loaded non-cacheable page after semantic progress, including pages outside the bounded live window.
- Reconcile only the added page and its adjoining edge. Remove the old raw-history prepend call from `LogFeed`.

Exit proof: prepending a page performs work proportional to that page plus its two edge runs. A test spies on the parser and proves no previously settled page or live window is parsed again. A late result refreshes and settles its loaded call page with over 150 semantic entries between call and result.

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
- same-generation append followed by older cursor navigation whose authenticated generation-match path reads zero manifest rows and performs zero Merkle hash operations;
- a cursor carrying its original `fileGeneration` and taking the full-prefix rebind path when the current projection generation differs;
- a successful generation rebind minting the next cursor with the current `fileGeneration`, followed by a descendant page taking the generation-match path;
- generation rotation between full-prefix verification and page selection causing the read-snapshot revision comparison to retry;
- source mutation during rebind verification with no prior generation rotation changing the source-revision digest and preventing page selection;
- stale-cursor rejection after truncation, replacement, earlier-byte rewrite, or normalizer-version change;
- a same-size in-place rewrite with restored mtime changing ctime and forcing generation rotation before any page or cursor is served;
- stale-cursor rejection when a projection rebuild follows a rewrite outside the cursor's local coordinate-digest range;
- an earlier full chunk rewritten on the same inode while the prior suffix stays unchanged, followed by appended JSONL, failing authoritative prefix validation and rotating the generation before suffix publication;
- an atomic pathname replacement during suffix parsing causing the final identity check to abort publication;
- an in-place truncate during suffix parsing causing final fstat to abort publication;
- a same-size in-place rewrite during suffix parsing causing the final ctime check to abort publication;
- growth from observed size S to final size T aborting publication and coalescing into the next stable validation attempt;
- continuous appends causing validation jobs to coalesce or restart while the provisional raw fallback remains visible, then committing the logical fence after writes stop;
- one slow catch-up returning `history_validating`, receiving no later writes, and still being observed as a new durable revision through the independent revalidation cadence;
- a stopped incomplete final JSONL record producing `caughtUp: true` with `indexedThroughByte` at the preceding newline;
- a large dormant backlog limiting one catch-up pass to 768 KiB or 2,000 complete records, returning `history_validating` within the join deadline while the client keeps its previously rendered snapshot or provisional fallback;
- one source record larger than 768 KiB moving to background range discovery while the foreground request returns within `HISTORY_REQUEST_JOIN_MS`;
- an oversized tool-result record far above 768 KiB recording peak RSS and record bytes while emitting one bounded preview plus body reference through the shared projector;
- an oversized incomplete record reaching EOF, clearing background activity with `scan_through = source_size`, then restarting from `indexed_through` after growth;
- request abort after worker detachment removing only its waiter while oversized background range discovery still completes;
- repeated timed-out requests joining one leased job, lease recovery after owner loss, and stale-generation completion failing the indexed-through CAS;
- requests observing different offsets and source sizes while one projection job remains leased joining that job under one fencing epoch;
- round-robin audit coverage reaching every chunk within `ceil(N / 4)` maintenance passes and invalidating before the detecting request returns rows;
- a chunk rewritten just behind `audit_next_chunk` while over four chunks append per pass still being inspected in the next frozen audit cycle;
- byte-accurate indexing across UTF-8 and read-buffer splits;
- call and result pairing across a page edge;
- command grouping and Codex prose dedupe across a page edge;
- a pending user representation that completes on the next page;
- a caught-up fence followed by one live Codex prose twin, command-run continuation, and pending-user echo each reconciling through the seeded trailing `PageEdgeState`;
- a fence between `compacted` and `context_compacted`, an OpenClaw model switch, and a filtered service tail each resuming from the exact unfiltered `afterCheckpoint`;
- many pending users and one open multiline plain block keeping inline `afterCheckpoint` at or below 12 KiB, resolving only matching out-of-line state, and keeping the complete history envelope within 80 KiB;
- multibyte checkpoint text enforcing limits through `length(CAST(... AS BLOB))` and final UTF-8 response encoding staying within the 80 KiB envelope;
- Phase 1 handoff receiving and applying `afterCheckpoint` before Phase 3 prepend-edge caching is enabled;
- a turn larger than the row and byte budgets;
- row and byte limits together, including the single-oversized-row progress case;
- two pages split between entries with the same source byte range receiving distinct cache identities;
- `showSvc` variants with the same byte range receiving distinct cache identities;
- cached invariant page data serving two disjoint `unmatchedItemId` sets with freshly computed, non-aliased ownership maps;
- a visible row rejected after the byte budget remaining eligible on the next page while filtered service rows advance the cursor;
- a raw tail containing over 150 pre-fence semantic entries rendering only the newest semantic page and no unmatched raw-history rows after handoff;
- a cold mount with an empty tail cache rendering provisional bounded rows until a caught-up page atomically fences the existing logical line window;
- a zero-budget or lagging-offset chunk with a current file size failing handoff until `completeRecordOffset === indexedThroughByte`, with over 150 provisional semantic entries retiring only after an exact later fence;
- complete lines appended between semantic response creation and handoff making `completeRecordOffset > indexedThroughByte`, deferring the fence until a newer caught-up page covers them;
- a permanently unterminated final record leaving transport offset ahead while `completeRecordOffset === indexedThroughByte`, allowing handoff without treating the partial suffix as a live row;
- a UTF-8 code point split across chunks preserving raw-buffer `lastCompleteLineEnd`, atomically caching `completeRecordOffset`, and reaching the exact fence despite a partial EOF;
- two id-less rows with identical kind, preview, and timestamp reconciling collision-free by `sourceLineNumber` plus `sourcePart`;
- a forward jump where `chunk.start` differs from the requested offset starting a new reconciliation epoch and dropping pre-gap provisional coordinates;
- a cold bounded chunk containing only the suffix of one oversized incomplete line installing the fence from the caught-up page's preceding newline;
- a missing-prefix record completing after a forward gap being discarded through its newline while the following complete record enters the new epoch;
- blank physical lines filtered from `tail.lines` still advancing epoch physical ordinals and preserving source-line mapping;
- a warm-cache remount restoring epoch counters, blank-line ordinals, complete offset, and partial disposition atomically for id-less reconciliation;
- id-less Codex assistant dedupe and pending-user echo moving current source pointers across the fence while immutable birth line plus part preserve identity;
- a cold rebuild that exceeds the request deadline rendering a bounded provisional raw tail, disabling raw “show earlier,” and reconciling through the first caught-up logical fence;
- a fence advancing across over 150 live entries while a released unloaded anchor keeps its position until semantic replacement;
- a tool call below the fence and result after it retaining one history-owned presentation with no live duplicate;
- a call evicted from the live window and all loaded pages before its result arrives, with bounded `resultOwnership` classification suppressing the unmatched live service row;
- over 64 hidden unmatched results draining through immediate bounded ownership follow-ups after writes have stopped;
- a tool result over 150 semantic entries after its call incrementing `projectionRevision` and refreshing the loaded non-tail call page after live-window eviction;
- a settled cached wakeup page staying immutable while global `activeWakeupItemId` moves to a later successful wakeup and returns after a newer failed wakeup;
- a distant row update leaving the newest page content unchanged while its unconditional 200 response carries the higher global revision and triggers the older-page refetch;
- an unchanged older page returning 304 with `X-History-Validated-Through-Revision`, followed by a concurrent later revision scheduling another check;
- a writer commit attempted between conditional ETag evaluation and response construction remaining outside the read transaction's acknowledged revision;
- a late update that changes a page's byte-budget boundary invalidating and restarting its older cursor chain without gaps or duplicates;
- index corruption producing a rebuilding response while the JSONL source remains intact;
- a same-size audit-driven generation rotation reaching a mounted caught-up client through the independent history revalidation cadence even while `/api/files` returns 304;
- one live row replaced by one durable twin with the same DOM presentation key;
- stable viewport offset during prepend and live-to-durable replacement;
- one outbox retirement for one echo before and after replacement;
- runtime prose and tool overlays yielding to matching durable identities;
- compact panes mounting only their bounded latest turn set;
- a search hit opening the semantic page that contains its ordinal.

Instrumentation should report validation bytes, semantic-parse bytes, validation retries, records parsed, inserted rows, updated rows, projection revision, page rows, serialized page bytes, non-cacheable page revalidations, rebuild reason, and whether a page came from cache. These are diagnostic counters. They do not become authority for transcript completeness.

## Non-goals

- Replacing or rewriting `useLogTail`, `logBus`, SSE, the polling fallback, `readTailChunk`, or `/api/log`. Raw-buffer `lastCompleteLineEnd` plus read-only reconciliation epoch, complete-line, and physical-ordinal metadata are the sole additive progress fields.
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
- A custom streaming JSON tokenizer for oversized records. Add it only if recorded peak RSS from the shared projector establishes a concrete server-memory problem.
- Cross-conversation ranking, recommendations, or semantic embeddings. Phase 6 needs indexed text and an exact page-opening cursor.

## Validation against the originating requirement

The requirement directly calls for this work. The design preserves the live byte path, changes history to semantic pages, makes SQLite disposable, keeps JSONL authoritative, defines the required schema and cursor rules, resolves the difficult page edges, removes bodies from collapsed pages, and follows the six requested rollout priorities.

The over-engineering pass removes a new daemon, a second database, server-rendered cards, embeddings, and configurable paging machinery. The first slice consists of one deep module, one route, one normalized summary type, one incremental projection, and the `LogFeed` merge needed to consume it.
