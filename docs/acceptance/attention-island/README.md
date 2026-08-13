# Attention island (#963) — visual evidence

Captured by `scripts/capture-issue-963-attention.ts` against a **production
build** (`next start`) on a dev port, with `HOME`/`XDG_CONFIG_HOME`/
`LLV_STATE_DIR`/`TMPDIR` pointed at a synthetic home under `/tmp` — never the
operator's live state, and no host paths anywhere in the frames. Attention
items are real pending questions: each fixture transcript tails an unanswered
`AskUserQuestion` and a live holder process keeps it open for writing, so the
production `pendingQuestion` pipeline (fd scan → pid attribution → question
tail) lights up with nothing stubbed.

Per this repository's publication policy (synthetic-and-redacted-media-only),
the committed record is `privacy-manifest.json`: deterministic redacted
placeholders from `scripts/generate-privacy-placeholders.ts`, each recording
the SHA-256 of the live capture it stands in for. To reproduce the real
captures locally, run:

```
bun run build
bun scripts/capture-issue-963-attention.ts
```

The run prints its resolved absolute `screenshots:` directory. The stable
`<system-temp>/llv-issue-963-latest/out` link resolves to the newest run; when
`ATTENTION_CAPTURE_DIR` selects an accepted parent, that parent contains the
same `llv-issue-963-latest/out` link.

| Capture | What it showed |
| --- | --- |
| `963-desktop-zero.png` | The overview with an empty queue: a muted, inert `NEEDS YOU 0` pill below the header row — present, quiet, no pulse, and clear of the Orchestrator button. |
| `963-desktop-one.png` | One pending question: the island turns warning-toned as `NEEDS YOU 1 \| Next \| filter`, with the arrival toast docked beneath it. |
| `963-desktop-many.png` | Four items across three projects: `NEEDS YOU 4` — the island's count is exactly the queue's count. |
| `963-desktop-queue-open.png` | The count opened the existing queue popover: four rows with question snippets, project chips and wait ages, oldest first. |
| `963-desktop-filter.png` | The island's filter toggled «show only needs me»: the two blocked atlas cards keep full contrast while the other six dim; the toggle renders pressed. Bottom-right, the project board's corner switchboard pill keeps its own `· 2 waiting` counter — a broader count that also carries finished turns and flow-level attention the queue never holds (restored per the #963 review). |
| `963-desktop-next-landing.png` | Clicking Next at 64% zoom glided the board camera to the off-viewport blocked card and framed it with the focus ring. |
| `963-desktop-cross-project.png` | The third Next crossed projects: orbit selected in the rail, its blocked conversation focused — the same hand-off a queue-popover jump uses. |
| `963-mobile-zero.png` | 390 px: the quiet zero count in the board header row. |
| `963-mobile-many.png` | 390 px: the compact `⚠ 4 \| ›` count-and-Next arrangement, both segments at the 44 px tap height; the filter stays desktop-only. |
| `963-mobile-queue-sheet.png` | 390 px: the count opened the queue as a full-width sheet under the header. |

The capture drives the real Viewer through the real API: the states progress
by writing more question transcripts into the polled home mid-run (a pinned
`/api/files?path=` request forces the scan, exactly as a deep link does), and
the cross-project landing is asserted from the resulting `#f=` hash before the
frame is kept.
