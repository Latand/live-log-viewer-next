/* The key screens of the desktop-v2 prototype (issue #1453, rewrite). Loaded
   by the page for the bench's quick links and required by capture.ts for the
   frame matrix, so the two can never list different screens. `scenario`
   selects a fixture mutation (`?scenario=<name>`); `query` adds view state
   (`select`, `lift`, `zoom`, `rail`, `tray`); `w` restricts a screen to the
   widths where its feature exists. */
(function (root) {
  const SCREENS = [
    { id: "yard", hash: "#/board", title: "The yard — every cluster of atlas at once, needs-you at the origin, the seat as the desk" },
    { id: "yard-block", hash: "#/board", query: "zoom=block:p2", title: "Block altitude — one pipeline cluster: stations, the fail loop, the task tag, the worker nodes" },
    { id: "yard-inspect", hash: "#/board", query: "zoom=block:p2&select=p2", title: "A cluster selected — the inspector reads the record: stage graph, findings, answer, actions" },
    { id: "yard-lift", hash: "#/board", query: "lift=c2", title: "The lift — a node rises into a live pane in place while the yard recedes" },
    { id: "yard-pinned", hash: "#/board", scenario: "pinned", title: "A pinned cluster — the operator moved it; the rest flows around it; Release in the header" },
    { id: "yard-crowded", hash: "#/board", scenario: "crowded", title: "Crowded — thirty conversations, fifteen pipelines, twenty-one tasks: the packing keeps the origin readable" },
    { id: "yard-crowded-block", hash: "#/board", scenario: "crowded", query: "zoom=block:q2", title: "Crowded, block altitude — a parked pipeline among its neighbours" },
    { id: "yard-noseat", hash: "#/board", scenario: "noseat", title: "No orchestrator — the desk invites" },
    { id: "yard-degraded", hash: "#/board", scenario: "degraded", title: "Runtime degraded — status chip and the one banner slot" },
    { id: "yard-arrival", hash: "#/board", scenario: "arrival", title: "A decision arrived in another project — the banner slot" },
    { id: "yard-tray", hash: "#/board", query: "tray=1", title: "The backlog tray — tasks with no worker, each with Assign" },
    { id: "yard-rail", hash: "#/board", query: "rail=1", title: "Rail expanded to names and counts ([)" },
    { id: "field", hash: "#/overview", title: "The field — every project as a region of clusters, one altitude up" },
    { id: "chat-waiting", hash: "#/chat/c2", title: "Conversation — today's chat, more compact: one header row, the feed, one composer box; a question needs you" },
    { id: "chat-working", hash: "#/chat/c1", title: "Conversation — working; Stop in the send slot; tool lines as today" },
    { id: "chat-settings", hash: "#/chat/c1/settings", title: "Settings for the next message — model, reasoning, speed, account and session in one sheet" },
    { id: "chat-menu", hash: "#/chat/c1/menu", title: "Conversation menu (⋯)" },
    { id: "chat-seat", hash: "#/chat/seat", title: "The orchestrator's conversation with the seat panel" },
    { id: "chat-limit", hash: "#/chat/c1", scenario: "limit", title: "Conversation — account at limit; the chip offers the other account" },
    { id: "chat-killed", hash: "#/chat/c1", scenario: "killed", title: "Conversation — killed; Respawn in the send slot" },
    { id: "accounts", hash: "#/accounts", title: "Accounts — every account with both meters, the best pick named, one selected in detail" },
    { id: "account-detail", hash: "#/accounts/codex/cx-team", title: "One account — burndown against the ideal pace, burn rate, when it runs out, today by hour" },
    { id: "account-signed-out", hash: "#/accounts/claude/cl-second", title: "A signed-out account — empty meters, sign-in as the primary action" },
    { id: "search", hash: "#/board/search", title: "Find my messages (/)" },
    { id: "create", hash: "#/board/create", title: "Create (+): conversation, task, pipeline" },
    { id: "menu", hash: "#/board/menu", title: "Board menu (⋯)" },
    { id: "host", hash: "#/board/host", title: "Host details: runtime, background tasks, hidden conversations" },
    { id: "rotate", hash: "#/board/rotate", title: "Rotate the orchestrator" },
    { id: "keys", hash: "#/board/keys", title: "Keyboard map (?)" },
  ];
  if (typeof module !== "undefined" && module.exports) module.exports = SCREENS;
  else root.SCREENS = SCREENS;
})(typeof window !== "undefined" ? window : this);
