/* Invented, identity-free fixture for the mobile-v2 prototype (issue #1439).
   No real project, account, handle, path or id appears here; every name is
   made up and every number is illustrative.

   The attention queue is derived (a conversation waiting on a decision, a
   pipeline in needs_decision), not listed. SCENARIOS at the end mutate this
   fixture for the failure-state screens (`?scenario=held`, …). */

window.FIXTURE = {
  project: { id: "atlas", name: "atlas" },

  projects: [
    { id: "atlas", name: "atlas", live: 3, attention: 3, crowned: true, current: true },
    { id: "beacon", name: "beacon-site", live: 1, attention: 0 },
    { id: "corvid", name: "corvid-tools", live: 0, attention: 1 },
    { id: "delta", name: "delta-ledger", live: 0, attention: 0, quiet: "2d" },
  ],
  archivedProjects: [{ id: "ember", name: "ember-legacy" }],

  /* The orchestrator seat for the project (PRD #976 / #979 / #1347). */
  seat: {
    state: "live",
    engine: "claude",
    model: "Opus",
    effort: "high",
    account: "Main",
    plan: "Max plan",
    ctx: { used: 24, usedLabel: "24k", window: "100k" },
    predecessor: true,
    since: "2h",
    mandateVersion: 3,
    mandate:
      "You are the atlas orchestrator.\n\nYou own this board and you talk to me here, directly, whenever you have something worth saying.\n\n## What you do\n- one lane per issue, one owner per file\n- a fresh reviewer every round\n- merge only on APPROVE with green gates\n- never deploy red",
    rotation: null,
  },

  conversations: [
    {
      id: "orch",
      title: "Orchestrator · atlas",
      engine: "claude",
      model: "Opus",
      effort: "high",
      state: "working",
      elapsed: "2:14",
      age: "now",
      seat: true,
      account: "Main",
      ctx: 24,
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
      id: "c1",
      title: "Rebuild the board status projection",
      engine: "claude",
      model: "Opus",
      effort: "high",
      state: "working",
      elapsed: "12:40",
      age: "now",
      account: "Main",
      ctx: 71,
      worktree: "lane/212-board-status",
      pipeline: { id: "p1", stage: 1 },
      feed: [
        { kind: "user", ts: "13:41", text: "Read issue 212 and tell me which file owns the status projection before you change anything." },
        { kind: "group", count: 3, parts: "Read ×2 · Grep", range: "13:41–13:42" },
        { kind: "agent", ts: "13:43", text: "The projection lives in one module that turns a conversation's delivery, liveness and turn state into the card's status word. The badge component only renders what it is given." },
        { kind: "user", ts: "13:50", text: "Rebuild the board status projection so held lanes read as held, and keep the tests by path." },
        { kind: "agent", ts: "13:50", text: "Reading the projection first, then the card vocabulary it feeds." },
        { kind: "group", count: 6, parts: "Read ×4 · Grep ×2", range: "13:50–13:52" },
        {
          kind: "agent",
          ts: "13:53",
          text: "The projection derives held from the delivery outbox, so a lane whose message is still queued shows as working. I am adding a held precedence ahead of the running check and a test for the queued-but-held case.",
        },
        { kind: "tool", tool: "Edit src/components/CardStatusBadge.tsx", status: "ok", dur: "0.2s", ts: "13:57" },
        { kind: "tool", tool: "Bash bun test src/components/CardStatusBadge.render.test.tsx", status: "error", dur: "4.1s", ts: "13:58", detail: "1 fail · expected «held», received «working»" },
        { kind: "tool", tool: "Edit src/components/cardStatus.ts", status: "running", dur: "4s" },
      ],
    },
    {
      id: "c2",
      title: "Implement the export endpoint",
      engine: "codex",
      model: "gpt-5.6",
      effort: "high",
      state: "waiting",
      decision: "a question",
      since: "9 min",
      age: "9 min",
      account: "Main",
      ctx: 18,
      question: {
        text: "Which format should the export endpoint default to?",
        options: [
          "NDJSON — streams, matches the import path",
          "JSON array — simpler for the spreadsheet import",
          "Both, chosen by the Accept header",
        ],
      },
      suggested: ["NDJSON", "Both, by header", "Ask the orchestrator"],
      feed: [
        { kind: "user", ts: "13:51", text: "Implement the export endpoint for ledger rows. Stream when the set is large." },
        { kind: "group", count: 9, parts: "Read ×5 · Grep ×3 · Bash", range: "13:51–13:54" },
        {
          kind: "agent",
          ts: "13:55",
          text: "Two ways to shape it. NDJSON streams row by row and matches the import path we already have. A JSON array is one document, which the spreadsheet import expects. I can serve both from the Accept header, at the cost of a second serializer.",
        },
      ],
    },
    {
      id: "c6",
      title: "Migrate accounts to the new binding",
      engine: "claude",
      model: "Opus",
      effort: "xhigh",
      state: "waiting",
      decision: "plan approval",
      since: "25 min",
      age: "25 min",
      account: "Main",
      ctx: 33,
      feed: [
        { kind: "user", ts: "13:30", text: "Plan the account binding migration. Do not touch the registry until I approve the plan." },
        { kind: "agent", ts: "13:34", text: "Plan: 1) add the binding column behind a flag, 2) backfill from the seat records, 3) flip reads, 4) drop the legacy lookup. Steps 1–2 are reversible; 3 is the cutover." },
      ],
    },
    {
      id: "c5",
      title: "Fix the flaky reseat test",
      engine: "claude",
      model: "Sonnet",
      effort: "low",
      state: "working",
      elapsed: "3:05",
      age: "now",
      account: "Main",
      ctx: 12,
      pipeline: { id: "p2", stage: 2 },
      feed: [
        { kind: "user", ts: "13:56", text: "The reseat test is flaky on a busy box. Find the race, fix it, keep the assertion." },
        { kind: "agent", ts: "13:56", text: "Running it ten times first to see the failure shape." },
        { kind: "tool", tool: "Bash bun test src/lib/accounts/reseat.test.ts", status: "running", dur: "41s" },
      ],
    },
    {
      id: "c9",
      title: "Review · Mobile redesign prototype · round 1",
      engine: "codex",
      model: "gpt-5.6",
      effort: "high",
      state: "working",
      elapsed: "6:12",
      age: "now",
      account: "Main",
      ctx: 22,
      pipeline: { id: "p1", stage: 2 },
      feed: [
        { kind: "user", ts: "13:52", text: "Review the design at its head commit against the pinned requirement. Findings as plain strings." },
        { kind: "group", count: 11, parts: "Read ×8 · Grep ×3", range: "13:52–13:57" },
        { kind: "agent", ts: "13:58", text: "Reading the bar budget against the screenshot observations next." },
        { kind: "tool", tool: "Read docs/design/mobile-v2/README.md", status: "running", dur: "2s" },
      ],
    },
    {
      id: "c3",
      title: "Review PR 412 — accounts dialog limits",
      engine: "claude",
      model: "Sonnet",
      effort: "low",
      state: "returned",
      age: "32 min",
      account: "Main",
      ctx: 41,
      feed: [
        { kind: "user", ts: "13:10", text: "Review PR 412 at its head commit. Verify the reset-credit path against the accounts API." },
        { kind: "group", count: 14, parts: "Read ×9 · Grep ×4 · Bash", range: "13:10–13:24" },
        {
          kind: "agent",
          ts: "13:26",
          text: "APPROVE. Two notes, neither blocking:\n\n- the refresh button re-reads limits but does not clear a stale marker until the next poll;\n- the weekly flagship row renders even when the tier is unknown, showing a bare dash.\n\nBoth are one-line fixes; I left them as review comments.",
        },
      ],
    },
    {
      id: "c8",
      title: "Review · Fast conversation switching · round 3",
      engine: "claude",
      model: "Opus",
      effort: "high",
      state: "returned",
      age: "1h",
      account: "Main",
      ctx: 37,
      pipeline: { id: "p2", stage: 3 },
      feed: [
        { kind: "user", ts: "12:40", text: "Round 3. Verify the two findings from round 2 against the head commit and measure the switch." },
        { kind: "group", count: 17, parts: "Read ×10 · Grep ×4 · Bash ×3", range: "12:40–12:58" },
        {
          kind: "agent",
          ts: "13:01",
          text: "Two findings stand:\n\n- switching projects remounts the board, so the feed cache is dropped every time;\n- the measured switch is 640 ms at 12 trees; the bar is 200 ms.\n\nThe round fails on the second alone.",
        },
      ],
    },
    {
      id: "c4",
      title: "Tail: pipeline archive TTL",
      engine: "codex",
      model: "gpt-5.6",
      effort: "medium",
      state: "done",
      age: "2h",
      account: "Main",
      ctx: 9,
      feed: [
        { kind: "user", ts: "11:40", text: "Archive closed pipelines after seven days. One PR, tests by path." },
        { kind: "agent", ts: "12:05", text: "Done. PR 418 is open with the archive sweep and its test; the reviewer approved." },
      ],
    },
  ],

  pipelines: [
    {
      id: "p1",
      task: "Mobile redesign prototype",
      state: "running",
      stateWord: "running",
      stage: 2,
      total: 4,
      started: "40 min ago",
      stages: [
        { name: "Design", kind: "run", state: "passed", verdict: "pass", conv: "c1" },
        { name: "Review", kind: "review-loop", state: "reviewing", round: 1, conv: "c9" },
        { name: "Implement", kind: "run", state: "pending" },
        { name: "Merge", kind: "run", state: "pending" },
      ],
      tasks: [{ title: "Approve the phone prototype", status: "todo" }],
    },
    {
      id: "p2",
      task: "Fast conversation switching",
      state: "needs_decision",
      stateWord: "needs a decision",
      since: "1h",
      stage: 3,
      total: 5,
      started: "2h ago",
      stages: [
        { name: "Design", kind: "run", state: "passed", verdict: "pass" },
        { name: "Implement", kind: "run", state: "passed", verdict: "pass", conv: "c5" },
        { name: "Review", kind: "review-loop", state: "failed", verdict: "fail", round: 3, findings: 2, conv: "c8" },
        { name: "Fix", kind: "run", state: "pending" },
        { name: "Merge", kind: "run", state: "pending" },
      ],
      findings: [
        "Switching projects remounts the board, so the feed cache is dropped every time.",
        "The measured switch is 640 ms at 12 trees; the bar is 200 ms.",
      ],
      tasks: [],
    },
    {
      id: "p3",
      task: "Accounts dialog limits",
      state: "completed",
      stateWord: "completed",
      stage: 5,
      total: 5,
      started: "yesterday",
      stages: [
        { name: "Design", kind: "run", state: "passed", verdict: "pass" },
        { name: "Implement", kind: "run", state: "passed", verdict: "pass" },
        { name: "Review", kind: "review-loop", state: "passed", verdict: "pass", round: 2 },
        { name: "Fix", kind: "run", state: "skipped" },
        { name: "Merge", kind: "run", state: "passed", verdict: "pass" },
      ],
      tasks: [],
    },
  ],

  host: {
    /* connected | degraded | offline — the phone's three runtime words. */
    runtime: "connected",
    lastSeen: "14:02",
    background: [
      { title: "next dev · port 8899", pid: "41822", live: true },
      { title: "bun test src/lib/board", pid: "41907", live: true },
    ],
    hiddenQuiet: 14,
    collapsedWorkers: 3,
  },

  accounts: {
    claude: [
      {
        id: "cl-main",
        label: "Main",
        plan: "Max plan",
        active: true,
        auth: "Authenticated",
        checked: "14:32",
        windows: [
          { label: "5h", left: 62, reset: "reset in 2h · 16:40" },
          { label: "Week", left: 38, reset: "reset in 3d · 5 Sep 10:48" },
          { label: "Opus · Week", left: 71, reset: "reset in 3d · 5 Sep 10:48" },
        ],
      },
      { id: "cl-second", label: "Second", plan: "Pro plan", active: false, auth: "needs sign-in" },
    ],
    codex: [
      {
        id: "cx-main",
        label: "Main",
        plan: "Pro plan",
        active: true,
        auth: "Authenticated",
        checked: "14:30",
        windows: [
          { label: "5h", left: 12, reset: "reset in 1h · 15:10" },
          { label: "Week", left: 80, reset: "reset in 5d · 7 Sep 09:12" },
        ],
        resets: { count: 1, expires: "21 Sep 10:48" },
      },
      { id: "cx-studio", label: "Studio", plan: "Plus plan", active: false, auth: "Signed out" },
    ],
  },

  models: {
    claude: ["Opus", "Sonnet", "Haiku"],
    codex: ["gpt-5.6", "gpt-5.5-codex"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
};

/* Failure-state scenarios (critique round 1, P1-3 / P2-1). Each mutates the
   fixture before the first render; `?scenario=<name>` selects one. */
window.SCENARIOS = {
  /* The project has no orchestrator: the seat card becomes an invitation. */
  noseat(F) {
    F.seat = { state: "none" };
    F.conversations = F.conversations.filter((c) => !c.seat);
  },
  /* The runtime host answers slowly: the banner slot says so on every screen. */
  degraded(F) {
    F.host.runtime = "degraded";
  },
  /* The phone lost the host: banner, bar meta and the composer's Queue. */
  offline(F) {
    F.host.runtime = "offline";
  },
  /* Delivery is held: two messages queue behind a stuck delivery. */
  held(F) {
    const c = F.conversations.find((x) => x.id === "c1");
    c.held = 2;
    c.state = "working";
  },
  /* The account is out of the model's window until the reset. */
  limit(F) {
    const c = F.conversations.find((x) => x.id === "c1");
    c.limit = { account: "Main", resets: "16:40" };
  },
  /* The agent stopped producing output while its turn still runs. */
  stalled(F) {
    const c = F.conversations.find((x) => x.id === "c1");
    c.stalled = "14 min";
  },
  /* A new decision arrived while the operator reads another conversation. */
  arrival(F) {
    F.arrival = { conv: "c6" };
  },
  /* Thirty conversations and ten pipelines: the long-list case (P3-2). */
  crowded(F) {
    const base = F.conversations.find((c) => c.id === "c4");
    const states = ["done", "returned", "done", "done", "working", "done", "returned", "done"];
    for (let i = 0; i < 21; i++) {
      const state = states[i % states.length];
      F.conversations.push({ ...base, id: `x${i}`, title: `Lane ${i + 10} · ${["archive sweep", "board projection", "export rows", "reseat race", "limits dialog", "seat rotation", "catalog paging"][i % 7]}`, state, age: `${i + 2}h`, elapsed: "0:40", feed: base.feed.slice() });
    }
    const p2 = F.pipelines.find((p) => p.id === "p2");
    for (let i = 0; i < 7; i++) {
      const need = i < 2;
      F.pipelines.push({ ...p2, id: `q${i}`, task: `Pipeline ${i + 4} · ${["issue triage", "docs sweep", "flaky tests", "release notes", "perf pass", "audit tail", "i18n keys"][i]}`, state: need ? "needs_decision" : "running", stateWord: need ? "needs a decision" : "running", since: `${i + 2}h`, stages: p2.stages.map((s) => ({ ...s, conv: undefined })) });
    }
  },
};
