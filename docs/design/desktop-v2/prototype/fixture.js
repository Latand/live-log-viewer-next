/* Invented, identity-free fixture for the desktop-v2 prototype (issue #1453,
   rewrite). No real project, account, handle, path or id appears here; every
   name is made up and every number is illustrative. The vocabulary is the
   mobile-v2 one (docs/design/mobile-v2/prototype/fixture.js): one state word
   per conversation, `low · medium · high · xhigh · max`, badges in the
   product's words. Pipelines carry the automation-v2 fields the inspector
   reads (revision, per-stage attempts with findings, fail edges with round
   budgets).

   Project counts are never typed: the prototype derives every count from the
   conversations, pipelines and tasks below, so the rail, the bar and the
   overview cannot disagree.

   SCENARIOS at the end mutate this fixture for the state screens
   (`?scenario=crowded|noseat|degraded|offline|pinned|arrival|limit|killed`). */

window.FIXTURE = (function () {
  const F = {
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

    /* One seat per project that has one. */
    seats: {
      atlas: {
        state: "live", engine: "claude", model: "Opus", effort: "high", account: "Main", plan: "Max plan",
        ctx: { left: 76, window: "100k" }, since: "2h", conv: "seat", predecessor: true, mandateVersion: 3,
        mandate: "You are the atlas orchestrator. Open one lane per issue, spawn an implementer, run a fresh reviewer every round, merge on APPROVE, and report what landed. Nothing starts until the operator asks for it. Deploy only when told; every deploy kills this seat, so report first.",
      },
      beacon: { state: "live", engine: "codex", model: "gpt-5.6", effort: "high", account: "Main", plan: "Plus", ctx: { left: 41, window: "200k" }, since: "5h", conv: "seat-beacon", mandateVersion: 1, mandate: "You are the beacon-site orchestrator." },
    },

    /* Conversations. `parent` is lineage (a spawned child); `pipeline` binds a
       stage attempt; `task` binds a board task's worker. `feed` is the
       transcript the chat stage renders. */
    conversations: [
      { id: "seat", project: "atlas", seat: true, title: "atlas orchestrator", engine: "claude", model: "Opus", effort: "high", state: "working", elapsed: "2:14", tool: "list_conversations",
        feed: [
          { kind: "agent", at: "13:33", text: "Ready in atlas.\nTell me what to ship. I open lanes, spawn implementers and reviewers, and merge on APPROVE. Nothing starts until you ask." },
          { kind: "user", at: "13:34", text: "Take #218 and #206. Fresh reviewer every round." },
          { kind: "agent", at: "13:34", text: "Two lanes opened. #218 is building; #206 is in review and its reviewer failed round 2 with two findings, so it is parked for your decision." },
          { kind: "tool", tool: "viewer · list_conversations", status: "running", at: "14:05" },
        ] },
      { id: "c1", project: "atlas", title: "Build the export endpoint", engine: "codex", model: "gpt-5.6", effort: "high", state: "working", elapsed: "12:40", tool: "Read src/lib/export/route.ts", pipeline: { id: "p1", stage: "build" },
        feed: [
          { kind: "user", at: "13:52", text: "Implement the export endpoint per the architect's plan. Keep the response streaming." },
          { kind: "agent", at: "13:53", text: "Reading the plan and the existing route handlers first." },
          { kind: "tool", tool: "Read src/lib/export/plan.md", status: "done", at: "13:53" },
          { kind: "tool", tool: "Read src/app/api/export/route.ts", status: "done", at: "13:54" },
          { kind: "agent", at: "13:58", text: "The route already streams for CSV. I will add the JSON lines branch behind the same iterator and cover both with the route test." },
          { kind: "tool", tool: "Edit src/app/api/export/route.ts", status: "done", at: "14:01" },
          { kind: "tool", tool: "bun test src/app/api/export/route.test.ts", status: "done", at: "14:03", out: "12 pass · 0 fail" },
          { kind: "tool", tool: "Read src/lib/export/route.ts", status: "running", at: "14:05" },
        ] },
      { id: "c2", project: "atlas", title: "Hero framing for the README", engine: "claude", model: "Sonnet", effort: "medium", state: "waiting", decision: "a question", since: "9 min", task: "t3",
        question: { title: "Choose the hero framing", options: [["Compact feed", "Make command cards and the patch fill the frame."], ["Balanced board", "Keep the parentage tree visible beside the live feed."], ["Overview first", "Lead with the cross-project status board."]] },
        feed: [
          { kind: "user", at: "13:40", text: "Prepare the README hero framing and ask me to choose the final composition." },
          { kind: "agent", at: "13:41", text: "The fixture is ready. One framing decision remains before the media pass continues." },
          { kind: "tool", tool: "AskUserQuestion", status: "running", at: "13:56" },
        ] },
      { id: "c3", project: "atlas", title: "Design the export endpoint", engine: "claude", model: "Opus", effort: "high", state: "done", age: "1h", pipeline: { id: "p1", stage: "plan" },
        feed: [{ kind: "user", at: "12:50", text: "Design the export endpoint." }, { kind: "agent", at: "13:20", text: "Plan written to src/lib/export/plan.md: one streaming iterator, two encoders, one route test per encoder." }] },
      { id: "c4", project: "atlas", title: "Fix the flaky scanner test", engine: "claude", model: "Sonnet", effort: "high", state: "returned", age: "6 min",
        feed: [{ kind: "user", at: "13:30", text: "Fix the flaky scanner test." }, { kind: "agent", at: "13:59", text: "The race was the temp dir being reused across cases. Isolated per test; 40 green runs in a row. Ready for review." }] },
      { id: "c5", project: "atlas", parent: "c4", title: "Explore: where the temp dir is created", engine: "claude", model: "Haiku", effort: "low", state: "done", age: "22 min", feed: [{ kind: "agent", at: "13:43", text: "Three call sites, one shared constant." }] },
      { id: "c6", project: "atlas", parent: "c4", title: "Run the scanner suite 40 times", engine: "claude", model: "Sonnet", effort: "low", state: "working", elapsed: "3:05", tool: "bun test src/lib/scanner", feed: [{ kind: "tool", tool: "bun test src/lib/scanner", status: "running", at: "14:02" }] },
      { id: "c7", project: "atlas", title: "Release 2.4 checklist", engine: "codex", model: "gpt-5.6", effort: "medium", state: "returned", age: "24 min", feed: [{ kind: "agent", at: "13:41", text: "Checklist drafted with the twelve items from the last release and two new ones for the runtime host." }] },
      { id: "c8", project: "atlas", title: "Investigate memory growth in the host", engine: "codex", model: "gpt-5.6", effort: "xhigh", state: "stalled", stalled: "40 min", feed: [{ kind: "agent", at: "13:25", text: "Heap snapshots taken at 10-minute intervals." }] },
      { id: "c9", project: "atlas", title: "Refactor the limits footer", engine: "claude", model: "Opus", effort: "high", state: "limit", limit: { account: "Main", resets: "16:00" }, feed: [{ kind: "agent", at: "13:12", text: "Half the footer moved into the accounts model." }] },
      /* p2's stage conversations. */
      { id: "c10", project: "atlas", title: "Plan the archive TTL", engine: "claude", model: "Opus", effort: "high", state: "done", age: "3h", pipeline: { id: "p2", stage: "plan" }, feed: [{ kind: "agent", at: "11:05", text: "TTL of 14 days after close, sweep on host start and hourly." }] },
      { id: "c11", project: "atlas", title: "Build the archive TTL", engine: "codex", model: "gpt-5.6", effort: "high", state: "done", age: "2h", pipeline: { id: "p2", stage: "build", attempt: 1 }, feed: [{ kind: "agent", at: "12:10", text: "Sweep implemented behind the store." }] },
      { id: "c12", project: "atlas", title: "Build the archive TTL · round 2", engine: "codex", model: "gpt-5.6", effort: "high", state: "done", age: "50 min", pipeline: { id: "p2", stage: "build", attempt: 2 }, feed: [{ kind: "agent", at: "13:15", text: "Both findings addressed: the sweep skips restored pipelines and the TTL is a setting." }] },
      { id: "c13", project: "atlas", title: "Review the archive TTL", engine: "claude", model: "Opus", effort: "xhigh", state: "done", age: "1h", pipeline: { id: "p2", stage: "review", attempt: 1 }, feed: [{ kind: "agent", at: "12:40", text: "REQUEST_CHANGES · 2 findings." }] },
      { id: "c14", project: "atlas", title: "Review the archive TTL · round 2", engine: "claude", model: "Opus", effort: "xhigh", state: "done", age: "31 min", pipeline: { id: "p2", stage: "review", attempt: 2 }, feed: [{ kind: "agent", at: "13:34", text: "REQUEST_CHANGES · 2 findings. The sweep still touches restored pipelines when the flag is set after close." }] },
      /* p5: a running review loop in round 2. */
      { id: "c15", project: "atlas", title: "Migrate accounts to the new binding", engine: "codex", model: "gpt-5.6", effort: "high", state: "done", age: "35 min", pipeline: { id: "p5", stage: "build", attempt: 2 }, feed: [{ kind: "agent", at: "13:30", text: "Rebinding done; the old path resolver is deleted." }] },
      { id: "c16", project: "atlas", title: "Review the account migration · round 2", engine: "claude", model: "Opus", effort: "xhigh", state: "working", elapsed: "8:12", tool: "Read src/lib/accounts/binding.ts", pipeline: { id: "p5", stage: "review", attempt: 2 }, feed: [{ kind: "tool", tool: "Read src/lib/accounts/binding.ts", status: "running", at: "14:04" }] },
      { id: "c17", project: "atlas", title: "Plan the account migration", engine: "claude", model: "Opus", effort: "high", state: "done", age: "2h", pipeline: { id: "p5", stage: "plan" }, feed: [{ kind: "agent", at: "12:00", text: "Plan written." }] },
      /* Other projects. */
      { id: "seat-beacon", project: "beacon", seat: true, title: "beacon-site orchestrator", engine: "codex", model: "gpt-5.6", effort: "high", state: "returned", age: "14 min", feed: [{ kind: "agent", at: "13:51", text: "Nothing owed. Two lanes idle." }] },
      { id: "b1", project: "beacon", title: "Rebuild the pricing page", engine: "claude", model: "Sonnet", effort: "high", state: "working", elapsed: "31:02", tool: "Edit src/pages/pricing.tsx", feed: [{ kind: "tool", tool: "Edit src/pages/pricing.tsx", status: "running", at: "14:04" }] },
      { id: "b2", project: "beacon", title: "Lighthouse pass on the landing page", engine: "codex", model: "gpt-5.6", effort: "medium", state: "returned", age: "12 min", feed: [{ kind: "agent", at: "13:53", text: "Score 96. Two images still lack dimensions." }] },
      { id: "b3", project: "beacon", title: "Write the changelog", engine: "claude", model: "Haiku", effort: "low", state: "done", age: "3h", feed: [{ kind: "agent", at: "11:00", text: "Done." }] },
      { id: "k1", project: "corvid", title: "Nightly index rebuild", engine: "codex", model: "gpt-5.6", effort: "high", state: "waiting", decision: "plan approval", since: "41 min", feed: [{ kind: "agent", at: "13:24", text: "Plan: rebuild in two passes. Approve?" }], question: { title: "Approve the rebuild plan", options: [["Approve", "Two passes, nightly."], ["Change", "Tell me what to change."]] } },
      { id: "k2", project: "corvid", title: "Deduplicate the crawl queue", engine: "claude", model: "Opus", effort: "high", state: "working", elapsed: "1:02:10", tool: "bun test", feed: [{ kind: "tool", tool: "bun test", status: "running", at: "14:00" }] },
      { id: "d1", project: "delta", title: "Ledger export to CSV", engine: "claude", model: "Sonnet", effort: "medium", state: "done", age: "2d", feed: [{ kind: "agent", at: "09:00", text: "Shipped." }] },
    ],

    /* Pipelines carry the automation-v2 record fields the inspector reads. */
    pipelines: [
      { id: "p1", project: "atlas", task: "Implement the export endpoint", issue: 218, taskId: "t1", state: "running", stage: "build", since: "1h", revision: 4, branch: "pipeline/export-endpoint-p1",
        stages: [
          { id: "plan", role: "Architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", kind: "run", attempts: [{ n: 1, state: "passed", conv: "c3", sha: "a1f3c9" }] },
          { id: "build", role: "Builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", kind: "run", attempts: [{ n: 1, state: "running", conv: "c1", sha: "a1f3c9" }] },
          { id: "verify", role: "Verifier", engine: "claude", model: "Sonnet", effort: "high", access: "read-only", kind: "run", onFail: { to: "build", maxRounds: 3 }, attempts: [] },
          { id: "review", role: "Reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 3 }, attempts: [] },
          { id: "ship", role: "Deployer", engine: "codex", model: "gpt-5.6", effort: "medium", access: "read-write", kind: "run", attempts: [] },
        ],
        log: [["rev 4", "note", "review", "operator", "«check the streaming path»"], ["rev 3", "edit-stage", "review", "seat", "reasoning high → xhigh"], ["rev 2", "start", "plan", "seat", "attempt 1 spawned"]] },
      { id: "p2", project: "atlas", task: "Archive TTL for closed pipelines", issue: 206, taskId: "t2", state: "needs_decision", stage: "review", since: "31 min", revision: 9, branch: "pipeline/archive-ttl-p2",
        stages: [
          { id: "plan", role: "Architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", kind: "run", attempts: [{ n: 1, state: "passed", conv: "c10", sha: "7be2d0" }] },
          { id: "build", role: "Builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", kind: "run", attempts: [{ n: 1, state: "passed", conv: "c11", sha: "7be2d0" }, { n: 2, state: "passed", conv: "c12", sha: "9c41aa" }] },
          { id: "verify", role: "Verifier", engine: "claude", model: "Sonnet", effort: "high", access: "read-only", kind: "run", onFail: { to: "build", maxRounds: 3 }, attempts: [{ n: 1, state: "passed", conv: null, sha: "7be2d0" }, { n: 2, state: "passed", conv: null, sha: "9c41aa" }] },
          { id: "review", role: "Reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 3 }, attempts: [
            { n: 1, state: "failed", conv: "c13", sha: "7be2d0", findings: ["The sweep deletes pipelines the operator restored after close.", "The TTL is a constant; the spec asks for a setting."] },
            { n: 2, state: "failed", conv: "c14", sha: "9c41aa", findings: ["The sweep still touches a restored pipeline when the flag is set after the close.", "No test covers a close followed by a restore inside the TTL window."] },
          ] },
        ],
        log: [["rev 9", "park", "review", "engine", "round 2 of 3 failed · 2 findings"], ["rev 8", "fail-edge", "review → build", "engine", "round 2 of 3 used"], ["rev 5", "fail-edge", "review → build", "engine", "round 1 of 3 used"]] },
      { id: "p3", project: "atlas", task: "Speed up the board scan", issue: 231, taskId: "t4", state: "draft", stage: "plan", since: "5 min", revision: 1, branch: "pipeline/board-scan-p3",
        stages: [
          { id: "plan", role: "Architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", kind: "run", attempts: [] },
          { id: "build", role: "Builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", kind: "run", attempts: [] },
          { id: "review", role: "Reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 3 }, attempts: [] },
        ], log: [["rev 1", "create", "—", "operator", "draft from the review-loop template"]] },
      { id: "p4", project: "atlas", task: "Rename the switchboard", issue: 199, taskId: "t5", state: "completed", stage: "review", since: "yesterday", revision: 6, branch: "pipeline/rename-p4",
        stages: [
          { id: "build", role: "Builder", engine: "codex", model: "gpt-5.6", effort: "medium", access: "read-write", kind: "run", attempts: [{ n: 1, state: "passed", conv: null, sha: "31d0aa" }] },
          { id: "review", role: "Reviewer", engine: "claude", model: "Opus", effort: "high", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 2 }, attempts: [{ n: 1, state: "passed", conv: null, sha: "31d0aa" }] },
        ], log: [["rev 6", "complete", "review", "engine", "APPROVE · merged"]] },
      { id: "p5", project: "atlas", task: "Migrate accounts to the new binding", issue: 214, taskId: "t8", state: "running", stage: "review", since: "2h", revision: 7, branch: "pipeline/accounts-binding-p5",
        stages: [
          { id: "plan", role: "Architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", kind: "run", attempts: [{ n: 1, state: "passed", conv: "c17", sha: "c0ffee" }] },
          { id: "build", role: "Builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", kind: "run", attempts: [{ n: 1, state: "passed", conv: null, sha: "c0ffee" }, { n: 2, state: "passed", conv: "c15", sha: "d4d4d4" }] },
          { id: "review", role: "Reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 3 }, attempts: [{ n: 1, state: "failed", conv: null, sha: "c0ffee", findings: ["The resolver keeps a path fallback the spec retires."] }, { n: 2, state: "running", conv: "c16", sha: "d4d4d4" }] },
        ], log: [["rev 7", "fail-edge", "review → build", "engine", "round 1 of 3 used"]] },
      { id: "bp1", project: "beacon", task: "Ship the pricing page", issue: 77, taskId: "bt1", state: "running", stage: "build", since: "31 min", revision: 2, branch: "pipeline/pricing-bp1",
        stages: [
          { id: "build", role: "Builder", engine: "claude", model: "Sonnet", effort: "high", access: "read-write", kind: "run", attempts: [{ n: 1, state: "running", conv: "b1", sha: "e1e1e1" }] },
          { id: "review", role: "Reviewer", engine: "codex", model: "gpt-5.6", effort: "xhigh", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 3 }, attempts: [] },
        ], log: [] },
    ],

    /* Board tasks (#1466 readiness vocabulary: now · review · blocked · planned · done). */
    tasks: [
      { id: "t1", project: "atlas", title: "Implement the export endpoint", issue: 218, status: "assigned", pipeline: "p1" },
      { id: "t2", project: "atlas", title: "Archive TTL for closed pipelines", issue: 206, status: "blocked", pipeline: "p2" },
      { id: "t3", project: "atlas", title: "README hero framing", issue: null, status: "assigned", worker: "c2" },
      { id: "t4", project: "atlas", title: "Speed up the board scan", issue: 231, status: "inbox", pipeline: "p3" },
      { id: "t5", project: "atlas", title: "Rename the switchboard", issue: 199, status: "done", pipeline: "p4" },
      { id: "t6", project: "atlas", title: "Write the 2.4 release notes", issue: 240, status: "inbox" },
      { id: "t7", project: "atlas", title: "Audit the demo fixture for stray values", issue: 236, status: "inbox" },
      { id: "t8", project: "atlas", title: "Migrate accounts to the new binding", issue: 214, status: "assigned", pipeline: "p5" },
      { id: "t9", project: "atlas", title: "Flaky scanner test", issue: 229, status: "assigned", worker: "c4" },
      { id: "bt1", project: "beacon", title: "Ship the pricing page", issue: 77, status: "assigned", pipeline: "bp1" },
      { id: "bt2", project: "beacon", title: "Image dimensions on the landing page", issue: 80, status: "inbox" },
    ],

    /* Accounts. Every window: what is left, the window length in hours, the
       hours elapsed in it, the reset clock, and the burndown series (hours in
       the window → % left) the detail charts. */
    accounts: {
      claude: [
        { id: "cl-main", label: "Main", plan: "Max plan", auth: "Authenticated", active: true, checked: "14:00",
          windows: [
            { label: "5 h", left: 38, hours: 5, elapsed: 3.2, reset: "resets 16:00", series: [[0, 100], [0.5, 92], [1, 81], [1.5, 74], [2, 62], [2.5, 51], [3, 42], [3.2, 38]] },
            { label: "Week", left: 61, hours: 168, elapsed: 96, reset: "resets Mon 09:00", series: [[0, 100], [24, 91], [48, 80], [72, 70], [96, 61]] },
          ], hourly: [["09", 4], ["10", 9], ["11", 12], ["12", 7], ["13", 14], ["14", 6]] },
        { id: "cl-lab", label: "Lab", plan: "Max plan", auth: "Authenticated", active: false, checked: "13:50",
          windows: [
            { label: "5 h", left: 91, hours: 5, elapsed: 1.5, reset: "resets 17:35", series: [[0, 100], [0.5, 98], [1, 94], [1.5, 91]] },
            { label: "Week", left: 84, hours: 168, elapsed: 60, reset: "resets Tue 11:00", series: [[0, 100], [24, 96], [48, 89], [60, 84]] },
          ], hourly: [["11", 2], ["12", 3], ["13", 4]] },
        { id: "cl-second", label: "Second", plan: "Pro plan", auth: "Signed out", active: false, checked: null, windows: [], hourly: [] },
      ],
      codex: [
        { id: "cx-main", label: "Main", plan: "Plus", auth: "Authenticated", active: true, checked: "13:58",
          windows: [
            { label: "5 h", left: 55, hours: 5, elapsed: 2.4, reset: "resets 16:40", series: [[0, 100], [0.5, 96], [1, 87], [1.5, 76], [2, 63], [2.4, 55]] },
            { label: "Week", left: 70, hours: 168, elapsed: 80, reset: "resets Sun 22:00", series: [[0, 100], [24, 94], [48, 85], [72, 74], [80, 70]] },
          ], hourly: [["10", 5], ["11", 8], ["12", 11], ["13", 10], ["14", 8]], resets: { available: 1, expires: "21 Sep" } },
        { id: "cx-team", label: "Team", plan: "Business", auth: "Authenticated", active: false, checked: "13:40",
          windows: [
            { label: "5 h", left: 12, hours: 5, elapsed: 4.1, reset: "resets 15:00", series: [[0, 100], [1, 82], [2, 60], [3, 38], [4, 16], [4.1, 12]] },
            { label: "Week", left: 40, hours: 168, elapsed: 120, reset: "resets Fri 08:00", series: [[0, 100], [48, 78], [96, 55], [120, 40]] },
          ], hourly: [["09", 12], ["10", 16], ["11", 20], ["12", 18], ["13", 14]], resets: { available: 0, expires: null } },
      ],
    },

    host: {
      tasks: [{ name: "runtime host", pid: 41772, mem: "610 MB", age: "3d" }, { name: "scanner", pid: 41790, mem: "84 MB", age: "3d" }, { name: "transcribe worker", pid: 52210, mem: "1.2 GB", age: "2h" }],
      hidden: [{ id: "h1", title: "Old switchboard reviewer" }, { id: "h2", title: "Docs typo sweep" }],
      lastSeen: "14:04",
    },
  };

  /* ── Scenarios ──────────────────────────────────────────────────────────── */
  F.scenarios = {
    noseat(f) { delete f.seats.atlas; f.conversations = f.conversations.filter((c) => c.id !== "seat"); },
    degraded(f) { f.runtime = "degraded"; },
    offline(f) { f.runtime = "offline"; },
    pinned(f) { f.pins = { p2: { x: 1460, y: 520 } }; },
    arrival(f) { f.arrival = { conv: "k1" }; },
    limit(f) { const c = f.conversations.find((x) => x.id === "c1"); c.state = "limit"; c.limit = { account: "Main", resets: "16:00" }; f.accounts.claude[0].windows[0].left = 0; f.accounts.claude[0].windows[0].series.push([3.3, 0]); },
    killed(f) { f.killed = ["c1"]; },
    crowded(f) {
      const engines = ["claude", "codex"], models = { claude: ["Opus", "Sonnet", "Haiku"], codex: ["gpt-5.6", "gpt-5.5"] };
      const states = ["working", "working", "returned", "done", "waiting", "working", "done", "stalled", "returned", "done"];
      const verbs = ["Refactor", "Migrate", "Profile", "Document", "Harden", "Split", "Instrument", "Retire", "Rename", "Backfill"];
      const nouns = ["the scanner", "the outbox", "the seat tick", "the deploy gate", "the search index", "the feed parser", "the limits cache", "the task store", "the presence bus", "the journal"];
      for (let i = 0; i < 30; i++) {
        const engine = engines[i % 2]; const state = states[i % states.length];
        const c = { id: `x${i}`, project: "atlas", title: `${verbs[i % 10]} ${nouns[(i * 3) % 10]}`, engine, model: models[engine][i % models[engine].length], effort: ["low", "medium", "high"][i % 3], state, feed: [{ kind: "agent", at: "13:00", text: "Working." }] };
        if (state === "working") { c.elapsed = `${(i % 50) + 1}:0${i % 9}`; c.tool = "bun test"; }
        if (state === "waiting") { c.decision = i % 2 ? "a question" : "plan approval"; c.since = `${i + 2} min`; c.question = { title: "Proceed?", options: [["Yes", "Go ahead."], ["No", "Stop here."]] }; }
        if (state === "stalled") c.stalled = `${i + 10} min`;
        if (state === "returned" || state === "done") c.age = `${i + 1} min`;
        if (i % 7 === 3) c.parent = `x${i - 1}`;
        f.conversations.push(c);
      }
      for (let i = 0; i < 10; i++) {
        const id = `q${i}`; const st = ["running", "running", "needs_decision", "running", "draft", "completed", "running", "paused", "running", "needs_decision"][i];
        const conv = f.conversations.find((c) => c.id === `x${i * 3}`);
        f.pipelines.push({ id, project: "atlas", task: `${verbs[(i * 7) % 10]} ${nouns[(i * 7 + 1) % 10]}`, issue: 300 + i, taskId: null, state: st, stage: st === "draft" ? "plan" : "build", since: `${i * 9 + 4} min`, revision: 2, branch: `pipeline/q${i}`,
          stages: [
            { id: "plan", role: "Architect", engine: "claude", model: "Opus", effort: "high", access: "read-only", kind: "run", attempts: st === "draft" ? [] : [{ n: 1, state: "passed", conv: null, sha: "ab12cd" }] },
            { id: "build", role: "Builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", kind: "run", attempts: st === "draft" ? [] : [{ n: 1, state: st === "needs_decision" ? "failed" : st === "completed" ? "passed" : "running", conv: conv ? conv.id : null, sha: "ab12cd", findings: st === "needs_decision" ? ["The builder changed the schema without a migration."] : undefined }] },
            { id: "review", role: "Reviewer", engine: "claude", model: "Opus", effort: "xhigh", access: "read-only", kind: "review", onFail: { to: "build", maxRounds: 3 }, attempts: st === "completed" ? [{ n: 1, state: "passed", conv: null, sha: "ab12cd" }] : [] },
          ], log: [] });
        if (conv) conv.pipeline = { id, stage: "build" };
      }
      for (let i = 0; i < 9; i++) f.projects.push({ id: `pr${i}`, name: ["falcon", "granite", "harbor", "isotope", "juniper", "kestrel", "lumen", "mesa", "nimbus"][i], age: `${i + 1}h`, quiet: i > 4 });
      for (let i = 0; i < 12; i++) f.tasks.push({ id: `tt${i}`, project: "atlas", title: `${verbs[(i * 3) % 10]} ${nouns[(i * 5) % 10]}`, issue: 400 + i, status: i % 3 ? "inbox" : "done" });
    },
  };
  return F;
})();
