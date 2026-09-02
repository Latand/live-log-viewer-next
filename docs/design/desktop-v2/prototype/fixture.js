/* Invented, identity-free fixture for the desktop-v2 prototype (issue #1453).
   No real project, account, handle, path or id appears here; every name is
   made up and every number is illustrative. The shapes follow the mobile-v2
   fixture (docs/design/mobile-v2/prototype/fixture.js) so both prototypes
   speak one vocabulary, and the pipeline records carry the automation-v2
   fields (revision, mutations, per-stage attempts with findings, waiting,
   checkpoints) the desktop pipeline surface edits after start.

   Project counts are never typed here: the prototype derives them from the
   conversations and pipelines below, so the rail, the column header and the
   overview cannot disagree (critique round 1, F6).

   SCENARIOS at the end mutate this fixture for the state screens
   (`?scenario=noseat|degraded|offline|held|limit|stalled|arrival|arrival-here|crowded|killed|split|notasks`). */

window.FIXTURE = {
  now: "14:05",
  nowMinutes: 14 * 60 + 5,
  runtime: "connected", /* connected | degraded | offline */
  project: "atlas",

  projects: [
    { id: "atlas", name: "atlas", crowned: true, age: "now" },
    { id: "beacon", name: "beacon-site", age: "12 min" },
    { id: "corvid", name: "corvid-tools", age: "41 min" },
    { id: "delta", name: "delta-ledger", age: "2d", quiet: true },
    { id: "ember", name: "ember-legacy", archived: true, age: "9d" },
  ],

  /* The orchestrator seat for the current project (PRD #976 / #979 / #1347 / #1419). */
  seat: {
    state: "live", /* live | none | creating */
    engine: "claude",
    model: "Opus",
    effort: "high",
    account: "Main",
    plan: "Max plan",
    ctx: { left: 76, window: "100k" },
    since: "2h",
    predecessor: true,
    mandateVersion: 3,
    mandate:
      "You are the atlas orchestrator.\n\nYou own this board and you talk to me here, directly, whenever you have something worth saying.\n\n## What you do\n- one lane per issue, one owner per file\n- a fresh reviewer every round\n- merge only on APPROVE with green gates\n- never deploy red",
    rotation: null,
  },

  hosts: [
    { name: "structured host · atlas", pid: 41230, mem: "612 MB", since: "2h" },
    { name: "structured host · orchestrator", pid: 41198, mem: "580 MB", since: "2h" },
    { name: "tail worker", pid: 41355, mem: "48 MB", since: "31 min" },
  ],

  /* Every account carries both windows. `series` is the remaining percentage
     sampled since the window opened (hours from the window start → % left),
     the burndown the current build already computes; `hourly` is today's
     consumption by hour (percentage points spent). */
  accounts: {
    claude: [
      { id: "cl-main", label: "Main", plan: "Max plan", active: true, auth: "Authenticated", checked: "14:02",
        windows: [
          { label: "5 h", left: 62, reset: "resets 16:40", hours: 5, elapsed: 2.4, series: [[0, 100], [0.3, 97], [0.7, 93], [1.0, 86], [1.4, 80], [1.7, 74], [2.0, 68], [2.4, 62]] },
          { label: "Week", left: 38, reset: "resets Mon 09:00", hours: 168, elapsed: 53, series: [[0, 100], [8, 96], [20, 90], [28, 78], [36, 66], [44, 52], [50, 43], [53, 38]] },
        ],
        hourly: [["09", 4], ["10", 9], ["11", 6], ["12", 12], ["13", 14], ["14", 5]] },
      { id: "cl-lab", label: "Lab", plan: "Pro plan", active: false, auth: "Authenticated", checked: "13:50",
        windows: [
          { label: "5 h", left: 91, reset: "resets 18:10", hours: 5, elapsed: 0.9, series: [[0, 100], [0.4, 96], [0.9, 91]] },
          { label: "Week", left: 74, reset: "resets Tue 09:00", hours: 168, elapsed: 29, series: [[0, 100], [10, 92], [20, 83], [29, 74]] },
        ],
        hourly: [["09", 0], ["10", 0], ["11", 0], ["12", 0], ["13", 5], ["14", 4]] },
      { id: "cl-second", label: "Second", plan: "Pro plan", active: false, auth: "NeedsSignIn", checked: null, windows: [], hourly: [] },
    ],
    codex: [
      { id: "cx-main", label: "Main", plan: "Pro plan", active: true, auth: "Authenticated", checked: "14:01",
        windows: [
          { label: "5 h", left: 88, reset: "resets 17:15", hours: 5, elapsed: 1.8, series: [[0, 100], [0.5, 97], [1.0, 94], [1.4, 91], [1.8, 88]] },
          { label: "Week", left: 55, reset: "resets Sun 09:00", hours: 168, elapsed: 77, series: [[0, 100], [20, 92], [40, 80], [60, 66], [77, 55]] },
        ],
        hourly: [["09", 2], ["10", 3], ["11", 4], ["12", 1], ["13", 2], ["14", 0]] },
      { id: "cx-team", label: "Team", plan: "Team plan", active: false, auth: "Authenticated", checked: "13:40",
        windows: [
          { label: "5 h", left: 100, reset: "resets 19:00", hours: 5, elapsed: 0.1, series: [[0, 100], [0.1, 100]] },
          { label: "Week", left: 97, reset: "resets Sun 09:00", hours: 168, elapsed: 77, series: [[0, 100], [40, 99], [77, 97]] },
        ],
        hourly: [["09", 0], ["10", 0], ["11", 1], ["12", 0], ["13", 0], ["14", 0]] },
    ],
  },

  /* Tasks are the kanban's cards. `status` is one of the current build's five
     readiness sections (now · review · blocked · planned · done); `worker` is
     the conversation doing the task, `pipeline` the record it runs in. */
  tasks: [
    { id: "t1", title: "Export endpoint default format", issue: 218, status: "blocked", worker: "c2", pipeline: "p1" },
    { id: "t2", title: "Board status projection", issue: 212, status: "now", worker: "c1" },
    { id: "t3", title: "Archive TTL for closed pipelines", issue: 206, status: "review", worker: "c4", pipeline: "p2" },
    { id: "t4", title: "Seat handoff smoke test", issue: 240, status: "review", worker: "c12", pipeline: "p6" },
    { id: "t5", title: "Account migration plan", issue: 199, status: "blocked", worker: "c5" },
    { id: "t6", title: "Directory picker keyboard support", issue: 231, status: "planned", pipeline: "p3" },
    { id: "t7", title: "Polish overview cards", issue: 244, status: "planned" },
    { id: "t8", title: "Fast conversation switching", issue: 209, status: "done", worker: "c6", pipeline: "p4" },
    { id: "t9", title: "Seat tick note cap", issue: 251, status: "done", seat: true },
  ],

  conversations: [
    {
      id: "orch", project: "atlas", title: "Orchestrator · atlas", engine: "claude", model: "Opus", effort: "high", account: "Main",
      state: "working", elapsed: "2:14", age: "now", seat: true, ctx: 24, tool: "list_conversations",
      feed: [
        { kind: "user", ts: "13:20", text: "Morning. What is open on the board?" },
        { kind: "tool", tool: "viewer · board_snapshot", status: "ok", dur: "0.6s", ts: "13:20" },
        { kind: "agent", ts: "13:21", text: "Two lanes finished overnight: the reseat test fix merged, the archive TTL tail is in review. Nothing needs you right now." },
        { kind: "user", ts: "13:48", text: "Take issues 212 and 218, one lane each. Report here when a reviewer answers." },
        { kind: "agent", ts: "13:48", text: "On it. Two lanes open: 212 on the board status projection, 218 on the export endpoint. Each gets a fresh reviewer per round." },
        { kind: "tool", tool: "viewer · create_pipeline", status: "ok", dur: "1.2s", ts: "13:49" },
        { kind: "tool", tool: "viewer · create_pipeline", status: "ok", dur: "0.9s", ts: "13:49" },
        { kind: "agent", ts: "13:55", text: "218 has a question for you — which export format to default to. It is in the queue; the lane holds until you answer." },
        { kind: "tool", tool: "viewer · list_conversations", status: "running", dur: "3s", link: true },
      ],
    },
    {
      id: "c1", project: "atlas", title: "Rebuild the board status projection", engine: "claude", model: "Opus", effort: "high", account: "Main",
      state: "working", elapsed: "12:40", age: "now", ctx: 29, crowned: true, tool: "Edit cardStatus.ts", worktree: "llv-212-status-projection",
      children: [{ title: "Explore: status readers", state: "done" }, { title: "Test writer", state: "working" }],
      feed: [
        { kind: "user", ts: "13:40", text: "Read issue 212 and tell me the smallest change that makes the board status honest about held deliveries." },
        { kind: "run", ts: "13:41–13:42", items: [{ tool: "Read", n: 2 }, { tool: "Grep", n: 1 }] },
        { kind: "agent", ts: "13:43", text: "The projection lives in one module that turns transcript facts into a card status. Held deliveries are read after the working state, so a held card renders as working. Swapping the precedence is a four-line change; the test that pins it is the real work.\n\nI will write the failing test first, then flip the order." },
        { kind: "runfail", ts: "13:57", items: [
          { tool: "Edit", detail: "CardStatusBadge.tsx", status: "ok", ts: "13:57", dur: "0.2s" },
          { tool: "Bash", detail: "bun test src/components/CardStatusBadge.render.test.tsx", status: "fail", ts: "13:58", dur: "4.1s", error: "1 fail · expected «held», received «working»" },
          { tool: "Edit", detail: "cardStatus.ts", status: "running", ts: "13:59", dur: "4s" },
        ] },
      ],
    },
    {
      id: "c2", project: "atlas", title: "Implement the export endpoint", engine: "codex", model: "gpt-5.6", effort: "high", account: "Main",
      state: "waiting", waitedFor: "9 min", age: "9 min", ctx: 41, worktree: "llv-218-export",
      pipeline: { id: "p1", stage: "build", k: 2, n: 5 },
      question: {
        header: "Export format", text: "Which format should the export endpoint default to when the client does not ask for one?",
        options: [
          { label: "NDJSON", hint: "One record per line, streams well, what the CLI already reads." },
          { label: "JSON array", hint: "Simplest for browsers, buffers the whole export." },
          { label: "Both, by header", hint: "Content negotiation; more code, more tests." },
        ],
        chips: ["NDJSON", "Both, by header", "Ask the orchestrator"],
      },
      feed: [
        { kind: "user", ts: "13:50", text: "Implement the export endpoint from the spec in issue 218. Ask before choosing a default format." },
        { kind: "run", ts: "13:51–13:55", items: [{ tool: "Read", n: 3 }, { tool: "Grep", n: 2 }, { tool: "Edit", n: 1 }] },
        { kind: "agent", ts: "13:56", text: "The route, the serializer and the test scaffold are in place. One decision is yours before I wire the default." },
      ],
    },
    {
      id: "c3", project: "atlas", title: "Archive TTL for closed pipelines", engine: "claude", model: "Sonnet", effort: "medium", account: "Main",
      state: "returned", age: "32 min", ctx: 18, worktree: "llv-206-archive-ttl",
      pipeline: { id: "p2", stage: "build", k: 1, n: 5 },
      feed: [
        { kind: "user", ts: "13:02", text: "Add a 14-day TTL to archived pipeline records and a test that proves the sweep runs once per tick." },
        { kind: "run", ts: "13:03–13:28", items: [{ tool: "Read", n: 4 }, { tool: "Edit", n: 3 }, { tool: "Bash", n: 2 }] },
        { kind: "agent", ts: "13:31", text: "Done. The sweep runs inside the existing controller cycle and the test pins one sweep per tick with fake timers. Branch pushed; the reviewer can take it." },
      ],
    },
    {
      id: "c4", project: "atlas", title: "Reviewer · archive TTL · round 2", engine: "codex", model: "gpt-5.6", effort: "xhigh", account: "Main",
      state: "working", elapsed: "4:02", age: "now", ctx: 12, tool: "Read src/lib/pipelines/store.ts",
      pipeline: { id: "p2", stage: "review", k: 3, n: 5 },
      feed: [
        { kind: "user", ts: "14:00", text: "Review round 2 of the archive TTL lane. Findings as strings." },
        { kind: "run", ts: "14:01–14:04", items: [{ tool: "Read", n: 6 }, { tool: "Grep", n: 2 }] },
      ],
    },
    {
      id: "c5", project: "atlas", title: "Migrate accounts to the new binding", engine: "claude", model: "Opus", effort: "high", account: "Main",
      state: "waiting", waitedFor: "24 min", age: "24 min", ctx: 33, plan: true, worktree: "llv-199-account-binding",
      question: { header: "Plan approval", text: "Approve the plan: rebind ownership only, never copy conversations; one migration record per account.", options: [{ label: "Approve", hint: "Start implementing this plan." }, { label: "Revise", hint: "Send the plan back with notes." }], chips: ["Approve", "Revise: keep the old ids readable"] },
      feed: [
        { kind: "user", ts: "13:30", text: "Plan the account migration for issue 199. Plan mode: do not edit yet." },
        { kind: "agent", ts: "13:41", text: "Plan ready. Three steps, one lane each: the binding record, the rebind command, the board projection. No conversation is ever copied." },
      ],
    },
    {
      id: "c6", project: "atlas", title: "Fast conversation switching", engine: "codex", model: "gpt-5.6", effort: "high", account: "Main",
      state: "done", age: "2h", ctx: 56, pipeline: { id: "p4", stage: "build", k: 1, n: 2 },
      feed: [
        { kind: "user", ts: "11:10", text: "Make switching between conversations feel instant." },
        { kind: "agent", ts: "12:05", text: "Cached feeds on switch, no board remount, in-app links. Measured: 38 ms median. Merged." },
      ],
    },
    { id: "c7", project: "atlas", title: "Explore: status readers", engine: "claude", model: "Sonnet", effort: "low", account: "Main", state: "done", age: "50 min", ctx: 8, child: "c1", feed: [{ kind: "user", ts: "13:44", text: "List every reader of cardStatus." }, { kind: "agent", ts: "13:46", text: "Eleven readers, listed with lines." }] },
    { id: "c8", project: "atlas", title: "Reviewer · archive TTL · round 1", engine: "codex", model: "gpt-5.6", effort: "xhigh", account: "Main", state: "done", age: "1h", ctx: 14, pipeline: { id: "p2", stage: "review", k: 3, n: 5 }, feed: [{ kind: "user", ts: "13:33", text: "Review round 1." }, { kind: "agent", ts: "13:52", text: "Request changes · 2 findings." }] },
    { id: "c9", project: "atlas", title: "Fix · archive TTL · round 1", engine: "claude", model: "Sonnet", effort: "high", account: "Main", state: "done", age: "45 min", ctx: 22, pipeline: { id: "p2", stage: "fix", k: 4, n: 5 }, feed: [{ kind: "user", ts: "13:53", text: "Apply the two findings." }, { kind: "agent", ts: "14:00", text: "Both applied, pushed." }] },
    { id: "c10", project: "atlas", title: "Design the export endpoint", engine: "claude", model: "Opus", effort: "high", account: "Main", state: "done", age: "1h", ctx: 30, pipeline: { id: "p1", stage: "plan", k: 1, n: 5 }, worktree: "pipeline/218-export", feed: [{ kind: "user", ts: "12:03", text: "Design the export endpoint for issue 218." }, { kind: "agent", ts: "12:40", text: "Design written to the declared output. NDJSON by default is my recommendation; the builder should ask." }] },
    { id: "c11", project: "atlas", title: "Verify · archive TTL", engine: "claude", model: "Sonnet", effort: "medium", account: "Main", state: "done", age: "55 min", ctx: 9, pipeline: { id: "p2", stage: "verify", k: 2, n: 5 }, feed: [{ kind: "user", ts: "13:29", text: "Run the suite by path." }, { kind: "agent", ts: "13:32", text: "Green: 14 files, 212 tests." }] },
    {
      id: "c12", project: "atlas", title: "Reviewer · seat handoff · round 3", engine: "claude", model: "Opus", effort: "xhigh", account: "Main",
      state: "working", elapsed: "1:12", age: "now", ctx: 6, tool: "Read src/lib/orchestrator/handoff.ts",
      pipeline: { id: "p6", stage: "review", k: 4, n: 7 },
      feed: [{ kind: "user", ts: "14:03", text: "Review round 3 of the seat handoff lane." }],
    },
    { id: "b1", project: "beacon", title: "Rewrite the pricing page copy", engine: "claude", model: "Sonnet", effort: "medium", account: "Lab", state: "working", elapsed: "6:10", age: "now", ctx: 31, tool: "Edit pricing.mdx", feed: [{ kind: "user", ts: "13:58", text: "Rewrite the pricing page in plain words." }] },
    { id: "k1", project: "corvid", title: "Release 2.4 checklist", engine: "codex", model: "gpt-5.6", effort: "high", account: "Main", state: "waiting", waitedFor: "41 min", age: "41 min", ctx: 20, pipeline: { id: "p5", stage: "build", k: 1, n: 2 }, question: { header: "Tag the release", text: "Tag v2.4.0 from main now, or wait for the docs lane?", options: [{ label: "Tag now", hint: "" }, { label: "Wait for docs", hint: "" }], chips: ["Tag now", "Wait for docs"] }, feed: [{ kind: "user", ts: "13:20", text: "Run the release checklist for 2.4." }] },
  ],

  pipelines: [
    {
      id: "p1", project: "atlas", task: "Implement the export endpoint (#218)", state: "running", revision: 14, started: "2h", branch: "pipeline/218-export",
      lastEdit: { actor: "orchestrator", at: "12 min", action: "edit-stage · review · reasoning xhigh" },
      cursor: { stageId: "build", attempt: 1 },
      stages: [
        { id: "plan", role: "architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", sandbox: "full", outputs: ["docs/design/218.md"], next: "build", onFail: null, attempts: [{ n: 1, state: "passed", conv: "c10", head: "a1f3c9" }], prompt: "Design the export endpoint. Write the design to the declared output and end with the verdict." },
        { id: "build", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "verify", onFail: null, attempts: [{ n: 1, state: "running", conv: "c2", head: "a1f3c9" }], prompt: "Implement the endpoint from the design. Ask before choosing a default format." },
        { id: "verify", role: "builder", engine: "codex", model: "gpt-5.6", effort: "medium", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [], prompt: "Run the suite by path and fix what you broke." },
        { id: "review", role: "reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", sandbox: "restricted", outputs: [], next: "publish", onFail: { to: "build", maxRounds: 3 }, attempts: [], prompt: "Review the diff against the pinned issue. Findings as strings.", pendingEdit: { fromRevision: 14, appliesFrom: 1 } },
        { id: "fix", role: "builder", engine: "claude", model: "Sonnet", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [], prompt: "Apply every finding. Push. Verdict." },
      ],
      findings: [],
      notes: [],
      checkpoints: [{ name: "before-review", sha: "a1f3c9", at: "13:50" }],
      mutations: [
        { seq: 1, at: "12:03", actor: "operator", action: "start", stage: null, effect: "applied", revision: 1 },
        { seq: 2, at: "13:12", actor: "orchestrator", action: "note", stage: "build", effect: "applied", revision: 12, detail: "prefer NDJSON unless the operator says otherwise" },
        { seq: 3, at: "13:50", actor: "controller", action: "checkpoint", stage: "build", effect: "applied", revision: 13, detail: "before-review" },
        { seq: 4, at: "13:53", actor: "orchestrator", action: "edit-stage", stage: "review", effect: "pending-next-attempt", revision: 14, detail: "reasoning high → xhigh" },
      ],
      waiting: null,
    },
    {
      id: "p2", project: "atlas", task: "Archive TTL for closed pipelines (#206)", state: "needs_decision", revision: 9, started: "3h", branch: "pipeline/206-archive-ttl",
      lastEdit: { actor: "operator", at: "1h", action: "set-edge · review · max rounds 3" },
      cursor: { stageId: "review", attempt: 2 },
      stages: [
        { id: "build", role: "builder", engine: "claude", model: "Sonnet", effort: "medium", access: "read-write", sandbox: "full", outputs: [], next: "verify", onFail: null, attempts: [{ n: 1, state: "passed", conv: "c3", head: "7be2d0" }], prompt: "Implement the TTL sweep." },
        { id: "verify", role: "builder", engine: "claude", model: "Sonnet", effort: "medium", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [{ n: 1, state: "passed", conv: "c11", head: "7be2d0" }], prompt: "Run the suite by path." },
        { id: "review", role: "reviewer", engine: "codex", model: "gpt-5.6", effort: "xhigh", access: "read-only", sandbox: "restricted", outputs: [], next: "publish", onFail: { to: "fix", maxRounds: 3 },
          attempts: [
            { n: 1, state: "failed", conv: "c8", head: "7be2d0", findings: ["The sweep has no test at all; add one that proves it runs once per tick.", "Archived records keep their worktree path; the TTL must clear it."] },
            { n: 2, state: "failed", conv: "c4", head: "9c41aa", findings: ["The sweep still runs on every poll, not once per controller tick (store.ts sweep call sits inside the read path).", "The TTL test asserts on wall-clock time; use the fake-timer clock the file already imports."] },
          ], prompt: "Review the diff. Findings as strings." },
        { id: "fix", role: "builder", engine: "claude", model: "Sonnet", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [{ n: 1, state: "passed", conv: "c9", head: "9c41aa" }], prompt: "Apply every finding." },
        { id: "publish", role: "builder", engine: "codex", model: "gpt-5.6", effort: "low", access: "read-write", sandbox: "full", outputs: [], next: null, onFail: null, attempts: [], prompt: "Open the pull request." },
      ],
      findings: ["The sweep still runs on every poll, not once per controller tick (store.ts sweep call sits inside the read path).", "The TTL test asserts on wall-clock time; use the fake-timer clock the file already imports."],
      notes: [],
      checkpoints: [],
      mutations: [
        { seq: 1, at: "11:02", actor: "operator", action: "start", stage: null, effect: "applied", revision: 1 },
        { seq: 2, at: "13:00", actor: "operator", action: "set-edge", stage: "review", effect: "applied", revision: 8, detail: "fail → fix · max rounds 3" },
        { seq: 3, at: "14:04", actor: "controller", action: "settle", stage: "review", effect: "applied", revision: 9, detail: "attempt 2 failed · round 2 of 3 used" },
      ],
      waiting: null,
    },
    {
      id: "p3", project: "atlas", task: "Directory picker keyboard support (#231)", state: "draft", revision: 0, started: null, branch: null, lastEdit: null,
      cursor: { stageId: "build", attempt: 0 },
      stages: [
        { id: "build", role: "builder", engine: "claude", model: "Sonnet", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [], prompt: "Implement keyboard navigation in the directory picker." },
        { id: "review", role: "reviewer", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-only", sandbox: "restricted", outputs: [], next: null, onFail: { to: "build", maxRounds: 2 }, attempts: [], prompt: "Review. Findings as strings." },
      ],
      findings: [], notes: [], checkpoints: [], mutations: [], waiting: null,
    },
    {
      id: "p4", project: "atlas", task: "Fast conversation switching (#209)", state: "completed", revision: 6, started: "5h", branch: "pipeline/209-switching", lastEdit: null,
      cursor: { stageId: "review", attempt: 1 },
      stages: [
        { id: "build", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [{ n: 1, state: "passed", conv: "c6", head: "0d8e11" }], prompt: "Make switching instant." },
        { id: "review", role: "reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", sandbox: "restricted", outputs: [], next: null, onFail: { to: "build", maxRounds: 3 }, attempts: [{ n: 1, state: "passed", conv: null, head: "0d8e11" }], prompt: "Review." },
      ],
      findings: [], notes: [], checkpoints: [], mutations: [{ seq: 1, at: "09:00", actor: "operator", action: "start", stage: null, effect: "applied", revision: 1 }], waiting: null,
    },
    {
      id: "p5", project: "corvid", task: "Release 2.4 (#88)", state: "running", revision: 3, started: "1h", branch: "pipeline/88-release", lastEdit: null,
      cursor: { stageId: "build", attempt: 1 },
      stages: [
        { id: "build", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [{ n: 1, state: "running", conv: "k1", head: "e4e4e4" }], prompt: "Run the release checklist." },
        { id: "review", role: "reviewer", engine: "claude", model: "Opus", effort: "high", access: "read-only", sandbox: "restricted", outputs: [], next: null, onFail: { to: "build", maxRounds: 2 }, attempts: [], prompt: "Review." },
      ],
      findings: [], notes: [], checkpoints: [], mutations: [], waiting: null,
    },
    /* A long record: seven stages, two fail edges, the review ↺ fix loop
       traversed twice and verify ↺ build once (critique round 1, F1). */
    {
      id: "p6", project: "atlas", task: "Seat handoff smoke test (#240)", state: "running", revision: 21, started: "4h", branch: "pipeline/240-seat-handoff",
      lastEdit: { actor: "controller", at: "2 min", action: "settle · fix · attempt 2 passed" },
      cursor: { stageId: "review", attempt: 3 },
      stages: [
        { id: "plan", role: "architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", sandbox: "full", outputs: ["docs/design/240.md"], next: "build", onFail: null, attempts: [{ n: 1, state: "passed", conv: null, head: "b0b0b0" }], prompt: "Design the smoke test." },
        { id: "build", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "verify", onFail: null, attempts: [{ n: 1, state: "passed", conv: null, head: "c1c1c1" }, { n: 2, state: "passed", conv: null, head: "d2d2d2" }], prompt: "Implement it." },
        { id: "verify", role: "builder", engine: "codex", model: "gpt-5.6", effort: "medium", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: { to: "build", maxRounds: 2 }, attempts: [{ n: 1, state: "failed", conv: null, head: "c1c1c1", findings: ["The smoke test leaves a host running after the run."] }, { n: 2, state: "passed", conv: null, head: "d2d2d2" }], prompt: "Run the suite by path." },
        { id: "review", role: "reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", sandbox: "restricted", outputs: [], next: "docs", onFail: { to: "fix", maxRounds: 3 },
          attempts: [
            { n: 1, state: "failed", conv: null, head: "d2d2d2", findings: ["The handoff test asserts on the successor's PID, which is not stable.", "No negative case: a refused handoff must leave the incumbent seated."] },
            { n: 2, state: "failed", conv: null, head: "e3e3e3", findings: ["The negative case passes for the wrong reason: the fixture never seats an incumbent."] },
            { n: 3, state: "running", conv: "c12", head: "f4f4f4" },
          ], prompt: "Review the diff against the pinned issue." },
        { id: "fix", role: "builder", engine: "claude", model: "Sonnet", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [{ n: 1, state: "passed", conv: null, head: "e3e3e3" }, { n: 2, state: "passed", conv: null, head: "f4f4f4" }], prompt: "Apply every finding." },
        { id: "docs", role: "builder", engine: "claude", model: "Sonnet", effort: "medium", access: "read-write", sandbox: "full", outputs: ["docs/orchestrator/handoff.md"], next: "publish", onFail: null, attempts: [], prompt: "Document the handoff contract." },
        { id: "publish", role: "builder", engine: "codex", model: "gpt-5.6", effort: "low", access: "read-write", sandbox: "full", outputs: [], next: null, onFail: null, attempts: [], prompt: "Open the pull request." },
      ],
      findings: [], notes: [{ seq: 1, text: "Keep the incumbent seated in the negative case." }], checkpoints: [{ name: "after-verify", sha: "d2d2d2", at: "12:10" }],
      mutations: [
        { seq: 1, at: "10:00", actor: "operator", action: "start", stage: null, effect: "applied", revision: 1 },
        { seq: 2, at: "11:20", actor: "controller", action: "settle", stage: "verify", effect: "applied", revision: 9, detail: "attempt 1 failed · round 1 of 2 used" },
        { seq: 3, at: "12:10", actor: "controller", action: "checkpoint", stage: "verify", effect: "applied", revision: 12, detail: "after-verify" },
        { seq: 4, at: "12:50", actor: "controller", action: "settle", stage: "review", effect: "applied", revision: 15, detail: "attempt 1 failed · round 1 of 3 used" },
        { seq: 5, at: "13:30", actor: "controller", action: "settle", stage: "review", effect: "applied", revision: 18, detail: "attempt 2 failed · round 2 of 3 used" },
        { seq: 6, at: "13:58", actor: "orchestrator", action: "note", stage: "review", effect: "applied", revision: 20, detail: "keep the incumbent seated in the negative case" },
        { seq: 7, at: "14:03", actor: "controller", action: "settle", stage: "fix", effect: "applied", revision: 21, detail: "attempt 2 passed" },
      ],
      waiting: null,
    },
  ],
};

/* Fixture mutations for the state screens. Each takes the fixture and edits
   it in place before the first render. */
window.SCENARIOS = {
  noseat(F) { F.seat.state = "none"; F.conversations = F.conversations.filter((c) => c.id !== "orch"); },
  degraded(F) { F.runtime = "degraded"; },
  offline(F) { F.runtime = "offline"; },
  held(F) { const c = F.conversations.find((x) => x.id === "c1"); c.state = "held"; c.heldCount = 2; },
  limit(F) { const c = F.conversations.find((x) => x.id === "c1"); c.state = "limit"; c.limitReset = "16:40"; F.accounts.claude[0].windows[0].left = 0; },
  stalled(F) { const c = F.conversations.find((x) => x.id === "c1"); c.state = "stalled"; c.stalledFor = "14 min"; },
  killed(F) { const c = F.conversations.find((x) => x.id === "c1"); c.state = "killed"; },
  arrival(F) { F.arrival = { id: "k1", project: "corvid", after: 400 }; },
  /* A decision arriving in the CURRENT project: the row appears with its edge,
     the counts pulse once, and no banner renders (critique round 1, F20). */
  "arrival-here"(F) {
    F.conversations.push({ id: "c13", project: "atlas", title: "Bound the journal file", engine: "codex", model: "gpt-5.6", effort: "high", account: "Main", state: "waiting", waitedFor: "now", age: "now", ctx: 12, arrivesLater: true,
      question: { header: "Journal bound", text: "Cap the journal at 200 MB or at 7 days?", options: [{ label: "200 MB", hint: "" }, { label: "7 days", hint: "" }], chips: ["200 MB", "7 days"] }, feed: [{ kind: "user", ts: "14:04", text: "Bound the journal." }] });
    F.arrival = { id: "c13", project: "atlas", after: 400 };
  },
  split(F) { F.pin = "orch"; },
  notasks(F) { F.project = "beacon"; },
  /* Every pinned group starts pinned so the frame shows the honoured move. */
  pinned(F) { F.pins = { p1: { x: 40, y: 380 } }; },
  crowded(F) {
    const engines = ["claude", "codex"]; const models = { claude: ["Opus", "Sonnet"], codex: ["gpt-5.6", "gpt-5.5"] };
    const states = ["working", "working", "returned", "done", "done", "done", "waiting"];
    for (let i = 0; i < 24; i++) {
      const engine = engines[i % 2]; const state = states[i % states.length];
      F.conversations.push({
        id: `x${i}`, project: "atlas", title: `Lane ${i + 10}: ${["tidy the feed cache", "rename the seat tick", "bound the journal", "index the search", "type the outbox", "gate the rasters"][i % 6]}`,
        engine, model: models[engine][i % 2], effort: "high", account: "Main", state, elapsed: state === "working" ? `${(i % 9) + 1}:${String((i * 7) % 60).padStart(2, "0")}` : undefined,
        waitedFor: state === "waiting" ? `${i + 2} min` : undefined, age: state === "working" ? "now" : `${(i * 11) % 59 + 1} min`, ctx: (i * 13) % 90, tool: state === "working" ? "Edit index.ts" : undefined,
        question: state === "waiting" ? { header: "Scope check", text: "Include the archive collection in this lane?", options: [{ label: "Yes", hint: "" }, { label: "No", hint: "" }], chips: ["Yes", "No"] } : undefined,
        feed: [{ kind: "user", ts: "13:00", text: "Do the lane." }],
      });
    }
    for (let i = 0; i < 7; i++) {
      const parked = i % 3 === 0; const worker = `x${(i * 3) % 24}`;
      F.pipelines.push({ id: `q${i}`, project: "atlas", task: `Lane ${i + 30}: ${["journal bound", "seat tick note", "search index", "outbox types", "raster gate", "feed cache", "rename seat"][i]} (#${300 + i})`, state: parked ? "needs_decision" : "running", revision: 2 + i, started: `${i + 1}h`, branch: `pipeline/${300 + i}`, lastEdit: null, cursor: { stageId: "build", attempt: 1 }, stages: [{ id: "build", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", outputs: [], next: "review", onFail: null, attempts: [{ n: 1, state: parked ? "failed" : "running", conv: worker, head: "abcdef", findings: parked ? ["One finding."] : undefined }], prompt: "Build." }, { id: "review", role: "reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", sandbox: "restricted", outputs: [], next: null, onFail: { to: "build", maxRounds: 3 }, attempts: [], prompt: "Review." }], findings: parked ? ["One finding."] : [], notes: [], checkpoints: [], mutations: [], waiting: null });
      const c = F.conversations.find((x) => x.id === worker); if (c) c.pipeline = { id: `q${i}`, stage: "build", k: 1, n: 2 };
    }
    for (let i = 0; i < 12; i++) {
      F.tasks.push({ id: `tx${i}`, title: `Lane ${i + 10}: ${["tidy the feed cache", "rename the seat tick", "bound the journal", "index the search", "type the outbox", "gate the rasters"][i % 6]}`, issue: 300 + i, status: ["now", "review", "blocked", "planned", "done"][i % 5], worker: i % 4 === 3 ? undefined : `x${i}`, pipeline: i < 7 ? `q${i}` : undefined });
    }
    for (let i = 0; i < 9; i++) F.projects.push({ id: `pr${i}`, name: `${["fjord", "gable", "harbor", "isle", "juniper", "kestrel", "lumen", "moraine", "nimbus"][i]}-app`, age: `${i + 1}h` });
    F.conversations.push({ id: "pr0a", project: "pr0", title: "Rotate the API keys", engine: "codex", model: "gpt-5.6", effort: "high", account: "Main", state: "working", elapsed: "3:10", age: "now", ctx: 10, tool: "Edit keys.ts", feed: [{ kind: "user", ts: "13:50", text: "Rotate." }] });
    F.conversations.push({ id: "pr4a", project: "pr4", title: "Tag the nightly build", engine: "claude", model: "Sonnet", effort: "medium", account: "Main", state: "waiting", waitedFor: "6 min", age: "6 min", ctx: 10, question: { header: "Tag", text: "Tag now?", options: [{ label: "Yes", hint: "" }, { label: "No", hint: "" }], chips: ["Yes"] }, feed: [{ kind: "user", ts: "13:55", text: "Tag." }] });
  },
};
