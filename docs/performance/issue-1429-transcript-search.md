# Issue #1429 global message search profile

Date: 2026-09-02
Runtime: Bun 1.4.0, SQLite 3.53.2, 16-core Linux host
Corpus: synthetic, `scripts/transcript-search-fixture.ts` (seed 1429): 6,729
conversations / 250,000 indexed messages, 20% of rows replayed duplicates
Production that day (read-only reference): 7,253 conversations / 249,812 messages

The issue's first server-side measurement (30–160 ms) was taken on queries with
a few hundred matches. Measured on words the operator actually types, the route
itself was the cost: 0.5–4 s on the production instance for a word present in
45% of the messages, and every one of those seconds stalled every other request
the Viewer was serving.

## Method

`scripts/transcript-search-bench.ts` indexes the synthetic corpus into a scratch
`LLV_STATE_DIR` and measures the same three queries on every surface:

- **library** — `searchTranscripts` in-process (the SQLite work alone);
- **route** — the exported route handler called in-process (plus title lookup
  and JSON serialisation);
- **http** — the same handler behind a loopback `Bun.serve`, fetched;
- **mcp** — the packaged stdio server (`bin/mcp-server.mjs`, the release bundle
  under Bun) pointed at that loopback Viewer, driven through the MCP SDK client
  (receipts, control HTTP, redaction, result serialisation on top of http);
- **ui** — the real palette (`GlobalSearch`) in happy-dom with `fetch` routed
  to the loopback Viewer, from the last keystroke to the first rendered result
  row, debounce included. *fast* types with 120 ms between keys so only the
  final query is requested; *slow* leaves 300 ms after every key so each pause
  fires its own request.

Queries: `heliotrope` (rare, 3 hits), `harbor granite` (two common words, 18k
matches), `ledger` (one very common word, 89k matches, 45% of the corpus).
Medians of five runs. The production numbers below were taken read-only against
the live index and the live route; no production content was copied anywhere.

## Baseline: where the time went

| surface | rare word | two common words | very common word |
| --- | --- | --- | --- |
| library, own messages | 13 ms | 125 ms | 446 ms |
| library, all speakers | 12 ms | 277 ms | 1 369 ms |
| http, own messages | 13 ms | 124 ms | 430 ms |
| http, all speakers | 13 ms | 275 ms | 1 384 ms |
| mcp (always all speakers) | 14 ms | 277 ms | 1 339 ms |
| ui fast, own messages | 267 ms | 382 ms | 752 ms |
| ui fast, all speakers | 267 ms | 531 ms | 1 630 ms |
| ui slow, all speakers | 267 ms (10 req) | 544 ms (14 req) | 1 723 ms (6 req) |

Reading down a column:

- **The SQLite statements are the cost.** http ≈ route ≈ library on every
  query; transport and serialisation add 0–15 ms.
- **The MCP round trip adds ~1 ms** over http: the receipt claim and completion
  (two `synchronous=FULL` transactions), `redactPayload` over the snippets and
  the three JSON serialisations are invisible next to the query. Suspect 2 of
  the issue is cleared.
- **The palette adds the 250 ms debounce and a few ms of render.** ui-fast −
  http − 250 is 4–15 ms on every row. Suspect 1's render cost is cleared; its
  debounce is the whole answer for a rare word (267 ms, of which 13 ms is the
  search).
- **Every query paid a fixed ~12 ms** before doing anything: the corpus
  statistics ran `COUNT(*)` over the 250k-row message table.

The per-key pauses of *slow* typing fired 6–14 requests per run without
changing the time to the final answer here, because a prefix of a word matches
no token. What they did do is documented next.

### Statement-level split on the production index (read-only)

Very common word, all speakers, ~113k matched rows, one warm handle:

| statement | ms |
| --- | --- |
| corpus stats (`COUNT(*)` over messages) | 12 |
| `COUNT(*)` of the collapsed groups (join files, `GROUP BY speaker, body_hash`) | 358 |
| page query (window functions over the join, second FTS scan for `snippet`, sort) | 1 311 |
| — of which: FTS5 scan alone | 24 |
| — of which: FTS5 scan with `bm25` | ~140 |
| — of which: join to `transcript_files` by path, per matched row | ~5 µs × 113k ≈ 560 |
| one `rowid = ? AND MATCH` seek (what per-row `snippet` lookups would cost) | 14 each |

The `transcript_files` join by its text primary key, paid once in the count and
once in the page query, was the largest single term. Bigger page caches and
`mmap_size` changed nothing (±5%): the cost is CPU in joins and sorts, not I/O.
Chunking the FTS scan by rowid ranges to yield between chunks costs 4× (every
chunk re-seeks the doclists).

### The stall nobody had measured

`searchTranscripts` runs synchronously inside the route handler, on the
Viewer's only thread. On the production instance, with a very-common-word
search in progress:

| request | alone | during the search |
| --- | --- | --- |
| rare-word search | 17 ms | 1 471 ms |
| `/api/files?limit=1` | 130 ms | 1 532 ms |

A request the palette aborted on the next keystroke was still computed in full
there, and every later request queued behind it. This is what made the search
feel slower than any single number above: the answer to the final query waited
behind the abandoned ones, and the board's own polls waited with it.

## After

| surface | rare word | two common words | very common word |
| --- | --- | --- | --- |
| library, own messages | 2 ms | 64 ms | 176 ms |
| library, all speakers | 2 ms | 98 ms | 346 ms |
| http, own messages | 2 ms | 63 ms | 169 ms |
| http, all speakers | 2 ms | 100 ms | 353 ms |
| mcp (always all speakers) | 4 ms | 99 ms | 328 ms |
| ui fast, own messages | 257 ms | 319 ms | 453 ms |
| ui fast, all speakers | 256 ms | 358 ms | 632 ms |
| ui slow, all speakers | 256 ms (10 req) | 377 ms (13 req) | 612 ms (6 req) |

On the production index (read-only, same pages compared byte for byte with the
previous SQL): `the`, all speakers, 1.5–2.1 s → 0.42–0.52 s; `the`, own
messages, 0.6–2.8 s → 0.23–0.26 s; `the file`, own messages, 0.4–5 s →
0.18–0.45 s; a 5k-match word 0.12–0.37 s → 0.05 s.

## Mechanism

1. **One match scan, ranking in memory** (`src/lib/search/transcriptSearch.ts`).
   The scan reads six columns per matched row (id, bm25, speaker, body hash,
   timestamp, transcript path) and never joins `transcript_files`; the files a
   page can name are read once (keyed lookups up to 512 distinct transcripts,
   one pass over the table beyond that). Duplicate collapsing, the total and the
   page order are computed in memory in exactly the order the SQL used: bm25,
   then newest transcript mtime, newest message timestamp, highest id. Snippets
   are cut for the page's rows only, by one filtered match scan (`+rowid IN`)
   rather than per-row seeks. The whole search runs inside one read transaction
   so the passes share a snapshot while the indexer commits. A differential test
   pins every row, order, snippet, duplicate count and total against the SQL it
   replaced on a seeded corpus dense in ties and cross-file duplicates.
2. **Corpus statistics from `transcript_files`.** `SUM(messages_count)` is
   committed with each transcript's rows and equals the message count, without
   the 250k-row walk.
3. **One first-page request in flight, latest question wins**
   (`src/components/search/useTranscriptSearch.ts`). The palette no longer
   aborts the in-flight request on a refinement — the server would have
   finished it anyway — and every refinement typed meanwhile collapses into the
   one request that follows. The answer that arrives holds on screen as the
   stale rows the design already shows. Pinned by request counts on gated
   fetches, including the StrictMode rehearsal unmount.

Result ordering and snippet shape are unchanged; the issue's suspect 3 (a
query during a re-index) is unchanged too: WAL readers never wait on the
writer, and the existing test for a search during a rebuild still holds.

## Not fixed here

The search still holds the Viewer's only thread for 170–350 ms on a
very-common-word query, and every agent now runs several searches at the start
of each task (#1428). Moving the search into a worker, and measuring an FTS5
`optimize`/`merge` after complete index passes, is filed as #1438 with the
numbers above.

## Reproduce

```
bun scripts/transcript-search-fixture.ts /tmp/llv-search-corpus
LLV_STATE_DIR=/tmp/llv-search-state bun scripts/transcript-search-bench.ts /tmp/llv-search-corpus --repeat 5
```

The first command writes ~410 MB of invented transcripts; the second indexes
them (~25 s) and prints the table. `--skip-mcp` needs no bundle; the MCP
surface needs `bun scripts/build-mcp.ts` first.
