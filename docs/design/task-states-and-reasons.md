# Task states and reasons: one vocabulary for the board

Design for #1844. Status: proposal, waiting for the operator's review. No slice starts before that.

## The request

Operator request, 2026-09-19 09:10Z, orchestrator seat chat. Paraphrased in English; the original is not quoted.

> We have blocked tasks and other stopped things, and I want a place where I can really see why something is blocked or why it stopped. If 5 of 8 causes are fixed, why are we not working on the rest? Was it postponed? Maybe instead of assigned / blocked / done we need something like working and queued. I am not pushing a particular answer, but think about it and tie it to the kanban changes we planned: the Overview, the filter, and expanding and collapsing each column.

Three needs follow from these words, and the design is checked against them at the end:

1. For anything that stopped, the board says **why**, in a place the operator can see.
2. For a task that is partly finished, the board says **how much is left and why nobody is on it**.
3. The words on the board describe **what is happening** (working, queued), and the planned board pieces use the same words.

## Decisions first

1. **The column stays a stored status. What is happening on a card is derived.** The four stored values (`inbox`, `assigned`, `blocked`, `done`) keep their wire names. A single derived value, called *motion* in this document, says whether the card is working, needs the operator, is waiting on something, or has stopped with no reason given.
2. **The operator's working / queued idea is adopted as the reading of the card, inside the column that holds active work.** "Working" is never stored, because it changes by itself many times an hour. The top part of the active column is the working cards; below a divider sit the cards where nobody is working.
3. **Anything that is waiting carries one structured reason**, a new optional `hold` field on the task: what it waits on, since when, who said so, what ends the wait. The card shows it as one line without opening anything.
4. **A card that stopped and carries no reason is shown as exactly that**: "Stopped, no reason given". This is the honest state of the 65 old blocked cards, and the board should say so instead of hiding it behind the word "blocked".
5. **Partial work is a short checklist on the task** (`steps`), where a step may point at a pipeline, an issue or a pull request. The card shows "5 of 8 done · 3 queued: waiting for a free worker".
6. **One function computes motion**, and the board, the Overview filter, the column headers and filters, and the seat panel all read it. Nobody defines "working" a second time.
7. **Existing writers keep working.** `update_task status` accepts the same four values for ever. Nothing is rejected; a bare `blocked` is recorded with the reason "none given".

Choices that belong to the operator are collected in [Open choices](#open-choices-for-the-operator).

## What exists today

Every statement here was read from `main` at `abf863d0` and from the live board on 2026-09-19.

**Stored status.** `TaskStatus` is `"inbox" | "assigned" | "blocked" | "done"` (`src/lib/tasks/types.ts`). Agents and the operator set it by hand. One rule moves it automatically: when assignments change, a task in `inbox` or `assigned` flips between those two depending on whether it has an owner (`src/lib/tasks/commands.ts`, assignment merge). Nothing ever moves a task into or out of `blocked` or `done` by itself.

**Derived activity.** `buildKanbanModel` (`src/components/kanban/kanbanModel.ts`) already derives, per card:

- `working`: the number of member conversations whose row state is `working` or `held`. Row state comes from `mobileRowState` (`src/components/mobile/mobileBoardModel.ts`), which has eight states: killed, stalled, limit, held, waiting, working, returned, done.
- `needsYou`: a member in `waiting`, `stalled` or `limit`, or a pipeline in `needs_decision`.
- `idle`: no members, no active pipeline, nothing owed. The Assigned column already draws an "Idle · N" divider under which these cards sit.
- `cardHasLiveWork`: `working > 0`, or `needsYou`, or a stage chip in `running`, `reviewing` or `committing`. This is the Overview filter of #1820 and the predicate behind the "N working" counters.

**Pipelines.** `PipelineState` is `draft | provisioning | running | needs_decision | paused | completed | closed` (`src/lib/pipelines/types.ts`). A pipeline names its tasks in `taskIds`; the task read model turns that into `pipelineIds` (`src/lib/pipelines/taskBinding.ts`). A stage report records the branch's pull request (`url`, `number`, `state`) at the moment of the report, and never refreshes it.

**Column hints in the UI today** (`src/lib/i18n/en.ts`): Assigned is "Has, or is waiting for, an agent"; Blocked is "Needs something outside the task". So "assigned" already means two different things, which is the ambiguity the operator is pointing at.

**The live board, this project, 2026-09-19.**

| Column (cards drawn on the board) | Count | What their pipelines say |
| --- | --- | --- |
| Inbox | 6 | none has a pipeline |
| Assigned | 12 | 6 have a running pipeline, 1 waits on a decision, 5 have nothing running |
| Blocked | 65 | 40 have no pipeline at all, 25 have only closed pipelines. **None has anything running.** |
| Done | 90 | |

The 65 blocked cards were last written on 15–16.09 (63 of them on 16.09, in one sweep). Read by title:

| What the title says | Cards |
| --- | --- |
| "no active owner" / "stalled owner" | 32 |
| "blocked", with nothing after it | 16 |
| "blocked by …" / "blocked on …" with a cause in words | 7 |
| "paused" / "parked" | 5 |
| "changes requested" | 1 |
| no state word at all | 4 |

So half of the Blocked column is waiting on nothing. Those cards lost their agent, and "blocked" was the only word available. A quarter say "blocked" and stop there. Seven name a cause, in prose only, with no date and no link.

**The two partial tasks.** Both sit in Assigned with nothing running, and both explain themselves only in prose:

- The memory task (#1805): the title says five of eight causes are fixed. The body lists the fixed ones and the remaining ones and ends with a sentence meaning "I will start them when workers are free". The body's two lists do not add up to the title's numbers, which is what happens when a count lives in prose.
- The CI audit (#1761): eight of eleven steps done; of the remaining three, two have no owner and one is deliberately scheduled after a week of green CI. That last one is the operator's "was it postponed?" case: the answer exists, in the middle of a paragraph.

**Earlier work.** Transcript search (project-scoped and unscoped, several phrasings) found no earlier design for structured block reasons or queue states. #1695 decided that the column is the stored status and that activity is a label and an order inside the column; this design keeps that decision and gives its reasons again below.

## Question 1. Which states the operator reads at a glance

### Three models, judged against the request

**Model A. Keep assigned / blocked, add a reason field.** Cheapest. It fixes "why is it blocked" for cards that an agent marks well. It does nothing for the 12 Assigned cards, where 5 have nobody working and no way to say why. The memory task and the CI audit are both Assigned, so Model A misses the operator's own example.

**Model B. Stored statuses become working / queued / done (the operator's idea, taken literally).** The words are right; they describe what is happening. Stored, they fail. "Working" flips whenever an agent finishes a turn, so a stored "working" is wrong within minutes unless an agent rewrites it constantly, and agents setting status by hand is the very mechanism that produced 65 stale cards. If the server rewrites the status instead, the card jumps between columns by itself while the operator is reading or dragging it, and optimistic moves with undo (#1695) stop making sense, because a column change is no longer the operator's action.

**Model C. Everything derived; agents only declare intent.** The cleanest idea. It fails on one fact: most reasons for waiting are invisible to the Viewer. "Waiting for the operator to choose", "after a week of green CI", "after the other task merges" exist only in an agent's head until it declares them. A fully derived column would also move cards around without anyone acting.

**Recommended: the stored status is the declared intent, and motion is derived on top of it.** This takes the vocabulary from B, the derivation from C and the low cost of A.

- The stored status answers "what did someone decide about this task": not started, active, waiting, finished. It changes only when a person or an agent acts. Columns follow it, so cards hold still.
- Motion answers "what is happening right now" and is computed from live facts. It is the line the operator reads on the card, the order inside a column, and what every filter uses.

### The motion values

One function, fixed precedence, first match wins:

| Motion | Shown as | Derived from | Stored or declared? |
| --- | --- | --- | --- |
| `needs-you` | Needs you | a member in `waiting`, `stalled` or `limit`; a pipeline in `needs_decision`; a hold of kind `operator` | derived, plus one declared kind |
| `working` | Working · N | `working > 0`, a stage chip in flight, or a pipeline provisioning. Exactly today's `cardHasLiveWork` minus the needs-you part. | derived |
| `waiting` | Waiting: *reason* | the task carries a `hold`; or its only active pipeline is `paused` (reason "Paused", since `pausedAt`) | declared, one case derived |
| `stopped` | Stopped, no reason given | status `assigned` or `blocked`, nothing working, nothing owed, no hold | derived |
| `not-started` | (no line) | status `inbox` | stored |
| `done` | Done / Dropped | status `done` | stored |

`stopped` is the important new one. It is the board noticing, without any agent's help, that a card claims to be active and nothing is moving. It replaces the "Idle" divider, which today only catches cards with no conversations at all. The memory task has ten finished conversations and is therefore "not idle" by today's predicate, while nobody works on it.

A live fact always beats a declaration: a card with a hold whose agent starts working reads "Working". The hold stays on the task until someone clears it, and the card says so in small text ("hold still set"), so a stale hold is visible instead of silently lying.

### What is left out of the derived set

The issue also names "a PR waits for CI" and "merged but not deployed" as candidate derived states. The Viewer holds no live evidence for either: the pull request state on a stage report is a snapshot, and deployments are recorded per release, with no link to a task. Deriving them needs forge polling and a task-to-deployment relation. The operator's words do not ask for them. They are in [Deferred](#deferred--not-currently-justified); until then an agent declares them as a hold ("waits on PR #N").

## Question 2. A structured reason for anything that is not moving

One optional field on `BoardTask`:

```text
hold?: {
  kind:  "operator" | "task" | "pr" | "issue" | "worker" | "resource" | "limit" | "postponed" | "external" | "unstated"
  ref?:  a task id, or a PR / issue number, or a URL   (for task, pr, issue, external)
  note:  one plain sentence: what ends the wait          (≤ 200 chars, may be empty for "unstated")
  since: ISO time, set by the server when the hold is first written
  until?: ISO time, for "postponed" and "limit"
  by:    "operator" | "agent" | "migration", plus the conversation id for an agent
}
```

| Kind | The card reads | Who has to act |
| --- | --- | --- |
| `operator` | Waiting for you: *note* | the operator. Counts as needs-you. |
| `task` | Waiting for «*other task's title*» | another task; the title is a link |
| `pr` / `issue` | Waiting for PR #N / issue #N | a merge or a fix elsewhere; a link |
| `worker` | Queued: waiting for a free worker | nobody; the seat picks it up |
| `resource` | Queued: not enough memory | nobody, or the operator if it lasts |
| `limit` | Queued: usage limit, until 16:40 | nobody; time |
| `postponed` | Postponed until 26.09: *note* | nobody until the date |
| `external` | Waiting outside: *note* | someone outside the project |
| `unstated` | Stopped, no reason given | whoever triages it |

The three "Queued" kinds are the operator's *queued*: work that will start by itself when capacity appears. The others are *blocked* in the plain sense: somebody has to do something first. The card's first word tells them apart.

**Rules, all clamping and none rejecting:**

- Writing a hold on an `inbox` or `assigned` task moves it to `blocked`. Clearing the hold moves it back by the existing owner rule (`assigned` with an owner, otherwise `inbox`).
- Writing `status: "blocked"` with no hold is accepted and records `kind: "unstated"`. The tool description asks for a hold; the server never refuses the write.
- Moving a card out of the waiting column by hand clears its hold. The undo toast of #1695 restores both.
- `since` is set by the server once and survives edits to the note. A `postponed` hold whose `until` has passed reads "Postponed until 26.09, now due" and counts as `stopped`.

**On the card.** One line under the title, always visible, never behind a disclosure: reason, then age ("3d"), then who set it on hover or long-press. The `note` follows #1834's rule: it is for the person, one plain sentence. Agent context stays in `details`.

**Filterable.** The "Find a task" control gains reason chips that appear only when the board holds such cards: Needs you · Queued · Waiting · Postponed · No reason. They narrow in the same place search narrows (`cardMatches` plus the `cardFilter` hook the Overview already uses), so counts stay taken over the whole board.

### How the 65 cards map

A one-time migration, per project, written once:

| Title pattern | Cards | Becomes |
| --- | --- | --- |
| "no active owner", "stalled owner" | 32 | `unstated`, note "Lost its agent on 16.09" |
| bare "blocked", no state word | 20 | `unstated`, empty note |
| "blocked by / on …" | 7 | `unstated`, note = the words after "blocked by", since the cause is prose and cannot be trusted as a link |
| "paused", "parked" | 5 | `postponed` without a date, note from the title |
| "changes requested" | 1 | `unstated`, note "Review asked for changes" |

All get `by: "migration"` and `since` = the task's `updatedAt`, shown as "since 16.09 or earlier", because `updatedAt` is bumped by every write and is only an upper bound.

The migration invents nothing. 60 of 65 cards end up reading "Stopped, no reason given", which is true. The useful part is what follows: the No-reason chip turns them into a triage list, with two bulk actions on the selection, **Drop** (see below) and **Back to Inbox**. An agent can do the same triage through `update_task`. Most of these are merge and review chores from a wave that ended on 16.09, and none has a running pipeline, so the expected outcome is that most are dropped in one sitting.

**Dropped.** Triage needs a way to say "we will not do this" that differs from "finished". One optional field: `resolution?: "dropped"`, valid only with `status: "done"`. The card sits in Done with a struck-through "Dropped" label. No fifth status, no fifth column.

## Question 3. Partial outcomes

### Options

| Option | Judgement |
| --- | --- |
| Count the task's pipelines (`pipelineIds`) | Already there, and honest for work that started. It cannot show work that has not started, which is exactly the "3 queued" half of the question. The memory task has 4 pipelines and 8 causes. |
| Live state of linked GitHub issues | The right source in the long run. Needs forge polling, caching and rate-limit handling inside the task read path. Too heavy for this need; deferred. |
| Sub-tasks as real board tasks with a parent | A new entity relation, new board layout questions (where does a child card sit?), and 8 more cards per audit on a board that already hides 1,100 tasks. Rejected. |
| Markdown checkboxes parsed out of `text` | No schema change, but it puts structure back into prose, and #1834 is moving agent bookkeeping out of `text`. Rejected. |
| **A `steps` checklist on the task, each step optionally pointing at what does the work** | Recommended. A field, with no store or API of its own. |

### The field

```text
steps?: Array<{                     (≤ 20)
  id:    short stable id
  text:  what this step is, for a person          (≤ 120 chars)
  state: "done" | "open" | "dropped"
  ref?:  a pipeline id, or an issue / PR number
  hold?: the same hold shape as the task          (why this open step is not moving)
}>
```

The shown state of a step is derived where the Viewer has evidence, and declared elsewhere:

- `ref` is a pipeline of this task → running or provisioning reads **working**; `needs_decision` reads **needs you**; completed reads **done** unless the step says otherwise.
- `ref` is an issue or PR → a link only. Its state is whatever the agent declared.
- An open step with no live pipeline reads **queued** with its hold's reason, or **no reason given**.

**On the card.** One summary line and a segmented bar; the list opens in place:

```text
5 of 8 done · 3 queued: waiting for a free worker
```

The summary names the most common reason among the open steps, and says "3 open, mixed reasons" when they differ. When a task has steps, the task's own motion is computed from them: any step working makes the card Working.

The CI audit would read "8 of 11 done · 2 no reason given · 1 postponed: after a week of green CI". That single line answers "why are we not working on the rest, was it postponed?" for that card.

## Question 4. One board, one vocabulary

One pure, i18n-free function next to the task types, in the style of `mobileRowState`:

```text
taskMotion(card facts, now) → { key, reason, since, steps summary }
```

`cardHasLiveWork` becomes `key is working or needs-you`, with no change in behaviour. Every surface reads the same result:

| Surface | What it reads |
| --- | --- |
| Project board (#1695) | The card's state line. The order inside a column: needs you, working, waiting, stopped, then recency. The divider in the active column changes from "Idle · N" to "Stopped · N". |
| Overview (#1820) | The same filter as today, now spelled `working` or `needs-you`. One optional second chip, "Stopped", for the cross-project question "what has fallen on the floor". |
| Column collapse and search (#1801) | A collapsed column header is a motion summary: `Waiting 65 · 60 no reason`, `In progress 12 · 6 working · 1 needs you · 5 stopped`. The reason chips live beside "Find a task". |
| Seat panel (#1841) | The collapsed handle shows the seat's state with the same two words, "working" and "needs you". Seat tasks leave the columns, so they never count in any motion total. |
| Phone board | Its sections are already Needs you / Working / Recent from the same row states. A task's hold line is the same string. |
| Agents (MCP) | `get_task` and `list_tasks` return `hold`, `steps` and `resolution`. Motion itself is computed in the browser from conversation row state; serving it over MCP is deferred. |

The words, fixed once, en and uk strings together: **Needs you · Working · Queued · Waiting · Postponed · Stopped, no reason given · Done · Dropped.**

## Card mock-ups

Desktop, a card in a 264 px shelf or the wide active column. The state line is always the second line.

```text
┌──────────────────────────────────────────────┐
│ Memory: finished agents keep their hosts   ⋯ │   WORKING
│ ● Working · 2            5 of 8 done         │
│ ▰▰▰▰▰▱▱▱  1 working · 2 queued: free worker  │
│ [pipeline row ▸ implement ● review ○]        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Release candidate for the queue adapter    ⋯ │   NEEDS YOU
│ ▲ Needs you · review asks for a decision · 2h│
│ [pipeline row ▸ implement ✓ review ▲]        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Memory: finished agents keep their hosts   ⋯ │   QUEUED (today's real case)
│ ◌ Queued: waiting for a free worker · 3h     │
│ ▰▰▰▰▰▱▱▱  5 of 8 done · 3 queued             │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Mobile swipe actions                       ⋯ │   WAITING ON SOMETHING NAMED
│ ◷ Waiting for PR #1667 · 3d                  │
│   Merges first; this rebases on it.          │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ CI audit                                   ⋯ │   POSTPONED
│ ◷ Postponed until 26.09 · merge queue after  │
│   a week of green CI      ▰▰▰▰▰▰▰▰▱▱▱ 8 / 11 │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Board camera merge                         ⋯ │   STOPPED (the 60 old cards)
│ ⚠ Stopped, no reason given · since 16.09     │
│   Lost its agent on 16.09.   [Drop] [Inbox]  │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Board camera merge                           │   DROPPED, in Done
│ ✕ Dropped · 19.09   (title struck through)   │
└──────────────────────────────────────────────┘
```

Phone, 390 px wide: one tabbed column, the same two lines, the note wraps, actions move into the row's existing swipe and menu.

```text
┌────────────────────────────────────┐
│ Memory: finished agents keep…      │
│ ● Working · 2 · 5 of 8 done        │
├────────────────────────────────────┤
│ Release candidate for the queue…   │
│ ▲ Needs you · decision · 2h        │
├────────────────────────────────────┤
│ Memory: finished agents keep…      │
│ ◌ Queued: free worker · 3h         │
│ ▰▰▰▰▰▱▱▱ 5 of 8                    │
├────────────────────────────────────┤
│ Mobile swipe actions               │
│ ◷ Waiting for PR #1667 · 3d        │
├────────────────────────────────────┤
│ CI audit                           │
│ ◷ Postponed until 26.09 · 8 / 11   │
├────────────────────────────────────┤
│ Board camera merge                 │
│ ⚠ Stopped, no reason · since 16.09 │
└────────────────────────────────────┘
```

Collapsed column headers (#1801), desktop:

```text
│ Inbox 6 │ In progress 12 · ●6 ▲1 ⚠5 │ Waiting 65 · ⚠60 no reason │ Done 90 │
```

Every state has a glyph and a word; colour is never the only signal.

## Question 5. Migration

- **Wire values never change.** `inbox | assigned | blocked | done` stay in the store, the REST routes, `update_task`, `list_tasks` filters, the orchestrator mandate and every existing agent prompt. Only the column labels change, and only if the operator picks new ones.
- **New fields are optional and additive.** A task without `hold`, `steps` or `resolution` renders as today, plus the derived "Stopped" line when it applies. Old clients ignore fields they do not know.
- **Writers are nudged and never refused.** `update_task` and `create_task` gain `hold`, `steps` and `resolution` parameters. The tool descriptions, the MCP server instructions and the manager mandate gain three sentences: set a hold whenever you stop work on a task; keep the step list current when a task has parts; mark abandoned work dropped. A bare `status: "blocked"` still succeeds.
- **The old cards migrate once**, as in the table above, guarded by a marker in the task state file so a restart never repeats it.
- **No agent has to change on day one.** An agent that ignores all of this produces cards that read "Stopped, no reason given", which is accurate and pushes the seat to fix its own bookkeeping.

## Check against the request

| The operator asked | The design answers with |
| --- | --- |
| A place to see why something is blocked or stopped | The state line on every card; reason chips; the collapsed-column summary |
| Five of eight fixed: why is nobody on the rest? Postponed? | `steps` with a per-step reason; "queued: free worker" and "postponed until …" are first-class |
| Maybe working / queued instead of assigned / blocked / done | Working and Queued are the words on the card and in the filters; stored status stays, for the reasons under Model B |
| Tie it to the Overview, the filter, column expand and collapse | One `taskMotion` function read by all of them, and by the seat panel |

## Open choices for the operator

**1. Column names** (the wire values stay either way).

| Option | Columns | Note |
| --- | --- | --- |
| **A (recommended)** | Inbox · In progress · Waiting · Done | "Waiting" is true for both queued and blocked cards, so "Queued: free worker" does not sit under the word Blocked. |
| B | Inbox · Assigned · Blocked · Done | No relabelling. "Queued" cards sit under "Blocked", which reads wrong. |
| C | Inbox · Working · Queued · Done | The operator's words as column names. The "Working" column would contain stopped cards, so the name promises more than the column holds. |

**2. Where queued cards sit.**

| Option | Behaviour |
| --- | --- |
| **A (recommended)** | Every hold, queued kinds included, moves the card to the Waiting column. In progress holds only working, needs-you and stopped cards, so everything there is either moving or a problem. |
| B | Queued kinds (`worker`, `resource`, `limit`) stay In progress below the divider; only true blocks move. Closer to the literal working / queued pair; the Waiting column stays small; the rule "hold ⇒ column" gets an exception. |

**3. The 65 old cards.**

| Option | Behaviour |
| --- | --- |
| **A (recommended)** | Migrate all to "no reason given", then triage with the chip and bulk Drop. Honest, and the seat can do the triage. |
| B | Migrate and drop in one step everything with no pipeline and no write since 16.09 (40 cards). Faster; a wrongly dropped card is one click to restore. |

**4. Step count on the collapsed card**: always show "5 of 8" (recommended), or only on expanded cards.

## Deferred — not currently justified

- **Derived "PR waits for CI" and "merged, not deployed".** Needs forge polling and a task-to-deployment relation. Until then these are declared holds. Revisit when #1446 (durable task, PR and deployment relations) lands.
- **Live issue and PR state on steps.** Same polling cost. A step's `ref` is a link for now.
- **Holds that clear themselves** when the referenced task is done or the PR merges. Useful, and it needs the relations above. For now a fulfilled hold is cleared by the agent or the operator; a `task` hold whose target is already Done reads "Waiting for «…» (done)", which makes the stale hold visible.
- **Motion over MCP.** Row state is computed in the browser. Serving it needs the same facts server-side; agents get `hold` and `steps` now.
- **A worker-slot scheduler** that starts queued work when a worker frees up. This design only names the reason; starting the work stays with the seat.
- **Sub-tasks as board tasks, dependency graphs, a history of holds, analytics of time spent waiting.** Nothing in the request asks for them.
- **Renaming the stored status values.** Every agent prompt and tool call uses them; the labels carry the new words at no cost.

## Slice order

Each slice is one issue, ships alone, and leaves the board correct if the next one never happens.

1. **`taskMotion`, the Stopped line and the divider.** The pure function; `cardHasLiveWork` re-expressed through it; the card's state line for needs-you, working and stopped; "Idle · N" becomes "Stopped · N" using live work instead of conversation count. No schema change. Already shows the five silent Assigned cards.
2. **`hold` on the task.** Field, store, REST, `create_task` / `update_task` / `get_task` / `list_tasks`, the clamping rules, the state line for every kind, inline setting from the card's status menu, en and uk strings. Agent guidance in the tool descriptions and the mandate. Column relabel per open choice 1.
3. **Reason chips and collapsed-column summaries.** Depends on the #1801 owner for the toolbar and column header; adds the chips through the existing `cardFilter` hook and the summary line. Optional "Stopped" chip on the Overview.
4. **Migration and triage of old blocked cards, plus `resolution: "dropped"`.** One-time migration per the mapping table; bulk Drop and Back to Inbox on a filtered selection; the Dropped label in Done.
5. **`steps`.** Field and API; derived step state from the task's pipelines; the summary line, the bar and the in-place list; motion computed from steps. The seat rewrites the memory task and the CI audit with steps as the acceptance case.
6. **Seat panel wording (rides with #1841 / #1801).** The collapsed handle uses the two shared words; seat tasks are excluded from motion totals. A few lines inside whichever of those issues owns the panel at that time; no issue of its own unless both have shipped.

Rendered evidence for slices 1–5 goes through the existing kanban browser driver as new `describe` blocks, desktop and 390 × 844, once per slice at the end.
