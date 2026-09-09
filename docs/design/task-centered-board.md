Originating requirement — operator, 2026-09-09 04:44:31.686 UTC, original Russian message in the operator's orchestrator conversation. The private source and attached image are pinned in this stage's assignment. Transport markup and the image's private filesystem location are omitted; the message itself is verbatim.

> Я бы хотел немножко небольшую визуализацию поменять доски. Значит, принцип реального: я хочу, как это, чтобы работало. Чтобы у нас была какая-то вертикальная, точнее нет, не вертикальная, наоборот, горизонтальная область. Ну, которая при этом может быть широкая, может быть в несколько рядов, но эта область у нас выделяется под одну задачу. У нас на доске не должно существовать агентов, которые не выполняют какую-то задачу. Всегда должна быть привязана задача. Э-э, этой задачей, в принципе, может стоять что-то из первого промпта, но, скажем так, когда создаётся агент, пусть давай ему в промпт, когда вот мы ему инжектим промпт вьюера, нужно сделать так, чтобы туда ещё инжектилось так, что, ну, вот при первом вызове он сейчас один раз обязан вызвать изменение, ну, создание таска и привязку себя к таску. То есть и в таске он должен написать грамотно, человеческим языком, там, не сильно раздувая, что за задача. Проблемой может быть, когда у нас один агент делает несколько тасков. Как их визуализировать на доске, я не совсем представляю. Но. Возможно, дублировать. Возможно, дублировать, но идея в том, что даже вот по таску это должно быть как-то так сделано, чтобы было. Короче, пусть, может быть, дублирует. Но обязательно под каждый таск у нас отдельная линия, и если я делаю, ну, убираю масштаб выше. То тогда эта линия... ну, типа, становится более красивой, это нужно на скриншотах тоже проверить. Вот. Чтобы. На разных масштабах оно смотрелось нормально и недалеко уезжало, потому что сейчас, когда я меняю масштаб, то почему-то мой разговор, на который я смотрю, он сильно уезжает. И также я хочу, чтобы вот разговоры каким-то образом между собой были связаны в одной задаче, чтобы было понятно переход между какого к каким. Вот. И я, например, хочу иметь там справа... наверное. От агентов, или как-то, короче, иметь кнопочку, скажем так, вот эта кнопочка плюс агент, она, наверное, должна быть или вне тасков вообще, то есть тогда, например, я выше там в. Верху первый ряд, я там могу создать как бы новый агент, и создаётся новая дефолтная, какая-то там untitled task, потом агент создаёт, даёт ему имя, когда, ну, в процессе своей работы. То есть первым действием он может менять потом это имя, если хочет. Вот. Но суть в том, что вот начинается. Потом, например, если я добавляю нового агента, он просто как бы добавляется с правой стороны, например, от моего агента. Те таски, над которыми хоть один агент работает, они должны быть выше. Других там, где агенты не работают, там таски должны быть ниже. То есть таким образом мы будем видеть прогрессирование задач, то есть чем больше идёт работы, тем больше агентов параллельно работают, тем выше они стоят, тем выше таска стоит. Вот. Вот это всё нужно задизайнить. Я бы, наверное, хотел попробовать связку фейбла и астра. Фейбл очень классно именно вот он именно вот пишет код, скажем так, красивый. А астра очень умная, поэтому мне бы как-то хотелось их вместе поедина, ну, объединить, чтобы получился хороший результат. Вот. Подумай, как это лучше сделать. И отправь такую задачу.

# Task-centered board

Issue: https://github.com/Latand/live-log-viewer-next/issues/1586

Design owner: Astra. Implementation owner: Fable, two serial slices. Independent review owner: Astra, against the originating requirement and each exact candidate head. Root owns scheduling, integration and release. This document completes the design stage; implementation and browser acceptance remain future work.

## Decision and scope

Give every admitted conversation at least one canonical BoardTask. Display each task as one full-width horizontal band; wrap its conversations into additional rows inside that band. Sort bands by the number of distinct, authoritatively working linked conversations. Preserve the selected conversation's screen anchor through semantic zoom, activity ordering and wrapping.

Reuse the current task store, assignments, pipeline taskIds, flow review records, conversation identity resolution, native reader/composer owner and camera. Build a task-band projection over those records. A projection may repeat a conversation's representation in several bands; the conversation, execution, delivery and selection remain shared.

The September 9 request governs visual decisions. Earlier documents establish reusable mechanics and regression cases. Their multi-column task overview, free-floating containers and pipeline-first hierarchy do not define this design. No ADR is needed: this retains the existing canonical task identity and makes reversible layout changes. Automation unification remains under #1446.

This stage writes only this document and publishes the issue. No product source, live state, runtime, branch, service or unrelated worktree is changed.

## Evidence checked

Checkout HEAD, origin/main and the remote main ref all resolved to `656e4a3b420dfddb2c8a7ea4641d33ab9cc8570b` during this design. The checkout started clean. Source paths below refer to that revision.

The supplied screenshot was loaded directly into vision, without OCR. It shows a large left conversation panel, a light dotted canvas, a 21% zoom readout, small native conversation previews within widely separated tinted containers, truncated container labels, long connecting lines and a dense minimap. This single frame supports a readability/layout concern. It cannot prove the movement seen during a zoom gesture, runtime state, or delivery outcome.

Prior-work searches used project-scoped “task board”, “anchor zoom” and “REVISION3”, then unscoped “placeholder task” and “screen anchor”. The human project-name filter returned nothing; a hit supplied the canonical project key. Follow-up searches with that key found the revision report and task-identity history. Relevant transcripts were opened through conversation_messages at their returned transcript paths:

| Prior record | What was recovered | Current-main check / consequence |
| --- | --- | --- |
| Prototype builder, September 8 00:44 UTC, `docs/design/board-astra-fresh/REVISION3.md` in the preserved predecessor worktree | Child-derived bounds, displayed arrow ports, retained native reader, synthetic delivery, overview aggregation | Read the report. Retain geometry principles; the old task-grid appearance is superseded. Prototype numbers are attributed to that historical report. |
| Independent prototype verifier, September 8 00:46–00:51 UTC | Hidden NativeSlot executions, offscreen summary parsing, overview drag that persisted a pin without moving it | These findings qualify the builder's completion claim. Current production integration explicitly addresses them. Keep negative controls in the regression set. |
| Production integration builder, September 8 05:26 UTC | Its early PR #1564 checkpoint was incomplete | Read the current merged PR and `docs/design/task-board-integration/README.md`: later work completed production geometry, dormancy and navigation. The early transcript is superseded on those points. PR #1564 merged as `c2007627f8afc941b72981c32eaf24bdb34cf53d`; the relevant modules exist on current main. |
| Task-spawn identity worker, July 16 08:40 UTC, PR #316 | Launch-key assignment deduplication and pathless attribution | Current TaskAssignment carries launchId, clientAttemptId, conversationId and nullable path; mergeAssignments reconciles existing identities. Reuse this seam. |

Duplicate search covered open/all board issues, task/spawn issues, “task-centered”, “horizontal band”, and open PRs. #1453 covers the broader desktop redesign; #183 covers a project/flow zoom hierarchy; #1546 covers populated-board latency; #277 covers a discarded spawn request field. None specifies this September 9 admission-plus-horizontal-band contract. Create one focused issue, cross-link those items, and avoid duplicating their general roadmaps.

### Source-backed gaps and retained mechanisms

| Current source | Observed behavior | Design delta |
| --- | --- | --- |
| `src/lib/tasks/types.ts`, `store.ts`, `commands.ts` | BoardTask text uses its first line as title; assignments retain durable IDs. mutateTasksFile serializes a task-file update. Recent create receipts are bounded; createTask refuses at 300 project tasks. | Add an idempotent mandatory membership command to this store. Its identity must outlive the bounded create-receipt cache. Account for legacy imports beyond 300. |
| `src/lib/agent/spawnCommand.ts`, `src/lib/runtime/structuredSpawn.ts` | General launches reserve durable launch receipts and later actuate; generic spawn does not establish a BoardTask. | Require committed membership before first execution; replay paths recheck the same binding. |
| `src/app/api/tasks/[id]/spawn/route.ts` | Dedicated task spawn persists an assignment before execution, supports retry identity and pipeline binding. | Reuse its identity/assignment rules without forcing all native manual launches through its task-managed pipeline behavior. |
| `src/lib/pipelines/taskBinding.ts`, `engine.ts` | Pipeline taskIds and task-driven single-stage pipeline adoption already exist. | Preserve the distinction between task membership and pipeline execution. Add fallback task binding only where absent. |
| `src/components/tasks/taskWorkflowModel.ts` | Projects explicit task links, assignments, attempts, review rounds and unlinked work. Shared conversation resolution exists. Some execution associations derive from matching a worker assignment. | Keep relation provenance; a derived execution association must not promote every stage to canonical membership. Admission and explicit links establish that. |
| `src/components/scheme/taskBoardLayout.ts` | Task groups are ordered by task ID; a claimed set assigns one canonical surface to shared workers. Below .22, tasks occupy overview columns. | Replace that placement policy with stacked bands and projection keys. |
| `src/components/scheme/SchemeBoard.tsx` | Layout depends on placed tasks; legacy/manual items can remain outside task groups. | Include every admitted task member regardless of legacy free-map placement; retain unplaced empty tasks in the task list. |
| `NativeConversationPane.tsx`, `conversation/DormantView.tsx` | Retained portal, before-mutation scroll/selection capture, separate composer lifetime and hidden presentation suspension. | Reuse one owner per conversation across projections and full-window mode. |
| `useSchemeCamera.ts` | Follow reflow compensation and explicit framing primitives exist; clamping and center framing can alter position. | One anchor transaction must cover zoom plus final band layout before paint. |
| `src/lib/types.ts`, `scanner/activity.ts` | authoritativeTurn is distinct from activity recency and OS process existence. | Ranking uses confirmed current working evidence; timestamps and process existence alone never increase running count. |

## Canonical admission and refinement

### Durable contract

Introduce one internal command, conceptually `ensureTaskMembership(admission)`, under `src/lib/tasks/`. It accepts a trusted admission identity, canonical project, conversation/launch identity and optional explicit task IDs. It returns committed task IDs and assignment references. HTTP, MCP, task spawn, pipeline/flow launch and import adapters call this implementation; each keeps its existing authority checks.

Persist a small optional admission-origin field on BoardTask, including a unique membership key and refinement state. For a newly created independent conversation use its durable conversation ID; for a pipeline or standalone review flow without a task use that container's durable identity. The key is internal and never a human-facing title. Store task, assignment and origin key in the same mutateTasksFile transaction. Do not use the evictable recentCreates list as the sole deduplication proof.

For an explicit task, add/upsert the assignment in that same transaction. A launch may have several explicit tasks; validate all targets before writing any. A retry of the same request must resolve exactly the same target set. Membership is descriptive and grants no runtime-control authority. Before creating a fallback, search committed canonical conversation assignments as well as the origin key. A deleted explicit target makes its old request unavailable; replay must never resurrect it. If deletion replaces the last membership with a placeholder, carry its fallback-origin key into the replacement in that transaction so old independent-launch replays converge to the surviving membership.

For a fallback pipeline task, reconcile the container's existing taskIds to the committed task before stage actuation. Use the existing pipeline mutation/recovery protocol after releasing the task-file lock; avoid nesting independent store locks. A crash between the two writes reuses the task's container-origin key and repairs that same link before execution. Standalone flows use their existing recorded implementer/reviewer identities to resolve the committed task membership; this does not require a new flow engine.

Task text continues to hold the title and description: a short first line (target 3–10 words, maximum 80 characters for newly refined titles), then up to two concise sentences. Existing longer text remains intact and opens in details. Default copy is “Untitled task”; description can remain empty. Avoid filling the title with a long raw prompt, credentials, account labels or path names.

Add a truthful assignment state `linked` for imported/existing conversations attached without a spawn or send. Update exhaustive consumers and validation. Do not label such an association delivered or invent a handoff. Existing spawning/failed/delivered/handoff records retain their meaning and provenance.

### Admission sequence and crash points

1. Validate the launch and caller as today. Reserve/recover the existing durable launch/conversation identity, without starting a process or dispatching the prompt.
2. Resolve explicit membership. General global +Agent has no target and obtains one new placeholder task; task-local +Agent supplies its task; a pipeline/flow inherits only recorded task membership. Otherwise it gets one fallback task for its container.
3. Under the task-file lock, find or create the fallback task, upsert the launch/conversation assignment, and commit together. Publish the task revision only after commit.
4. Proceed with the existing spawn actuation and receipt protocol. Every recovery path capable of first actuation checks the committed binding before acting. A receipt reserved before a crash is not sufficient.
5. Resolve a later transcript path onto the same assignment. Resume/successor generations retain canonical conversation membership; explicit new launches retain their own historical launch references.

The task commit and runtime actuation span existing stores. This is an ordered, recoverable admission protocol; no cross-file atomic transaction is claimed. The atomic guarantee is that task creation and binding become visible together, and Viewer-owned execution cannot begin before that commit. Externally started native agents are bound at their first Viewer board admission; the Viewer cannot retroactively gate their earlier execution.

The implementation must audit the low-level `/api/runtime/spawn` → `src/lib/runtime/http.ts` path as well as normal spawn adapters. A transport-only admission may reserve a runtime operation, but it must not become an alternate executable, unbound conversation. Enforce the same committed-membership prerequisite at the last shared first-actuation seam; cover direct transport calls and receipt recovery in isolated tests. This adds a membership check to existing admission, without changing send/receipt recovery semantics.

If the task store is busy, malformed or unavailable, refuse/defer first actuation through the existing admission outcome. Keep the launch identity and original payload for recovery. A failure after commit leaves a visible failed/pending slot inside its task. Do not delete the task or mint another on a lost response. Automatic recovery must follow existing authoritative not-executed/replay rules; uncertain execution remains uncertain. A deliberate retry after confirmed failure uses a new launch ID inside the same task.

Mandatory fallback creation must not fail merely because the project already has 300 tasks. Preserve the existing user-created task limit as a separate admission policy, but exempt required memberships through the trusted internal command. Do not expose that exemption as a caller-controlled flag. Render/project these tasks with bounded visible work; neither deleting history nor merging unrelated imported conversations into a fake task is an acceptable capacity workaround. Exercise at least 1,000 imported conversations and more than 300 fallback tasks.

### Agent's first Viewer action

Prepare a trusted task bootstrap block alongside the existing initial agent/role prompt, after membership commits. It identifies the assigned task(s) and tells the agent: “Your task is already linked. On your first Viewer action, refine its short human title and description from your assignment. Preserve an existing meaningful title and scope. Reuse the supplied request key on retry.”

Use the existing update_task surface with a narrow admitted-refinement intent. It checks server-derived caller identity against committed membership, validates text and expected revision, and applies at most one automatic refinement per admission origin. The placeholder-origin marker and revision check prevent two agents racing to rename a shared task. Replaying the same key/text returns the prior result; a reused key with different content conflicts. An operator edit or prior meaningful title wins; return “already named” without overwriting it. Later intentional task editing uses the ordinary authorized edit path.

This is a prompted first action, with server-enforced idempotency; it is not a new tool-call scheduler. The agent may have no Viewer tools, fail before calling, or ignore the prompt. In all those cases the committed placeholder remains valid and human-editable. Surface “Name pending” in task details, without blocking useful execution or issuing repeated paid model calls. Tool-less runs retain their original grants. Do not expand launch/control permissions to make metadata refinement possible.

Inject once into a fresh admission. Do not rewrite already-queued user text, receipt digests, resumed messages or image payloads. The first prompt's effective digest must include the prepared bootstrap under the existing launch protocol.

### Native/manual and imported conversations

Preserve the existing manual launch form, engine/model/account choices, prompt, images and native runtime path. Global +Agent opens that form and creates the placeholder only on accepted launch admission. Cancel leaves the draft and creates no durable empty task. Task-local +Agent opens the same form with task context and appends a reserved slot after the last current member, wrapping if necessary.

A task association alone never creates a pipeline. Keep current task-managed pipeline behavior where explicitly invoked. Native engine children are still discoverable; a recorded task context may be inherited, but parentage alone does not silently assign an unrelated child to every task of its parent.

Import/legacy handling occurs in the existing controlled reconciliation/admission write path, never as a side effect of a read-only board GET. Before a discovered conversation is admitted to the task board, use existing explicit assignments/container membership if present; otherwise atomically create and bind a placeholder using its canonical conversation identity. Use normal identity materialization first for legacy paths without a durable ID. Preserve paths and provenance, all old assignments, pins, archive state, attempt history and attachments.

A partial scanner page cannot prove absence of membership. Reconcile against complete authoritative membership indexes; incomplete or unreadable input preserves the last committed bands. Process legacy membership in bounded batches through the existing reconciliation runner, with task-file transactions containing only synchronous metadata work. Resume by existing membership/origin keys; do not run a full historical import inside a spawn request or increase its deadline. Show a visible “Task links unavailable”/“Import pending” count with retry details for records whose admission is unresolved. Such records remain reachable in the existing history/recovery surface; do not display a fabricated task or silently drop their existence. No free-floating agent node is admitted to the new board until its binding is committed. This limitation is explicitly visible during a failed migration.

Removing the last membership from a non-archived board conversation must atomically create/bind a new placeholder, or fail without changing the old binding. Deleting a populated task uses the same rule and existing deletion capability checks. Archiving a conversation keeps its task/identity/history and remains reversible. Task status “done” never authorizes destroying its members.

## Visual specification

Use the existing Viewer typography, icons and semantic theme tokens. This is a compact operational workspace: strong task titles, quiet dividers, readable status text and restrained selection accents. The skill catalogue's generic landing-page/dark-only suggestion was rejected as unrelated to this workspace. Support the existing light and dark themes.

The persistent project frame, search, orchestrator panel, attention entry and native controls remain. Place global +Agent in the top board action row beside existing task/pipeline creation. Every task band has a task title and state header, a member area, and its own +Agent affordance. Task IDs, launch IDs and transport details belong in details.

### Band geometry

All measurements are CSS pixels in the available board viewport, after subtracting side rails, open orchestrator panel and fixed chrome.

- Outer horizontal gutter: 24 desktop, 16 below 1,024 available pixels. Band gap: 16; header height: at least 48, growing for a two-line title. Use a 1px divider/boundary and a subtle surface tone, with at most 6px corner radius.
- One task consumes the full available row width. Bands never sit side by side at any zoom. Heights derive from displayed member footprints; the next band starts after the complete envelope, including connectors and expanded content.
- Intermediate member tile: 288px wide minimum, 148px high minimum, 24px horizontal gap and 32px row gap. Columns = max(1, floor((usable width + 24) / (288 + 24))). Tiles can grow evenly within a row up to 360px; unused final-row space stays empty.
- Near mode: keep summaries for unselected siblings; the selected reader uses the existing native pane with a preferred width of 600px, clamped to available width. Minimum useful reader width is 320px. Expand its row height to the real reader footprint. Wrap siblings to the following row when the reader does not fit. Opening a reader cannot cover another band.
- The local +Agent sits immediately to the right of the last member, with a 44px target. If the last row has insufficient room, place it at the next row's left edge. The band header also exposes the same action while deeply panned into a dense band; both route to one launch action.
- Task state, confirmed running count, unknown count and “also in N tasks” are separate text labels. Use green/amber/red only with text or an icon. A completed task with a working member visibly says “Done · 1 working”; it is ranked active until its real activity ends.

### Semantic zoom

Keep the existing continuous scale range and controls. Proposed bands: overview below 22%, intermediate 22–81%, near at 82% and above. Use a 2 percentage-point hysteresis margin at both boundaries to prevent oscillation; preserve exact selected projection identity while crossing. Thresholds are acceptance inputs and may be tuned after viewing the matrix without changing the contract.

| Mode | Band content | Available actions |
| --- | --- | --- |
| Overview, including 7% and screenshot's 21% | Compact horizontal strip, minimum 72px high: readable task title, state, distinct working/unknown counts, selected-conversation chip, compact member/relation summary. No tiny transcript thumbnails. | Open task; focus member from its complete member list; local +Agent; shared-conversation links. Full title via expansion/keyboard focus. |
| Intermediate, representative 40%/58% | Task header plus wrapped short conversation summaries: human title, role, real state, latest short summary, relationship labels. | Select/open any member; see actual handoff/review arrows; native launch form from local +Agent. |
| Near, representative 100% | Same bands, selected native conversation reader and summaries for its siblings. Existing composer and runtime controls retain their layout and authority. | Read/type/control the selected conversation; transfer sole owner to another projection or full window; Return. |

Overview text and controls remain screen-sized. Zoom changes semantic density and the camera framing; it does not shrink labels to illegibility. Large task lists remain vertically navigable and windowed. Fit frames the useful task overview with readable rows and scrolling/panning access to the remainder; it must not compress 1,000 titles into the viewport. The minimap can represent all bands and indicate the viewport.

### Representative wireframes

All examples use invented task/agent names.

```text
Available board width 1440, intermediate
[Project]   [Search]                          [+Agent] [+Task] [+Pipeline] [58%]
┌ Restore search results                 3 working · 1 waiting       Details ┐
│ [Investigate · working] --handoff--> [Implement · working]                 │
│          └--review input-----------> [Review · working]     [+Agent]       │
│ [Check examples · waiting]                                               │
└──────────────────────────────────────────────────────────────────────────┘
┌ Simplify export settings               1 working · 1 unknown       Details ┐
│ [Implement · working · also in 2 tasks]   [Verify · unknown]    [+Agent]    │
└──────────────────────────────────────────────────────────────────────────┘
┌ Repair old links                       Done · 0 working           Details ┐
│ [Implement · completed] --review input--> [Review · passed]    [+Agent]     │
└──────────────────────────────────────────────────────────────────────────┘
```

```text
Overview 7% / 21%, available width 840 (orchestrator panel open)
[+Agent] [Tasks]                                  [-] [21%] [+]
──────────────────────────────────────────────────────────────
Restore search results     3 working · 1 waiting        [+Agent]
Investigate → Implement → Review      [4 conversations]
──────────────────────────────────────────────────────────────
Simplify export settings   1 working · 1 unknown        [+Agent]
[Implement — selected, shared]        [2 conversations]
──────────────────────────────────────────────────────────────
Repair old links           Done · 0 working             [+Agent]
[2 conversations · latest review passed]
──────────────────────────────────────────────────────────────
```

```text
Near mode, narrow available width 680
Restore search results                       3 working   [+Agent]
┌ Implement — selected ────────────────────────────────────────┐
│ Existing native reader; text selection and scroll retained   │
│ ...                                                         │
│ Existing composer + controls                                │
└─────────────────────────────────────────────────────────────┘
 [Investigate · working]    ──review input──> [Review · working]
 [Check examples · waiting] [+Agent]
──────────────── next task begins after this entire band ──────
```

At 375/390px available width use one tile per row. Board zoom does not disable browser text zoom. Existing mobile focus/map behavior stays intact; the band's data and status contract is shared without introducing a mobile redesign.

## Shared conversations, relationships and controls

Use a projection key `(taskId, conversationId)` for geometry and DOM destinations. Use the durable conversation ID for selection, drafts, transcript state, delivery, capabilities and runtime controls. Track the selected projection separately only to choose the screen anchor. Selecting one projection highlights its counterparts and labels them “Same conversation · also in …”.

Maintain one NativeConversationPane/composer owner per durable conversation. Move its existing portal destination when the operator opens another projection; never mount a second composer, duplicate subscription owner or start/resume a runtime merely because a projection becomes visible. A global selection set deduplicates conversation IDs, including marquee selection across two projections; bulk actions happen once. Reload, alias changes and successor generation resolve through currentConversationFile and existing canonical identity helpers.

A running shared conversation contributes once to each task's linked-worker count. The UI describes it as a working linked conversation; it does not claim concurrent progress on both task scopes. Overall unique-worker totals deduplicate across tasks. Explicit task membership does not create lineage.

Only draw directed edges backed by actual records:

- A recorded handoff points from source to recipient.
- A review-input relation points from the reviewed implementer to that recorded reviewer/round. A recorded returned verdict can point back with a “findings returned” label.
- Actual pipeline transitions use their activation/attempt evidence. Planned next/onFail edges are dashed and explicitly “planned”; they do not claim a handoff happened.
- Shared task membership, array order, a common manager, nearby tiles or title similarity generate no arrow.
- Retain historical attempts and verdict/SHA evidence in task details. Unknown associations say “relation unavailable”; incomplete data cannot become “no findings”.

Route edges against final displayed rectangles. Same-row edges use side ports; wrapped edges use the row gutter and explicit continuation markers. In dense bands show selected member's incident edges plus a relation count and complete relation list; do not draw an unreadable global tangle. Cross-task actual relations use labeled continuation chips naming the other task; selecting one navigates through the existing focus/Return behavior.

Task title is the band header. Pipelines and flows appear as execution labels and stage/round details within that task, with existing edit/pause/retry controls routed to their existing owners. A pipeline linked to multiple tasks is projected in each; each attempt still has one canonical identity and one actuation. Unlaunched stages are planned slots, excluded from worker counts. Existing pipeline membership/flows coexist with BoardTask; no new workflow engine or parallel task database is introduced.

## Activity ordering and screen anchoring

Compute `runningCount` from distinct canonical conversations with current authoritative busy/working evidence. Consume the existing lifecycle/capability projection and authoritativeTurn; a fresh mtime, “live” recency, alive process, pending send or historical pipeline-running string alone is insufficient. Contradictory, unavailable or incomplete current evidence becomes unknown and contributes zero. Do not invent a UI timeout to turn unknown into completed.

Order by: runningCount descending; then stable task createdAt ascending; then task ID. This puts all tasks with positive counts above zero-count tasks and gives reproducible ties. Task status/attention remains visible and does not override the requested activity ranking. Recalculate only on coherent lifecycle/task revisions.

Interaction policy:

- Capture an order snapshot during pointer drag, text selection, an open action menu or composer focus. Apply incoming status labels immediately; defer rank moves and new bands in that interval. Show a small “Order updated” action if pending changes would move rows.
- On release/blur, batch the latest ranking and reflow once, holding the selected projection's anchor. Clicking “Order updated” performs that operation explicitly. Selection alone does not freeze sorting forever.
- Freeze wrapping during a drag; use the same starting geometry for hit testing and drop. Existing supported drag actions continue to their original owner. New task band headers have no free-position drag handle. Do not promise free pins and then ignore them.
- Existing stored free-map pins remain untouched and usable in their existing map/manual context. They do not override activity order in the task-band view. Adding persisted within-band ordering or a second pin system is deferred.

For every semantic zoom/reflow transaction, capture the selected conversation header's top-left screen coordinate relative to the board viewport, together with task/conversation IDs and its current internal reader anchor. Compute the new complete band layout, then solve camera translation before paint:

```text
screen = viewportOrigin + cameraTranslation + zoom * worldAnchor
newTranslation = capturedScreen - newViewportOrigin - newZoom * newWorldAnchor
```

In overview, the selected-conversation chip is that projection's anchor; intermediate/near use the conversation header. Map these anchors by identity, never by list index. Apply the same rule for wheel/pinch, +/- buttons, keyboard zoom, viewport resize, opening the orchestrator dock and activity-driven reordering. With no selected projection, keep the pointer world point for gesture zoom, or viewport center for button zoom.

Do not apply a competing center-on-selection effect after the anchor adjustment. Extend the navigable world bounds enough to permit the anchor-preserving camera; normal content-bound clamping must not drag a retained selection away. A deliberate Fit, navigation jump, user pan or Return is an explicit framing change. If a selected projection is removed by an explicit task unlink, choose the nearest surviving projection of the same conversation and transfer ownership/anchor; if none is available, retain the existing reader/recovery surface with an unavailable-context label.

Accept at most 2 CSS pixels of selected header/chip drift at each transition, and 4px cumulative drift over 20 forward/reverse cycles when viewport bounds are unchanged. Internal reader anchor, text selection, draft, follow-tail and original delivery key must survive. Respect reduced motion; anchor correction is synchronous, optional surrounding row motion is a short transform animation.

## Implementation ownership and sequence

Two serial product slices are the minimum coherent division. No parallel edits of the same file set. The next Fable stage implements Slice A only, publishes a reviewable candidate and reports its limits. Root schedules Slice B after exact-head review and integration of A. Passing A does not claim the board redesign is complete.

| Slice / owner | Owned seam and expected files | Reviewable result |
| --- | --- | --- |
| A — Fable; Astra review | Canonical membership command and bootstrap in `src/lib/tasks/{types,store,commands,reconcile}.ts` plus focused new admission/bootstrap modules; adapters in `src/lib/agent/spawnCommand.ts`, `src/lib/runtime/structuredSpawn.ts`, the spawn branch of `src/lib/runtime/http.ts` if needed to close that ingress, task spawn/assignment routes, `src/lib/pipelines/{taskBinding,engine,prompts}.ts`, flow kickoff path, `src/lib/mcp/{bindings,server}.ts`; existing discovery/identity admission adapter only where necessary. Matching unit/integration tests belong to this slice. | Atomically created/bound placeholders, replay-safe membership, truthful linked state, safe refinement, pipeline/flow/native coverage, last-unlink protection and resumable legacy import. No board appearance rewrite. |
| B — Fable; Astra review | `src/components/tasks/taskWorkflowModel.ts`; `src/components/scheme/{SchemeBoard,taskBoardLayout,useSchemeCamera,nodes,TasksLayer,TaskEdgesLayer,NativeConversationPane}` and minimal layer helpers; task-local launch UI in `ProjectDashboard.tsx`/existing spawn form; existing focus/presence/selection adapters as required for durable-ID deduplication; locale strings and matching DOM/browser tests. | Bands at all scales, multiple projections with one reader owner, authoritative ranking, local/global launch actions, directed recorded relations, anchored reflow and complete matrix evidence. |

Before each slice, enumerate exact touched files and pre-existing tests whose old placement/selection assumptions change. Keep module edits to the named behavior. Discovery/flow/bootstrap filenames must be pinned from that candidate's current code before editing; this document does not authorize a scanner or runtime redesign. If complete ingress coverage requires broader changes, stop that slice at the missing seam and let root assign a successor with the evidence. Do not silently ship a no-orphan claim with bypasses.

### Active delivery-repair exclusion

Pipeline `5052dff8` was read through get_pipeline; its repair stage is active. The worker transcript narrowed its work to durable queue recovery. Final read-only worktree inspection showed `src/components/TmuxComposer.reconciliationExpiry.dom.test.tsx`, `src/components/TmuxComposer.tsx` and `src/components/conversation/outbox.ts` modified. Reserve all three to that owner, together with any receipt/outbox/runtime recovery files it subsequently claims.

Slice A's membership preparation must not change message reconciliation or queued payloads. Slice B may consume the existing composer and relocate its retained owner, but may not edit TmuxComposer or its queue tests concurrently. Root must refresh the active owner's file list and merged head before B. Any required composer fix is explicitly dependent on the delivery repair and deferred until that ownership is released. The design does not start another pipeline or send the worker a message.

## Acceptance and evidence plan

Use invented fixtures and isolated HOME, XDG_CONFIG_HOME, LLV_STATE_DIR, provider homes and a short TMPDIR. No test may contact the operator's runtime, reuse its browser profile or enumerate/act on live processes. Product browser fixtures must intercept endpoints and fail unexpected network traffic. Browser automation uses a dedicated session and inert origin. Visually inspect actual captures; never use OCR.

### Slice A contract checks

1. Global launch, explicit task launch, MCP launch, pipeline stage, standalone flow reviewer and Viewer-controlled native/manual launch all obtain committed task membership before execution. Direct runtime transport cannot bypass it. External/native and imported legacy conversations obtain membership before their first task-board admission.
2. Crash before task commit, after task commit, before first actuation, after actuation and before response. Replay the original key after restart: one canonical task, one membership and at most one authorized actuation.
3. Null transcript path, failed first launch, no tools, ignored bootstrap, failed refinement, duplicate refinement and two competing agents. Placeholder survives; operator/meaningful title is preserved; errors remain truthful.
4. Expire the ordinary create-receipt cache, then replay admission. Persisted membership key still finds the original task. Reusing a key with altered targets/payload refuses.
5. Resume/successor generation, multiple explicit tasks, imported shared conversation, archived history, legacy unknown fields and task deletion/last unlink preserve identity and data. A membership-only link never says delivered.
6. Interrupted import of 1,000 conversations including more than 300 independent fallback tasks converges without deletion or duplicate tasks. Partial/unreadable evidence preserves records and exposes pending recovery.
7. Native manual spawn has the same choices and engine behavior; no pipeline is created solely to obtain task membership. Existing task-managed pipeline tests stay green.
8. Lifecycle unknown does not release/retry a launch or trigger cleanup. No changed timeout is part of this work.

### Screenshot matrix for Slice B

Capture both light and dark at every primary combination below: 3 outer widths × 3 fixture densities × 6 zooms × 2 themes = 108 frames. Name the available canvas width in each report; outer width alone hides dock/rail effects.

| Dimension | Required values |
| --- | --- |
| Outer viewport | 1280×800, 1440×900, 1920×1080 |
| Zoom frames | 7%, 21%, 22%, 40%, 58%, 100% |
| Fixtures | 6 tasks/12 conversations; 25 tasks/100 conversations including a 24-member band; 350 tasks/1,000 conversations including a 100-member band |
| Mixed evidence in every fixture | native manual agent, tool-less placeholder, failed/pathless launch, planned stage, returned review, shared conversation in two tasks, unknown state, active and completed tasks |
| Additional captures | 1440 with orchestrator dock open at 21/58/100%; 375×812 and 390×844 at overview/intermediate/near; 200% browser text zoom and reduced motion |

Run geometry/interaction assertions around 20/22/24 and 80/82/84 percent in both directions as well as every capture scale. Check first, middle and last worker of each dense band. For one 100-member band prove the local +Agent remains reachable and appends in that band. At narrow widths wrapping cannot hide controls, cover titles or create body-level horizontal overflow.

Required behavioral proof:

- Exactly one horizontal band per task; no floating admitted worker, duplicate task store, hidden final row or task-grid overview.
- Selected anchor delta and cumulative drift within the stated tolerances for all zoom methods, dock resize, band wrapping, rank changes and shared-projection switches. Provide before/after rectangle records alongside screenshots.
- A focused composer/drag/text selection remains stable while working counts change; deferred ordering then converges to the correct rank with anchored focus.
- Multi-projection selection/control/send produces one runtime operation and one durable original key. Repeat unknown/recovery/terminal transitions in isolated transport fixtures; unknown remains visible and never causes redispatch.
- Actual handoff/review arrows have correct direction and displayed ports within 2px; unrelated neighbours and shared manager tasks have zero fabricated edges. Planned edges stay distinguishable.
- Existing pipeline/flow controls and attempt history work inside each projection; duplicate controls target the same durable execution. A loading error shows unavailable evidence.
- Warm readers, then perform 20 pans, 100 incoming messages and 21 seconds idle. Instrument hidden wrapper, summary parser, pane/feed/header entries, UI callbacks, subscriptions and DOM changes. Preserve current-main zero hidden presentation-work expectations. Execution, ingestion and durable delivery continue independently of visibility.
- Record input-to-paint, frame intervals, long tasks and DOM/subscription counts against exact base using the same fixtures and deadlines. No claimed speedup from an uncompleted baseline. Do not substitute screenshot counts for performance evidence.
- Reuse the production-component harnesses under `docs/design/task-board-integration/artifact/` where applicable; change fixture/layout expectations to this requirement. Existing prototype-only synthetic checks cannot certify runtime integration.

Astra review leads with requirement compliance. WRONG-PREMISE includes a beautiful pipeline grid, detached agents or drifting selection. OVER-BUILT includes a new graph library, parallel task store or workflow-engine rewrite when the existing store and pure band layout suffice. Both are actionable review verdicts; no cosmetic polish can compensate for them.

## Deferred — not currently justified

- Unified mutable automation state machine, historical release/PR/successor schema and new scheduling semantics: #1446 owns these. Show existing evidence and honest missing relations now.
- Global project-map redesign and a desktop shell/font/theme replacement: outside this focused September 9 request; #183/#1453 retain their broader scope.
- New graph/layout libraries, generalized cross-store transaction framework, a second outbox or a new task database.
- Automatic semantic regrouping of old agents by title/prompt similarity; task splitting, merging and automatic cross-task reassignment.
- Persisted free placement/reordering for task bands, heatmaps, progress percentages inferred from activity, decorative status animation and a new pin preference system.
- Composer/delivery internals owned by the active repair, real host restart qualification, deployment and live migration execution. The latter require the implementation's isolated proof and root's release ownership.
- A full mobile redesign, cross-browser certification and newly mandated screen-reader audit. Preserve existing keyboard/focus/accessibility behavior and run the narrow-width checks above.

## Validation against the original request

| Request | Concrete coverage |
| --- | --- |
| Horizontal area per task, several rows allowed | Full-width bands and footprint-driven wrapping in all three zoom modes |
| Every agent has a task; first action gives a human name | Atomic admission binding, prompted once-only refinement, no-tools/failure/import behavior |
| One agent may do several tasks | Repeated projections sharing canonical conversation, delivery, controls and selection |
| Zoom looks good and the conversation stays nearby | Readable overview, identity-based anchor equation, 108-frame matrix and measured drift gate |
| Understand transitions between agents | Directed actual handoff/review edges, explicit planned/unknown relations |
| +Agent globally creates a default task; locally adds on the right | Existing launch form with global fallback or explicit task context; right append with wrap |
| Working tasks above others; more workers higher | Unique authoritative running count with stable ties and interaction-aware reordering |
| Astra and Fable work together | Astra design → Fable A → Astra exact-head review → Fable B → Astra requirement/geometry review, scheduled by root |

Design self-review: the scope serves the September 9 request. The canonical store and native reader mechanisms already exist; two serial slices avoid rebuilding them. Admission completeness and screen geometry remain implementation gates. No production/browser pass is claimed by this document.
