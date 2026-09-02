/* The key screens of the desktop-v2 prototype (issue #1453). Loaded by the
   page for the bench's quick links and required by capture.ts for the frame
   matrix, so the two can never list different screens. `scenario` selects a
   fixture mutation from fixture.js (`?scenario=<name>`); `w` restricts a
   screen to the widths where its feature exists (the split pane). */
(function (root) {
  const SCREENS = [
    { id: "overview", hash: "#/overview", title: "Overview — every project, the cross-project queue in the column" },
    { id: "board", hash: "#/board", title: "Board — project column with the seat first, Needs you, Pipelines, Working, Recent; stage empty" },
    { id: "board-map", hash: "#/map", title: "Map — the spatial view as tiles inside pipeline regions" },
    { id: "board-noseat", hash: "#/board", scenario: "noseat", title: "Board — no orchestrator: the seat row invites" },
    { id: "board-degraded", hash: "#/board", scenario: "degraded", title: "Board — runtime degraded (status bar + banner slot)" },
    { id: "board-crowded", hash: "#/board", scenario: "crowded", title: "Board — thirty conversations, ten pipelines, fourteen projects" },
    { id: "board-rail-collapsed", hash: "#/board?rail=0", title: "Board — rail collapsed to icons (1280 default)" },
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
    { id: "accounts", hash: "#/accounts", title: "Accounts & limits" },
    { id: "search", hash: "#/board/search", title: "Find my messages (/)" },
    { id: "host", hash: "#/board/host", title: "Host details dialog" },
    { id: "keys", hash: "#/board/keys", title: "Keyboard shortcuts (?)" },
    { id: "tasks", hash: "#/tasks", title: "Tasks" },
    { id: "new-agent", hash: "#/board/new-agent", title: "New conversation dialog" },
    { id: "new-pipeline", hash: "#/board/new-pipeline", title: "New pipeline: template picker" },
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = SCREENS;
  else root.SCREENS = SCREENS;
})(typeof window !== "undefined" ? window : this);
