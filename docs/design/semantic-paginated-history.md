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
  continuity_hash        BLOB NOT NULL,
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

## Incremental indexing contract

1. Resolve the conversation to its current transcript through the catalog and apply the same allowed-root and regular-file requirements used by `/api/log`.
2. Open one descriptor and take the source stat from that descriptor. Compare its file identity, size, mtime, and the continuity hash immediately before `indexed_through` with `history_files`.
3. For an append, start at `indexed_through`, carry an incomplete final JSONL record across read buffers, and parse each complete record once. Byte spans use the original bytes, so multibyte UTF-8 text cannot skew offsets.
4. Apply every `ProjectionDelta` and its new parser state in one transaction. Advance `indexed_through` only through the final complete newline committed in that transaction. A crash leaves the previous rows and checkpoint intact.
5. Keep `file_generation` unchanged for valid appends. Update earlier rows in place when a later source record settles a call, joins a duplicate representation, or completes another open semantic item. Increment `revision`, extend `byte_end`, and mark the row settled when its edge state closes.
6. Schedule catch-up from the existing catalog refresh. A request also performs bounded suffix catch-up. A missing projection begins a full build. During a long build, the route reports `rebuilding`; the UI keeps its bounded live lane visible and never interprets an incomplete index as an empty conversation.

The common rebuild triggers are:

- source size below `indexed_through`;
- a changed device or inode identity;
- a changed continuity hash for already indexed bytes;
- a same-size source with a new mtime;
- a failed SQLite integrity check, schema-version mismatch, impossible offset, duplicate deterministic identity, or projector invariant failure;
- an explicit normalizer-version change that has no proven in-place migration.

A replacement or rewrite marks the old generation invalid, deletes its rows and checkpoints in one transaction, creates a new random `file_generation`, and starts at byte zero. Database corruption closes the database, removes the disposable database plus its WAL and shared-memory files, and rebuilds every projection from JSONL. No repair path copies rows out of a suspect projection.

The append fast path verifies the prior suffix before consuming new bytes. A low-priority audit checks stored source-chunk hashes across older regions. If an in-place writer changed an earlier region and then appended, that audit rotates the generation and rebuilds. Until the rebuild finishes, the route reports rebuilding and the live byte lane remains available.

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

interface HistoryPage {
  entries: FeedEntrySummary[];
  beforeCursor: string | null;
  hasMore: boolean;
  fileGeneration: string;
  indexedThroughByte: number;
  byteRange: { start: number; end: number } | null;
  hiddenServiceCount: number;
  cacheable: boolean;
  edge: PageEdgeState;
}
```

The row limit and byte limit both apply. The server considers rows from newest to oldest and stops before adding a row that would exceed either limit. Service rows excluded by `showSvc` still advance the examined ordinal and contribute to `hiddenServiceCount`. If the first returned row alone exceeds 64 KiB, the server returns that one row and advances the cursor. This single-oversized-row exception prevents a permanently stuck cursor. Preview and summary caps should make the exception rare, while the contract remains safe if a new kind grows.

`hasMore` is derived from the existence of an older ordinal in the verified projection. A projection in `building` or `invalid` state cannot produce `hasMore: false`.

`cacheable` is true only when every returned entry is settled and both page edges are closed. The client stores cacheable pages in a bounded LRU keyed by `[fileGeneration, byteRange.start:byteRange.end]`. A tail page with an open call, pending duplicate, or active command run stays in current view state and is refetched after progress. Older closed pages are immutable under append.

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

Ordering uses `ordinal`, never timestamp. Timestamps can be absent, duplicated, or out of source order. A cursor names the next older ordinal after every row examined for the current page. With service rows included, this is immediately before the first returned entry. With service rows omitted, it can also cover skipped service ordinals.

The opaque token carries a version, a hash of the conversation scope, the normalizer version, the next older ordinal, the corresponding source coordinate, and a short digest of source bytes around that coordinate. It carries no path and no SQLite row id. The decoder limits token size, validates every integer, and rejects a scope mismatch.

Cursor behavior is:

- Append stability: existing ordinals and source coordinates stay fixed, so an older-page cursor remains valid while the file grows.
- Projection rebuild stability: a rebuild under the same normalizer deterministically recreates ordinals. The server rebinds the cursor to the new `file_generation` after the source-coordinate digest matches.
- Rewrite safety: truncation, replacement, or a changed byte digest returns `history_cursor_stale`. The caller starts from the newest page.
- Normalizer changes: a new normalizer version invalidates older tokens. A semantic rule change can alter entry counts, so automatic reinterpretation would risk gaps or duplicates.

The cursor is exclusive. If an unfiltered page contains ordinals 900 through 1,049, `beforeCursor` addresses ordinal 900 and the next query selects ordinals below 900. The server query always advances when `hasMore` is true.

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
| One source record emits several cards | Assign deterministic `source_part` values and consecutive ordinals. Every card keeps the same source range and a distinct `entry_id`. |
| A tool call and result fall in different pages | Index the call once at its original ordinal. The result updates that row by `item_id`, extends its source range, and settles it. Page edge state keeps the call open until this update exists. |
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

The history controller records the source byte watermark returned by the first page. The live parser keeps processing the existing byte stream. A small adapter attaches source spans and a reconciliation identity to live entries as chunks are decoded. This is an additive output detail; the subscription, reconnect offsets, LRU, cap, pause behavior, and SSE-to-poll fallback in `useLogTail` remain unchanged.

The merge rules are:

- A history row and live row with the same native `itemId` are twins. Tool groups compare every member call id. Rows without a native id use the projector's source-span identity.
- The first visible twin owns a presentation key. When its durable indexed twin arrives, the feed store replaces the item under that same key. React keeps the DOM node, disclosure state, and measured height.
- `anchorKey` becomes the durable `entry_id` after replacement. During that frame, the store retains an alias from the prior live anchor. The existing `viewportAnchor` lookup can restore either key, and the prepend height compensation at `src/components/LogFeed.tsx:412-420` keeps the reader's row at the same screen offset.
- Unified durable entries are passed to `publishCanonicalAssistantClaims`. Their response ids and tool-call ids already match the identities consumed by `visibleRuntimeLiveTurnItems`, so a runtime row yields as soon as its durable twin is visible.
- Unified user rows are passed once to `publishTranscriptEchoes`. The echo ledger rekeys a live anchor to the durable `entry_id` during replacement, preserving one occurrence. Repeated identical messages still retire outbox entries one at a time through the existing occurrence accounting.
- Runtime overlay and outbox rows keep their current tail order. History pages are inserted before that tail. A live item that becomes durable changes ownership in place and never appears in both sections.

The current `FeedSession` reset remains valid for a bounded live truncation or source replacement. Earlier-history navigation never moves its input window backward after this split, so loading a page cannot trigger the whole-history reset at `src/components/feed/parse.ts:2382-2394`.

## Rollout

The rollout order follows the originating priority exactly. Each phase has its own feature gate and can be disabled without changing JSONL.

### Phase 1: semantic history pages

- Add the locale-neutral projector, schema, incremental indexer, cursor codec, and `GET /api/history`.
- On initial open, request one newest page with `limit=150`; request no older raw chunks.
- Keep `useLogTail` subscribed through the existing live path.
- Add the `LogFeed` history controller and semantic-entry merge. “Show earlier” consumes `beforeCursor`.
- Treat rebuilding as an explicit temporary state. Continue showing the bounded live lane.

Exit proof: initial open returns at most one semantic page, page walking has no gaps or repeats, append catch-up reads only the suffix, and loading older history never calls `useLogTail.loadOlder()`.

### Phase 2: body on demand

- Replace any remaining inline page body with `preview`, `bodySize`, and `bodyRef`.
- Add the body route and expansion states.
- Keep raw source lookup for the bounded live lane until each live row receives its durable twin.

Exit proof: a collapsed large tool result contributes only bounded summary bytes to the page and browser heap; expansion reads its verified source range and returns the complete redacted body.

### Phase 3: incremental prepend and page cache

- Add the bounded LRU keyed by `[fileGeneration, byteRange]`.
- Persist and return page-edge state for tool pairing, command grouping, user and assistant representation joins, and turn continuity.
- Reconcile only the added page and its adjoining edge. Remove the old raw-history prepend call from `LogFeed`.

Exit proof: prepending a page performs work proportional to that page plus its two edge runs. A test spies on the parser and proves no previously settled page or live window is parsed again.

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
- stale-cursor rejection after truncation, replacement, earlier-byte rewrite, or normalizer-version change;
- byte-accurate indexing across UTF-8 and read-buffer splits;
- call and result pairing across a page edge;
- command grouping and Codex prose dedupe across a page edge;
- a pending user representation that completes on the next page;
- a turn larger than the row and byte budgets;
- row and byte limits together, including the single-oversized-row progress case;
- index corruption producing a rebuilding response while the JSONL source remains intact;
- one live row replaced by one durable twin with the same DOM presentation key;
- stable viewport offset during prepend and live-to-durable replacement;
- one outbox retirement for one echo before and after replacement;
- runtime prose and tool overlays yielding to matching durable identities;
- compact panes mounting only their bounded latest turn set;
- a search hit opening the semantic page that contains its ordinal.

Instrumentation should report source bytes read, records parsed, inserted rows, updated rows, page rows, serialized page bytes, rebuild reason, and whether a page came from cache. These are diagnostic counters. They do not become authority for transcript completeness.

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
