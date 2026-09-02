/* The key screens of the mobile-v2 prototype (issue #1439). Loaded by the
   page for the bench's quick links and required by capture.ts for the frame
   matrix, so the two can never list different screens. `scenario` selects a
   fixture mutation from fixture.js (`?scenario=<name>`), for the failure
   states the critique asked for (round 1, P1-3 and P2-1). */
(function (root) {
  const SCREENS = [
    { id: "board", hash: "#/board", title: "Board — project overview, the queue first" },
    { id: "board-attention", hash: "#/board/attention", title: "Needs you — the attention queue sheet" },
    { id: "board-projects", hash: "#/board/projects", title: "Project switcher sheet" },
    { id: "board-menu", hash: "#/board/menu", title: "Board overflow menu" },
    { id: "board-host", hash: "#/board/host", title: "Host details sheet (background tasks, PIDs)" },
    { id: "board-search", hash: "#/board/search", title: "Search sheet" },
    { id: "board-noseat", hash: "#/board", scenario: "noseat", title: "Board — no orchestrator: the seat card invites" },
    { id: "board-degraded", hash: "#/board", scenario: "degraded", title: "Board — runtime degraded (banner slot)" },
    { id: "board-crowded", hash: "#/board", scenario: "crowded", title: "Board — thirty conversations, ten pipelines" },
    { id: "seat", hash: "#/board/seat", title: "Orchestrator seat: status, rotate, mandate" },
    { id: "seat-rotate", hash: "#/board/seat/rotate", title: "Rotate draft" },
    { id: "chat-working", hash: "#/chat/c1", title: "Conversation — working, Stop in the send slot" },
    { id: "chat-waiting", hash: "#/chat/c2", title: "Conversation — a question needs you" },
    { id: "chat-idle", hash: "#/chat/c3", title: "Conversation — idle after the turn" },
    { id: "chat-keyboard", hash: "#/chat/c2/kb", title: "Composer with the keyboard open" },
    { id: "chat-menu", hash: "#/chat/c1/menu", title: "Conversation overflow menu (pipeline row first)" },
    { id: "chat-switch", hash: "#/chat/c1/switch", title: "Conversation switcher sheet" },
    { id: "chat-model", hash: "#/chat/c1/model", title: "Model and reasoning selector" },
    { id: "chat-host", hash: "#/chat/c1/host", title: "Conversation details and host" },
    { id: "chat-orchestrator", hash: "#/chat/orch", title: "Orchestrator conversation" },
    { id: "chat-arrival", hash: "#/chat/c1", scenario: "arrival", title: "Conversation — a new decision arrived (banner)" },
    { id: "chat-offline", hash: "#/chat/c1", scenario: "offline", title: "Conversation — offline, send becomes Queue" },
    { id: "chat-held", hash: "#/chat/c1", scenario: "held", title: "Conversation — delivery held" },
    { id: "chat-limit", hash: "#/chat/c1", scenario: "limit", title: "Conversation — account limit reached" },
    { id: "chat-stalled", hash: "#/chat/c1", scenario: "stalled", title: "Conversation — agent stalled" },
    { id: "pipelines", hash: "#/pipelines", title: "Pipelines list" },
    { id: "pipeline", hash: "#/pipeline/p2", title: "One pipeline — needs a decision" },
    { id: "pipeline-running", hash: "#/pipeline/p1", title: "One pipeline — running" },
    { id: "accounts", hash: "#/accounts", title: "Accounts and limits" },
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = SCREENS;
  else root.SCREENS = SCREENS;
})(typeof window !== "undefined" ? window : this);
