# Semantic paginated history

## Originating requirement

> Live = byte stream, History = indexed semantic pages. The pagination unit must become the semantic item/turn, kept in a disposable SQLite projection over the JSONL (which stays the source of truth — the index is NEVER canonical; a wrong projection is deleted and rebuilt). The next step is a design doc docs/design/semantic-paginated-history.md engineered against the current useLogTail -> FeedSession -> LogFeed pipeline, including the SQLite schema, cursor semantics and the tricky boundary cases. Do not rewrite useLogTail; the live logBus/SSE path stays as is.

Source: operator direction, 2026-08-31, embedded as the requirements anchor in issue #1327.

This design was verified against repository commit `0fc855c3a6a52a0b7e785e79ffd343740d3335bc`.

## Decision

Add a `SemanticHistoryIndex` module with one read interface: fetch a bounded page of normalized feed summaries for a conversation. The module owns an incremental SQLite projection and derives every row from the JSONL transcript. It also mints opaque cursors and body references. Callers never supply a transcript path or SQLite row id.

Keep the existing byte stream as the live lane. `useLogTail`, `logBus`, `/api/logs/stream`, the polling fallback, and `readTailChunk` keep their current responsibilities. `LogFeed` combines a bounded live lane with semantic history pages at the feed-entry seam. Loading earlier history no longer prepends raw lines into `FeedSession`.

Store bounded previews and render facts in SQLite. Store no canonical body copy. Expanding a card resolves its opaque `bodyRef`, reads the named source byte range from JSONL, applies the same normalization and redaction rules, and returns the full logical body.

Use a dedicated disposable `semantic-history.sqlite` file. Extract shared Bun SQLite setup and private-permission handling from the transcript-search-specific code at `src/lib/search/transcriptSearch.ts:158-224`. History connections use WAL and `busy_timeout = 0`; a busy result leaves the event loop, joins existing work, or retries with bounded asynchronous backoff. Legacy search indexing can never hold the history request path behind its long write transaction. Phase 6 moves transcript search onto the semantic rows, then removes `transcript-search.sqlite` after parity is proved.

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
  classifyOwnership(query: OwnershipQuery): Promise<OwnershipResult>;
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

No separate index daemon is required. The existing catalog refresh can enqueue catch-up work, and every history request calls `catchUp` before reading. One process-local singleflight coalesces work; short compare-and-set transactions publish one current delta and discard duplicate work from another process.

## SQLite projection

The following tables live in the dedicated disposable history database. Integers that hold byte offsets or sizes use SQLite's signed 64-bit integer storage.

```sql
CREATE TABLE history_files (
  conversation_id       TEXT NOT NULL,
  native_generation     INTEGER NOT NULL DEFAULT -1,
  transcript_path       TEXT NOT NULL,
  source_generation     TEXT NOT NULL,
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
  CHECK (length(CAST(entry_id AS BLOB)) <= 80),
  CHECK (item_id IS NULL OR length(CAST(item_id AS BLOB)) <= 64),
  CHECK (turn_id IS NULL OR length(CAST(turn_id AS BLOB)) <= 64),
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
  CHECK (length(CAST(inline_state_json AS BLOB)) <= 8192)
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

```

`ordinal` is the deterministic source-order position of one atomic semantic entry. `source_line_number` is the zero-based physical newline-delimited line number and counts blank lines even though they emit no semantic entry. One source line can emit several entries, so `source_part` records the projector's stable birth order within that line. Appends only allocate larger ordinals and line numbers. A later echo or tool result updates the entry while its birth line and part remain immutable.

`turn_id` uses an engine turn identity when the transcript supplies one. The projector otherwise derives it from the ordinal of the user or turn-opening entry. Records outside a turn may use `NULL`. `item_id` carries a native response, message, or tool-call identity when one exists.

Every native identity crosses one funnel: `identityKey(domain, raw) = base64url(SHA-256("history-id-v1", domain, raw UTF-8 bytes))`. Storage, page summaries, live matching, ownership requests, command-group member ids, turn ids, and `activeWakeupItemId` use this fixed 43-byte key. Raw over-limit ids remain only in the source range and never enter SQLite or response metadata. Coordinate-derived identities use the same bounded encoding.

`native_generation = -1` represents a legacy catalog entry with no projected native generation. This keeps the composite primary key total and deterministic.

`source_generation` is the catalog's durable identity for the underlying JSONL lineage. It survives deletion or rebuilding of `semantic-history.sqlite` and rotates only when the catalog proves truncation, replacement, or rewrite. The existing conversation registry stores this small token beside the source binding, and `/api/files` includes it as `FileEntry.sourceGeneration` before `LogFeed` mounts `useLogTail`; JSONL content remains authoritative. `file_generation` is the disposable projection/cache epoch and rotates on projection rebuild even when `source_generation` stays fixed.

`entry_id` is the stable feed identity. At first emission it uses a namespaced native item identity when that identity is available and unique. The fallback is a hash of conversation scope, native generation, source byte coordinate, raw-record digest, and `source_part`. A native identity learned from a later twin goes into `item_id` and does not rewrite `entry_id`. This preserves the current parser's first-entry key behavior and recreates the same identity after a clean projection rebuild. A command group's presentation identity uses the first member's `entry_id`. SQLite row ids and the random `file_generation` never participate.

`preview` is valid UTF-8 capped at 512 bytes after redaction. `summary_json` contains kind-specific render facts and has an 8 KiB encoded ceiling. Lists inside it have their own item and string caps. The projector converts any excess to counts and truncation flags. `body_size` is the UTF-8 size of the full redacted logical body. The source body remains in JSONL.

`parser_state_json`, `history_open_calls`, and periodic checkpoints persist the minimum state needed to resume after `indexed_through`: the current turn, pending Codex user representation, adjacent assistant dedupe fingerprint, trailing command run, compaction marker, and other engine state already held by `FeedSession`. Open call identities use their own table because correctness requires retaining every unresolved call.

`continuity_root` is a deterministic line-chain digest. Starting from a domain-separated seed, each complete physical line updates `root = SHA-256(root, lineByteLength, exactLineBytes)`. Appends extend it from the committed root using suffix lines, and a rebuild recreates it from JSONL. Cursor rebind recomputes the chain through the frozen `continuity_length`.

A cursor freezes a source continuity identity containing the stable conversation scope, its `continuity_length`, and the streaming SHA-256 digest for exactly that prefix. Appending bytes after `continuity_length` leaves this identity unchanged. A truncation or rewrite anywhere inside the prefix changes it. This identity comes from source bytes and survives deletion of the SQLite projection. `file_generation` remains the cache epoch and can rotate during a projection-only rebuild.

## Incremental indexing contract

1. Resolve the conversation to its current transcript through the catalog and apply the same allowed-root and regular-file requirements used by `/api/log`.
2. Resolve the catalog-bound pathname, open it with no symlink following, and take bigint descriptor stats. Device, inode, size, mtime, and nanosecond ctime form the observed source revision. Re-read the catalog binding and pathname identity before publication.
3. Before suffix catch-up starts, set the projection to `validating` and join one process-local singleflight keyed by `file_generation`. Requests in another process may duplicate bounded read work; only the short publication compare-and-set can win. A request waiter can time out without cancelling the shared in-process work.
4. Validate the fixed overlap guard immediately before `indexed_through`, then extend `continuity_root` with complete suffix lines. Phase 1 trusts the previously committed prefix root during ordinary append catch-up.
5. One semantic pass stops after the earlier of `INDEX_CATCH_UP_BYTES = MAX_CHUNK` (768 KiB), 2,000 complete source records, or the frozen observed size. Byte spans use the original bytes, so multibyte UTF-8 text cannot skew offsets. Later passes continue from the committed newline.
6. If no newline appears within the byte budget, detached background work scans fixed-size buffers for the first newline and retains only `[recordStart, recordEnd)` plus its digest. After finding the newline, it invokes the shared full-record projector once as the single-oversized-record exception. The worker records peak RSS and record bytes for this path. The projection still stores only bounded preview, summary facts, body size, and source range; the full record is released after projection.
7. Immediately before each commit, fstat the descriptor, stat the bound pathname, and re-read the catalog binding. Device and inode must match, size must remain at least the frozen observed size, and pathname plus binding must stay unchanged. A same-size mtime or ctime change, shrink, replacement, or binding change aborts. Growth beyond the frozen size queues the next suffix epoch and does not invalidate the current append range.
8. Treat a failed suffix check, shrink, device or inode change, same-size ctime change, or catalog-generation change as a replacement generation. Mark the old projection invalid, rotate both source and projection generations as appropriate, and rebuild from byte zero.
9. Apply every `ProjectionDelta`, new continuity root, and parser state in one short transaction. The transaction compare-and-sets `file_generation` plus expected `indexed_through`; a failed CAS discards duplicate or stale work. Advance `indexed_through` only through the final complete newline committed in that transaction. Set `source_size` to the frozen observed size and `scan_through` to the byte reached by this pass. A pass or background range scan that reaches stable EOF with one incomplete final record sets `scan_through = source_size` and leaves `indexed_through` at the preceding newline. Increment `projection_revision` once when the transaction inserts or updates a semantic row or changes page-edge state exposed to clients.
10. Keep `file_generation` unchanged after a validated append. Update earlier rows in place when a later source record settles a call, joins a duplicate representation, or completes another open semantic item. Increment the entry `revision`, extend `byte_end`, and mark the row settled when its edge state closes.
11. Schedule another bounded pass while `scan_through < source_size`. A request joins through `HISTORY_REQUEST_JOIN_MS = 25`, then receives `history_validating`; no indexed rows are served from that generation until the job reaches its frozen size and returns the state to `ready`. Growth beyond that size queues the next epoch, so active appenders still publish bounded semantic snapshots. A missing projection follows the same bounded build from byte zero and returns rebuilding.

The common rebuild triggers are:

- source size below `indexed_through`;
- a changed device or inode identity;
- a changed source continuity root for already indexed bytes;
- a same-size source with a new mtime or ctime;
- a failed SQLite integrity check, schema-version mismatch, impossible offset, duplicate deterministic identity, or projector invariant failure;
- an explicit normalizer-version change that has no proven in-place migration.

A replacement or rewrite marks the old generation invalid, deletes its rows and checkpoints in one transaction, creates a new random `file_generation`, and starts at byte zero. Database corruption closes the database, removes the disposable database plus its WAL and shared-memory files, and rebuilds every projection from JSONL. No repair path copies rows out of a suspect projection.

Phase 1 trusts the committed line-chain root and suffix overlap for ordinary append growth. A hidden same-inode prefix rewrite combined with append can remain undetected until a later rebuild. This limitation is explicit; writer-coordinated continuity or measured audit hardening is deferred.

SQLite remains disposable. Cursors bind their projection generation, body references validate their exact source range, and any observed inconsistency deletes the projection. Cursor rebinding after a generation mismatch recomputes the frozen JSONL prefix digest and compares it with the cursor's source continuity identity.

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
  sourceGeneration: string;
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
  activeWakeupItemId: string | null;
  wakeupRevision: number;
  cacheable: boolean;
  pageEtag: string;
  edge: PageEdgeState;
}
```

The row and byte limits select the longest contiguous newest-to-oldest consumed prefix. Filtered service rows accumulate in a pending segment. For each visible candidate, the server trials that candidate, constructs every derived page field, and UTF-8 encodes the complete envelope. A fitting trial commits its visible row and the newer pending filtered rows. A trial that exceeds the row, 64 KiB entries, or 80 KiB envelope limit commits the pending filtered segment, then stops with the visible candidate and every older row unconsumed. If the first visible candidate alone exceeds 64 KiB, the server consumes and returns that one row together with any newer filtered segment under the single-oversized-row exception while fixed metadata remains capped. At source start, a trailing filtered-only segment may commit by itself.

One request examines at most `HISTORY_SCAN_ROWS = 2000` indexed entries, and filtered rows count toward that scan budget. If the scan budget ends inside a filtered-only segment before another visible row, the server commits that segment, returns an empty `entries` array with an advancing `beforeCursor`, and leaves `hasMore: true`. The client automatically drains such empty progress pages one request at a time until it receives a visible row or reaches the start. Envelope rejection consumes only the filtered rows newer than the rejected visible candidate; that candidate remains next.

`beforeCursor`, `hasMore`, `hiddenServiceCount`, `pageRange`, both visible edge states, `cacheable`, and `pageEtag` are computed only from the final committed prefix. The server performs no post-serialization row removal, so cursor rewind is unnecessary and an omitted visible row stays eligible for the next request.

Ownership classification uses a separate `POST /api/history/ownership` response and never enters the page envelope or LRU. The request carries conversation plus at most 64 `identityKey` values, with a 64-byte UTF-8 cap per key and a 16 KiB request cap. The response does not echo ids. It returns one compact integer status per request position: `0` pending, `1` history, `2` unmatched. The status count must equal the id count, and the complete response stays below 1 KiB. `history` means `history_entries.item_id` or `history_open_calls` owns the call, including a settled call outside loaded pages. `unmatched` is returned only from a ready, caught-up projection; validating ids remain pending.

The client sends one ownership batch at a time and immediately sends the next while ids remain beyond the cap. Status `0` stays in a pending set. Pending keys retry on the next ready newest-page revision and on an ownership backoff that starts at `OWNERSHIP_RETRY_MS = 500` and caps at 5 seconds while the pane is mounted. A ready caught-up ownership response must resolve every requested key to `1` or `2`. This drain continues without a source-size event. Page-cache lookup and cursor boundaries are independent of every ownership request.

`hasMore` is derived from the existence of an older ordinal in the verified projection. A projection in `validating`, `building`, or `invalid` state cannot produce a history page.

`queryScope` is the full SHA-256 digest of a versioned canonical serialization containing the stable conversation scope and every query option that changes the row sequence, including `showSvc` and the normalizer version. `pageRange` records both semantic cursor boundaries with ordinal and `sourcePart`. The initial upper boundary records `endAtByte: indexedThroughByte`, so an append cannot reuse an older newest-page entry. The client stores a cacheable page under `[fileGeneration, queryScope, pageRange.requestedBefore, pageRange.nextBefore, byteRange]`. The key is encoded as one canonical JSON array, which avoids delimiter and field-order aliases. The semantic boundaries distinguish pages that split several entries sharing one source byte range. `queryScope` distinguishes filtered variants with identical source ranges.

`cacheable` is true only when every returned entry is settled and both page edges are closed. A wakeup entry settles when its own result is known; its requested schedule, resolved schedule, and failure fact are immutable page data. File-global `activeWakeupItemId` identifies the newest wakeup call that is not known failed, so a pending call is provisionally active exactly like the current parser. The renderer derives each cached wakeup's active or superseded state by comparing its `itemId` with that global identity. `wakeupRevision` advances when a call appears and whenever a result changes the selected identity; a failed newest call restores the prior non-failed id. The unconditional newest-page response carries both fields, so cached historical rows re-render without page refetch. Other older cacheable pages are immutable under append. Empty source ranges use `byteRange: null`; their semantic boundaries still produce a unique cache identity.

Every loaded page with `cacheable: false` retains its original request cursor, `projectionRevision`, `validatedThroughRevision`, and `pageEtag`, regardless of its distance from the tail. The history controller refreshes the newest semantic page whenever `useLogTail.size` advances and on a mounted `HISTORY_REVALIDATE_MS = 5000` cadence independent of `/api/files` 304 publication. Returning a hidden tab to visible state triggers an immediate refresh. A projection actively validating its frozen epoch returns `history_validating`, and the controller keeps the bounded raw fallback plus retry backoff. A ready 200 response is caught up to its stable observed source revision. `caughtUp: true` can coexist with `indexedThroughByte` at the prior complete newline when one incomplete final record occupies the remaining bytes. The independent cadence observes completed background work and source-generation changes on static-size files, then clears stale page-cache keys before rebuilt pages install.

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
| 503 | `history_busy` | Preserve the rendered snapshot or provisional fallback; bounded asynchronous lock retries were exhausted. |

## Cursor semantics

Ordering uses `ordinal`, never timestamp. Timestamps can be absent, duplicated, or out of source order. A cursor names the exclusive lower boundary after every row consumed for the current page. With service rows included, this normally equals the position of the oldest returned entry. With service rows omitted, it can equal a skipped service position below that entry.

The opaque token carries a version, `sourceGeneration`, `fileGeneration`, `queryScope`, the normalizer version, the last consumed ordinal and `sourcePart`, the corresponding source coordinate, a local coordinate digest, and the complete source continuity identity frozen by the first page in this cursor epoch. Descendant cursors within that epoch inherit both generations, `continuity_length`, and root while the source appends. The server authenticates the canonical payload with HMAC-SHA-256 using a state-local mode-`0600` key; rotation of that key invalidates outstanding cursors. The token carries no path and no SQLite row id. The decoder limits token size, verifies the MAC before fields are trusted, validates every integer, and rejects a scope mismatch.

Validation compares the authenticated token's `fileGeneration` with the current projection. A match trusts the committed generation and performs the local coordinate check; it performs no prefix hash. A mismatch captures descriptor device and inode, pathname identity, catalog binding, and the token's frozen `continuity_length`, then verifies exactly `[0, continuity_length)` without a SQLite write transaction. It re-fstats the descriptor, pathname, and binding afterward. Device, inode, pathname, and binding must stay fixed; size may grow beyond `continuity_length`. The recomputed frozen-prefix digest must remain identical, so concurrent appends cannot starve rebinding.

Page selection then uses one SQLite read transaction. That snapshot reads the current ready generation, page rows, edge state, and revision together. The generation must remain the verified target, and the token's frozen-prefix root must match the source proof. Failure restarts or returns `history_cursor_stale`. Success forces a 200 response that starts a new cursor epoch: the returned cursor and every descendant token carry the generation read in that snapshot while retaining the original frozen `continuity_length` and root. A rotation committed after the read snapshot is handled on the next request.

Cursor behavior is:

- Append stability: existing ordinals and source coordinates stay fixed. The frozen continuity prefix stays byte-identical under append, so an older-page cursor remains valid while the file grows.
- Projection rebuild stability: a rebuild under the same normalizer deterministically recreates ordinals and the fixed-prefix continuity root. The server detects the cursor's old `fileGeneration` and rebinds it only after the complete prefix identity matches.
- Rewrite safety: truncation, replacement, or same-size ctime change rotates the source and projection generations. An old cursor then passes through full-prefix verification. A failed prefix identity returns `history_cursor_stale`; a matching local coordinate digest cannot override it. Hidden same-inode rewrite-plus-append follows the explicit Phase 1 limitation above.
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

`afterCheckpoint` has at most 8 KiB of inline state plus opaque `checkpointRef`. Inline fields cover assistant representation shape and fingerprint, `codexCompacted`, OpenClaw provider/model baseline, current turn, trailing group, and bounded recent identities. Every unbounded family is row-oriented in `history_checkpoint_state`: one row per pending user fingerprint, wakeup entry reference, model boundary, or open ownership key. Each state row is capped at 2 KiB and stores identifiers, fingerprints, counters, or source ranges. An open multiline plain block stores its source byte range and digest, never its complete text.

The fresh live parser accepts the inline seed only when checkpoint version and normalizer version match. If a leading live record needs an out-of-line family, the controller calls `SemanticHistoryIndex.resolveCheckpoint(checkpointRef, leadingRecordFacts)` through a bounded checkpoint-resolution request. The server returns only the matching transition facts; it reads a referenced plain-block range only when that transition actually closes the block. Resolution responses have a 16 KiB limit and the same generation binding as the page. `resultOwnership` remains the specialized call-id path.

The normal history response reserves a 16 KiB fixed-metadata budget, including the at-most-8-KiB inline checkpoint, both edge states, cursors, scopes, generation data, and global wakeup fields. `entries` has its separate 64 KiB budget, producing an 80 KiB envelope ceiling. Every limit measures UTF-8 bytes, and construction rejects fixed metadata that exceeds its reservation. Page selection trials the fully encoded envelope as described above. The single-oversized-entry exception can exceed the entry portion for one row while fixed metadata remains within 16 KiB.

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

`TailSnapshot` persists `sourceGeneration` and the full bounded reconciliation sidecar atomically with its lines: epoch start byte, last requested and acknowledged offsets, complete physical-line count, aligned physical ordinals, `completeRecordOffset`, partial start, and partial disposition. The cache key is `[path, FileEntry.sourceGeneration]`, so synchronous hook initialization cannot restore a predecessor generation. A legacy cache entry without the token and sidecar is unmappable and ignored before render. The next transport chunk starts a fresh mapped epoch.

The hook subscription generation also captures its expected `sourceGeneration`; callbacks from a prior subscription are ignored. A different `fileGeneration` with the same source token invalidates only semantic page caches and leaves the live reader untouched. A history response with a newer `sourceGeneration` updates the binding and calls additive `useLogTail.rebaseSourceGeneration()`: delete the prior token's tail cache, clear lines, `tailRef`, reconciliation metadata, and parser snapshot, reset the acknowledged offset to zero, advance the hook generation, and reconnect through the existing logBus for an immediate read. The rebuilt semantic page waits for the first chunk accepted under that expected token before handoff. This reset handles same-size rewrites and pathname replacements that produce no file-size event; a projection-only rebuild causes no live jump.

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

An open item keeps the lane chosen by its call. `FeedSession` retains a result whose call is absent from its bounded window as a hidden reconciliation record carrying item id and bounded preview; it does not emit the service row yet. The controller submits that key through the separate ownership endpoint. `history` suppresses the live record and patches a loaded summary under its presentation key when available. `unmatched` after a caught-up response releases the record through the existing `showSvc` service-row behavior. Pending classification stays hidden and follows the bounded retry contract. A call behind the fence therefore remains history-owned when its result arrives later, even after both the call row and its page left memory.

`anchorKey` becomes the durable `entry_id` after replacement. During that frame, the store retains an alias from the prior live anchor. The existing `viewportAnchor` lookup can restore either key, and the prepend height compensation at `src/components/LogFeed.tsx:412-420` keeps the reader's row at the same screen offset.

Unified durable entries are passed to `publishCanonicalAssistantClaims`. Their response ids and tool-call ids already match the identities consumed by `visibleRuntimeLiveTurnItems`, so a runtime row yields as soon as its durable twin is visible. Unified user rows are passed once to `publishTranscriptEchoes`. The echo ledger rekeys a live anchor to the durable `entry_id` during replacement, preserving one occurrence. Repeated identical messages still retire outbox entries one at a time through the existing occurrence accounting. Runtime overlay and outbox rows keep their current tail order after the merged durable feed.

The current `FeedSession` reset remains valid for a bounded live truncation or source replacement. Earlier-history navigation never moves its input window backward after this split, so loading a page cannot trigger the whole-history reset at `src/components/feed/parse.ts:2382-2394`.

## Rollout

The rollout order follows the originating priority exactly. Each phase has its own feature gate and can be disabled without changing JSONL.

### Phase 1: semantic history pages

- Add the locale-neutral projector, the minimal `history_files`/`history_entries`/checkpoint schema, process-local append checkpointing, cursor codec, and `GET /api/history`.
- On initial open, request one newest page with `limit=150`; request no older raw chunks.
- Keep `useLogTail` subscribed through the existing live path.
- Add the `LogFeed` history controller, logical handoff fence, and semantic-entry merge. “Show earlier” consumes `beforeCursor`.
- Persist and return the bounded inline newest-page `afterCheckpoint` and seed common post-fence live state. A checkpoint that needs out-of-line resolution keeps the provisional raw fallback until Phase 3 support is enabled.
- Treat validation and rebuilding as explicit temporary states. Continue showing the bounded live lane.

Exit proof: a normal initial open returns at most one semantic page, page walking has no gaps or repeats, append catch-up reads and parses only the suffix plus fixed overlap, rebuilding deletes only disposable projection state, and loading older history never calls `useLogTail.loadOlder()`. After handoff, every live parser input has a logical line index at or above `liveFenceLine`.

### Phase 2: body on demand

- Replace any remaining inline page body with `preview`, `bodySize`, and `bodyRef`.
- Add the body route and expansion states.
- Keep raw source lookup for the bounded live lane until each live row receives its durable twin.

Exit proof: a collapsed large tool result contributes only bounded summary bytes to the page and browser heap; expansion reads its verified source range and returns the complete redacted body.

### Phase 3: incremental prepend and page cache

- Add the bounded LRU keyed by file generation, query scope, semantic page boundaries, and byte range.
- Add leading and trailing visible-run state for incremental prepend reconciliation and cache it beside the Phase 1 trailing checkpoint.
- Add out-of-line checkpoint resolution, unmatched-result ownership classification, and revision-driven reconciliation for rare cross-window state.
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

The Phase 1 blocking gate is intentionally small:

- deterministic semantic rows from Claude and Codex fixtures;
- bounded newest-page and backward-cursor walking with no gaps or repeats;
- suffix append checkpointing plus truncation/replacement rebuild;
- one initial semantic page replacing the bounded provisional tail without calling `useLogTail.loadOlder()`;
- projection-only rebuild preserving `sourceGeneration` and live-tail state;
- row, entry-byte, and fixed-metadata limits including one oversized row.

The cumulative verification catalog below activates with the phase that owns each mechanism; it does not block the Phase 1 slice:

- deterministic ordinals and entry ids across a projection rebuild;
- over-limit native tool, response, turn, and wakeup ids producing the same fixed `identityKey` in SQLite, pages, live matching, ownership, and active-wakeup metadata;
- cursor stability after append and after a clean rebuild;
- a projection-rebuild cursor rebind completing while later bytes append beyond `continuity_length`, then minting the current-generation cursor without restart;
- same-generation append followed by older cursor navigation whose authenticated generation-match path performs no prefix hash;
- a cursor carrying its original `fileGeneration` and taking the full-prefix rebind path when the current projection generation differs;
- a successful generation rebind minting the next cursor with the current `fileGeneration`, followed by a descendant page taking the generation-match path;
- generation rotation between full-prefix verification and page selection causing the read-snapshot revision comparison to retry;
- source mutation during rebind verification with no prior generation rotation changing the source-revision digest and preventing page selection;
- stale-cursor rejection after truncation, replacement, earlier-byte rewrite, or normalizer-version change;
- a same-size in-place rewrite with restored mtime changing ctime and forcing generation rotation before any page or cursor is served;
- stale-cursor rejection when a projection rebuild follows a rewrite outside the cursor's local coordinate-digest range;
- an atomic pathname replacement during suffix parsing causing the final identity check to abort publication;
- an in-place truncate during suffix parsing causing final fstat to abort publication;
- a same-size in-place rewrite during suffix parsing causing the final ctime check to abort publication;
- growth from frozen size S to final size T committing through S, returning ready `caughtUp: false`, and queuing T for the next suffix epoch;
- continuous appends allowing bounded frozen epochs to publish without starvation while the provisional raw tail covers bytes beyond the newest committed snapshot;
- one slow catch-up returning `history_validating`, receiving no later writes, and still being observed as a new durable revision through the independent revalidation cadence;
- a stopped incomplete final JSONL record producing `caughtUp: true` with `indexedThroughByte` at the preceding newline;
- a large dormant backlog limiting one catch-up pass to 768 KiB or 2,000 complete records, returning `history_validating` within the join deadline while the client keeps its previously rendered snapshot or provisional fallback;
- one source record larger than 768 KiB moving to background range discovery while the foreground request returns within `HISTORY_REQUEST_JOIN_MS`;
- an oversized tool-result record far above 768 KiB recording peak RSS and record bytes while emitting one bounded preview plus body reference through the shared projector;
- an oversized incomplete record reaching EOF, clearing background activity with `scan_through = source_size`, then restarting from `indexed_through` after growth;
- request abort after worker detachment removing only its waiter while oversized background range discovery still completes;
- the legacy search database holding its long writer transaction while the isolated history route still returns within the join deadline, plus exhausted history lock retries returning typed 503 `history_busy` with no raw 500;
- byte-accurate indexing across UTF-8 and read-buffer splits;
- call and result pairing across a page edge;
- command grouping and Codex prose dedupe across a page edge;
- a pending user representation that completes on the next page;
- a caught-up fence followed by one live Codex prose twin, command-run continuation, and pending-user echo each reconciling through the seeded trailing `PageEdgeState`;
- a fence between `compacted` and `context_compacted`, an OpenClaw model switch, and a filtered service tail each resuming from the exact unfiltered `afterCheckpoint`;
- many pending users and one open multiline plain block keeping inline `afterCheckpoint` at or below 8 KiB, resolving only matching out-of-line state, and keeping fixed metadata within 16 KiB;
- multibyte checkpoint text enforcing limits through `length(CAST(... AS BLOB))` and final UTF-8 response encoding staying within the 80 KiB envelope;
- Phase 1 handoff receiving and applying `afterCheckpoint` before Phase 3 prepend-edge caching is enabled;
- a turn larger than the row and byte budgets;
- row and byte limits together, including the single-oversized-row progress case;
- two pages split between entries with the same source byte range receiving distinct cache identities;
- `showSvc` variants with the same byte range receiving distinct cache identities;
- cached invariant page data serving two disjoint ownership requests through separate 16 KiB responses with no page or cursor mutation;
- a maximal 64-key ownership request respecting the 64-byte key and 16 KiB request caps while returning 64 ordered statuses below 1 KiB;
- a visible row rejected after the byte budget remaining eligible on the next page while filtered service rows advance the cursor;
- a retained visible row, an envelope-rejected visible row, and filtered rows on both sides committing one contiguous prefix and recomputing every derived page field from it;
- over 2,000 filtered service rows before the next visible row producing bounded empty progress pages that the client drains to the visible row without gaps;
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
- a static source returning ownership status `0` during validation and resolving the same pending key to `history` or `unmatched` through bounded ownership backoff after ready;
- a tool result over 150 semantic entries after its call incrementing `projectionRevision` and refreshing the loaded non-tail call page after live-window eviction;
- a settled cached wakeup page staying immutable while a newer pending call becomes provisionally active, its failure restores the prior id, and `wakeupRevision` advances at both transitions;
- a distant row update leaving the newest page content unchanged while its unconditional 200 response carries the higher global revision and triggers the older-page refetch;
- an unchanged older page returning 304 with `X-History-Validated-Through-Revision`, followed by a concurrent later revision scheduling another check;
- a writer commit attempted between conditional ETag evaluation and response construction remaining outside the read transaction's acknowledged revision;
- a late update that changes a page's byte-budget boundary invalidating and restarting its older cursor chain without gaps or duplicates;
- index corruption producing a rebuilding response while the JSONL source remains intact;
- deleting and rebuilding only the SQLite projection changing `fileGeneration` while preserving `sourceGeneration`, tail offsets, partial decoder, and viewport;
- rewriting the source while the pane is unmounted, then remounting a warm tail snapshot with the old or absent `sourceGeneration` and resetting it before cached rows render;
- a same-size `sourceGeneration` rotation with changed newline layout clearing the tail cache, partial decoder, and reconciliation sidecar before a later append enters the new epoch;
- one live row replaced by one durable twin with the same DOM presentation key;
- stable viewport offset during prepend and live-to-durable replacement;
- one outbox retirement for one echo before and after replacement;
- runtime prose and tool overlays yielding to matching durable identities;
- compact panes mounting only their bounded latest turn set;
- a search hit opening the semantic page that contains its ordinal.

Instrumentation should report validation bytes, semantic-parse bytes, validation retries, records parsed, inserted rows, updated rows, projection revision, page rows, serialized page bytes, non-cacheable page revalidations, rebuild reason, and whether a page came from cache. These are diagnostic counters. They do not become authority for transcript completeness.

## Non-goals

- Replacing or rewriting `useLogTail`, `logBus`, SSE, the polling fallback, `readTailChunk`, or `/api/log`. Raw-buffer `lastCompleteLineEnd`, read-only reconciliation metadata, and the generation-reset method are the sole additive live reconciliation surface.
- Treating SQLite as a source of record, a recovery source, or evidence that missing JSONL content never existed.
- Loading full bodies during page fetch.
- Guaranteeing that one whole turn fits in one page.
- Running virtualization before semantic paging and body removal bound browser data.
- Changing transcript formats or asking engine writers to emit new records.
- Accepting arbitrary source paths through the history or body routes.

## Deferred — not currently justified

- A standalone indexing process. The existing Viewer process, SQLite transaction, and catalog-triggered catch-up provide the required ownership.
- Persistent cross-process index leases and fencing epochs. Phase 1 uses process-local singleflight plus publication CAS; add durable leases only after duplicate-work measurements justify them.
- A writer-coordinated append-continuity token or bounded rolling audit. Add one when production evidence shows the hidden rewrite-plus-append window must close; prefer the lower-cost mechanism supported by the writer/runtime path.
- Locale-specific indexed summaries. Locale-neutral facts keep one projection valid for every client.
- User-configurable page-byte budgets. One server budget keeps memory and cursor behavior predictable.
- Server-rendered feed cards or cached HTML. The existing `FeedItem` rendering seam remains useful.
- A custom streaming JSON tokenizer for oversized records. Add it only if recorded peak RSS from the shared projector establishes a concrete server-memory problem.
- Cross-conversation ranking, recommendations, or semantic embeddings. Phase 6 needs indexed text and an exact page-opening cursor.

## Validation against the originating requirement

The requirement directly calls for this work. The design preserves the live byte path, changes history to semantic pages, makes SQLite disposable, keeps JSONL authoritative, defines the required schema and cursor rules, resolves the difficult page edges, removes bodies from collapsed pages, and follows the six requested rollout priorities.

The over-engineering pass removes a new daemon, custom oversized-record tokenizer, server-rendered cards, embeddings, and configurable paging machinery. The first slice consists of one deep module, one route family, one normalized summary type, one incremental projection, and the `LogFeed` merge needed to consume it.
