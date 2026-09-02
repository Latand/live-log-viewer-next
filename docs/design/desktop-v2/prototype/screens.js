/* The key screens of the desktop-v2 prototype (issue #1453). Loaded by the
   page for the bench's quick links and required by capture.ts for the frame
   matrix, so the two can never list different screens. `scenario` selects a
   fixture mutation from fixture.js (`?scenario=<name>`); `w` restricts a
   screen to the widths where its feature exists (the split pane). */
(function (root) {
  const SCREENS = [
    { id: "overview", hash: "#/overview", title: "Overview — every project, the cross-project queue in the column" },
    { id: "overview-crowded", hash: "#/overview", scenario: "crowded", title: "Overview — fourteen projects: active cards, quiet ones as one strip" },
    { id: "board", hash: "#/board", title: "Board — project column with the seat first, Needs you, Pipelines, Working, Recent; stage empty" },
    { id: "board-map", hash: "#/map", title: "Map — pipelines as groups of stage nodes among loose conversations, auto-arranged" },
    { id: "map-crowded", hash: "#/map", scenario: "crowded", title: "Map — ten pipelines: unstarted stages fold into one ladder tile per group" },
    { id: "map-pinned", hash: "#/map", scenario: "pinned", title: "Map — the operator moved a group; it is honoured and the rest flows around it" },
    { id: "board-noseat", hash: "#/board", scenario: "noseat", title: "Board — no orchestrator: the seat row invites" },
    { id: "board-degraded", hash: "#/board", scenario: "degraded", title: "Board — runtime degraded (status bar + banner slot)" },
    { id: "board-crowded", hash: "#/board", scenario: "crowded", title: "Board — thirty conversations, ten pipelines, fourteen projects" },
    { id: "board-rail-collapsed", hash: "#/board?rail=0", title: "Board — rail collapsed to icons (the default under 1440)" },
    { id: "board-notasks", hash: "#/board", scenario: "notasks", title: "Board — a project with no tasks lands on the first thing that needs you" },
    { id: "board-arrival-here", hash: "#/board", scenario: "arrival-here", title: "Board — a decision arrives in THIS project: a new row, a count that ticks, no banner" },
    { id: "kanban", hash: "#/kanban", title: "Board — the kanban: one card is the task, its worker and its pipeline" },
    { id: "kanban-crowded", hash: "#/kanban", scenario: "crowded", title: "Board — the kanban with twenty-one tasks" },
    { id: "create-menu", hash: "#/board/create", title: "Create menu (＋): conversation, task, pipeline" },
    { id: "board-menu", hash: "#/board/menu", title: "Board overflow menu (⋯)" },
    { id: "chat-working", hash: "#/chat/c1", title: "Conversation — working, Stop in the send slot" },
    { id: "chat-waiting", hash: "#/chat/c2", title: "Conversation — a question needs you" },
    { id: "chat-idle", hash: "#/chat/c3", title: "Conversation — finished the turn" },
    { id: "chat-menu", hash: "#/chat/c1/menu", title: "Conversation overflow menu (pipeline row first)" },
    { id: "chat-model", hash: "#/chat/c1/model", title: "Next message: model, reasoning, account" },
    { id: "chat-details", hash: "#/chat/c1/details", title: "Details & host dialog" },
    { id: "chat-arrival", hash: "#/chat/c1", scenario: "arrival", title: "Conversation — a decision arrived in another project (banner)" },
    { id: "chat-offline", hash: "#/chat/c1", scenario: "offline", title: "Conversation — offline, send becomes Queue" },
    { id: "chat-held", hash: "#/chat/c1", scenario: "held", title: "Conversation — delivery held" },
    { id: "chat-limit", hash: "#/chat/c1", scenario: "limit", title: "Conversation — account limit reached" },
    { id: "chat-stalled", hash: "#/chat/c1", scenario: "stalled", title: "Conversation — agent stalled" },
    { id: "chat-killed", hash: "#/chat/c1", scenario: "killed", title: "Conversation — killed, Respawn in the send slot" },
    { id: "chat-split", hash: "#/chat/c2", scenario: "split", title: "Split — the orchestrator pinned beside a worker (≥ 1600 px)", w: ["1920"] },
    { id: "seat", hash: "#/seat", title: "Orchestrator seat: identity, context, mandate, Rotate" },
    { id: "seat-rotate", hash: "#/seat/rotate", title: "Rotate draft dialog" },
    { id: "pipelines", hash: "#/pipelines", title: "Pipelines list" },
    { id: "pipeline", hash: "#/pipeline/p2", title: "One pipeline — needs a decision: findings, answer, actions, stage graph" },
    { id: "pipeline-running", hash: "#/pipeline/p1", title: "One pipeline — running, a pending edit on the review stage" },
    { id: "pipeline-edit-stage", hash: "#/pipeline/p1/stage/review", title: "Edit a stage after start (edit-stage · set-edge · note · rerun)" },
    { id: "pipeline-edit-running", hash: "#/pipeline/p1/stage/build", title: "Edit the running stage: save for next attempt or restart now" },
    { id: "pipeline-add-stage", hash: "#/pipeline/p1/add/3", title: "Add a stage after start" },
    { id: "pipeline-draft", hash: "#/pipeline/p3", title: "Draft pipeline before start" },
    { id: "pipeline-completed", hash: "#/pipeline/p4/stage/review", title: "Completed pipeline: edit then re-run reopens it" },
    { id: "pipeline-long", hash: "#/pipeline/p6", title: "Seven stages, two fail edges, one loop traversed twice — the whole graph, no sideways scroll" },
    { id: "accounts", hash: "#/accounts", title: "Accounts & limits — every account, both windows, every row a target" },
    { id: "account-detail", hash: "#/accounts/claude/cl-main", title: "One account: consumption, burn rate, and when it runs out" },
    { id: "search", hash: "#/board/search", title: "Find my messages (/)" },
    { id: "host", hash: "#/board/host", title: "Host details dialog" },
    { id: "keys", hash: "#/board/keys", title: "Keyboard shortcuts (?)" },
    { id: "new-agent", hash: "#/board/new-agent", title: "New conversation dialog" },
    { id: "new-pipeline", hash: "#/board/new-pipeline", title: "New pipeline: template picker" },
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = SCREENS;
  else root.SCREENS = SCREENS;
})(typeof window !== "undefined" ? window : this);
