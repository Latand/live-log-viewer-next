# Acceptance contract

These are required production-build gates. Prior prototype counts are supporting historical evidence. This research stage executes its extraction tests and privacy scan only.

## Workflow fidelity

- One synthetic task spans an initial failed launch, quota-stopped attempt, successor pipeline, two substantive reviews, targeted acceptance and merged PR. All attempts remain reachable and labelled accurately.
- A planned stage with no attempt, an attempt with launchId but no conversation, an unresolved task relation, a shared reviewer, a done task and an unavailable historical transcript each have a useful detail state.
- Publication failure coexists with builder pass. A review quota stop leaves its measured findings visible without a pass verdict. Accepted deployment remains pending until authoritative terminal success; a failed attempt retains its failure even if health endpoints return 200.
- A deployment batch links all proven PR/task members by exact revision ancestry. A later deployment is a new attempt. A guessed title match never becomes membership.
- The total worker count equals the number reachable from task history plus explicitly unlinked/shared references. Open the last worker in each task at 24, 100 and 1,000 conversations. Exercise older attempts as well as current workers.

## Geometry and controls

Run light/dark at widths 1280, 1440 and 1920; original and dense multi-task scenes; every reader expanded; 7%, 21.9%, 22%, 22.1%, 40%, 52%, 58%, 71.9%, 72%, 72.1%, 81.9%, 82%, 82.1%, 100% and fit-derived zoom. Include threshold-adjacent values from the implementation when thresholds change.

Capture real DOM rectangles after settling and during expansion/zoom transitions. Require each displayed child inside its group with heading/padding; independent groups and their controls clear each other; edge tips within 1 CSS px of their displayed target boundary; edge routes avoid unrelated cards. Test clipped endpoints and continuation labels. Record any infeasible legacy pin conflict explicitly; it cannot pass ordinary non-overlap.

Drag at 7% as well as detail scale. Compare desired legal drop, persisted world coordinate, displayed centre and readback. Repeat across zoom, pan, collapse, expansion, Return, project switch and reload. Verify failed persistence restores previous state without a false success toast. Test two existing pins that make expansion impossible and the full-window fallback.

Preserve click/Enter parity, keyboard navigation and focus, native full-window controls, root jump, Return camera, composer draft and selection, scroll anchor/follow state, unseen arrivals and stable single reader ownership. Visually inspect screenshots; do not use OCR.

## Dormancy and delivery

Warm at least three real native readers before hiding them. Use 24/100/1,000-conversation multi-task fixtures, including long/rich summaries and many tasks (the old larger fixtures retained only six tasks). Pan 20 times, ingest 100 incoming messages, and idle 21 seconds. Include ordinary hidden panes, hidden rich summaries, collapsed groups and full-window siblings. Reset counters after the eligibility transition and settling so setup is recorded separately.

Count entry into every hidden wrapper, native owner, pane, header, feed and summary; source parsing/JSON.parse; view-local subscription callbacks; timer callbacks; DOM mutations. All hidden-conversation UI deltas must be zero. Also record selector invocations to detect broad runtime-store notification work hidden by equality checks. Cheap board geometry queries and the central durable store ingestion have separate counters; their cost must not conceal per-conversation UI work. Record before/after pan timing and work counts at each scale, with method and machine context stored privately. Do not invent a latency threshold absent a measured baseline.

Prove the red path: retained prior artifact must reproduce 480/2,000/20,000 hidden wrapper entries over 20 pans and offscreen summary parsing. Instrument the outer wrapper independently of builder probes. The 7% pin test must fail on the retained prior layout. Reproduce on a read-only copy or instrumented in-memory build, preserving original files.

Use actual production useLogTail/logBus, runtime selector/receipt hooks and TmuxComposer/outbox modules in isolated integration fixtures. While hidden, allow accepted, unknown and terminal receipt transitions into the durable owner; require no hidden view updates. On reentry, reconcile once, preserve the original operation key and show one message. Cover restart/remount, a stale late response, unknown recovery, retained draft selection and a scrolled-away anchor. No transport resubmission or unresolved outbox eviction may be caused by visibility. Synthetic network responses alone do not prove this ownership path; trace the production callsites and record the executed modules.

## Isolation and release evidence

Use a new private test root with HOME, XDG_CONFIG_HOME, LLV_STATE_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR and a short TMPDIR. Run touched test files by path; never broad lifecycle suites against operator state. Preserve all old worktrees. Do not reset, clean, remove, restart or deploy from this stage.

The board builder records exact HEAD/base, focused test commands/results, TypeScript, whole-diff privacy including untracked outputs and required hosted checks. Independent review must assess that exact head. Root performs the authorized deployment and continuity checks later. Prototype success, local production-component success, hosted checks and deployed behaviour remain separate evidence levels.

## Research extraction usage

`extract.mjs` exports `extract(call, plan)`. Supply the existing authenticated Viewer MCP adapter:

```js
const result = await extract(
  (name, args) => tools['mcp__viewer__' + name](args),
  {
    runId: 'unique-research-run',
    project: 'canonical-project-key',
    queries: ['stage addition', 'successor pipeline', 'publication failure'],
    pageLimit: 80, maxPages: 4, maxChars: 6000, maxCalls: 40,
    windows: [{
      label: 'explicitly selected case',
      conversationId: 'conversation_selected',
      since: '2026-01-01T00:00:00Z', until: '2026-01-01T01:00:00Z'
    }],
    redactLiterals: [],
    readbacks: []
  }
);
```

Import the module in a local MCP client, or load this trusted module's text into the JavaScript tool environment. Never evaluate transcript text. `call` is a caller-supplied transport; the module does not launch another agent or MCP server. It allowlists five read tools, gives each page a fresh request key, keeps cursors unchanged and records partial coverage. `until` is a client filter because Viewer exposes only `since`; a long conversation may require more newest-first pages. Resume with the returned nextCursor and identical identity/since/kinds/roles. Refusal and repeated cursors fail explicitly. An empty bounded window is never proof that no event happened.

The returned corpus is privateOnly and publicationReady=false. Save it outside every Git checkout with directory mode 0700 and file mode 0600. It redacts common paths, emails, credentials and caller-supplied identity literals; this is a first privacy pass, not a claim that arbitrary prose is anonymous. Manually curate public cases into invented fixtures. The script never reads raw transcript files, performs lifecycle actions or publishes data.

Normalized tool_call records can contain completed tool output. Preserve kind, name, timestamp and seq, then label request and returned result by inspecting content. A nested transcript read is secondary evidence. Duplicate wrappers are not independent confirmations. Truncated records remain explicitly marked and cannot prove absent fields.
