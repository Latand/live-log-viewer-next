/* mobile-v2 prototype (issue #1439) — vanilla JS, no build step.

   One screen stack + a little in-memory state renders the whole phone. The
   shapes are the product's own (see docs/design/mobile-v2/README.md): one bar,
   one banner slot, one primary surface, sheets for everything secondary, the
   composer and model selector as one unit, and no confirmation prompts.

   Navigation contract (critique round 1, P1-1): screens push, sheets do not
   create history, the browser's back and the bar's ‹ are the same pop, and a
   sibling switch (switcher row, bar or dock swipe) replaces the top of the
   stack. Nothing ever lands on a sheet route after a back. */
(function () {
  "use strict";

  const F = window.FIXTURE;
  const SCREENS = window.SCREENS || [];
  const $phone = document.getElementById("phone");
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const scenario = params.get("scenario");
  if (scenario && window.SCENARIOS && window.SCENARIOS[scenario]) window.SCENARIOS[scenario](F);

  /* ── icons (24 × 24, stroke) ───────────────────────────────────────────── */
  const ICONS = {
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    bot: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M12 9V5"/><path d="M9 14h.01M15 14h.01"/><path d="M2 14h2M20 14h2"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    arrowR: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    tree: '<path d="M5 4h4v4H5zM15 10h4v4h-4zM15 16h4v4h-4z"/><path d="M9 6h3v12h3M12 12h3"/>',
    sparkle: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/>',
    command: '<path d="M15 6a3 3 0 1 1 3 3h-3V6zM9 6a3 3 0 1 0-3 3h3V6zM15 18a3 3 0 1 0 3-3h-3v3zM9 18a3 3 0 1 1-3-3h3v3z"/><path d="M9 9h6v6H9z"/>',
    terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 17h7"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13 7 4 4"/>',
    open: '<path d="M14 5h5v5"/><path d="M19 5l-9 9"/><path d="M19 13v6H5V5h6"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3V6z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="M7 4v16l13-8L7 4z"/>',
    skip: '<path d="M5 5v14l9-7-9-7z"/><path d="M19 5v14"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10"/><path d="M18 10a6 6 0 0 1-6 6H6"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>',
    loader: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    tool: '<path d="M14.5 4.5a5 5 0 0 0-6 6.3L3 16.3V21h4.7l5.5-5.5a5 5 0 0 0 6.3-6l-3 3-3-1-1-3 3-3z"/>',
    compress: '<path d="M4 14h5v5M20 10h-5V5M9 14l-5 5M15 10l5-5"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3V9z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    wifiOff: '<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12.5a10 10 0 0 1 8.5-2.8"/><path d="M8.5 16a5 5 0 0 1 4-1.3"/><path d="M12 20h.01"/><path d="m3 3 18 18"/>',
  };
  const I = (name, cls) => `<svg class="i ${cls || ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const paras = (text) => text.split(/\n\n+/).map((p) => {
    const lines = p.split("\n");
    if (lines.every((l) => l.startsWith("- "))) return `<ul>${lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join("")}</ul>`;
    return `<p>${esc(p)}</p>`;
  }).join("");

  /* ── state ─────────────────────────────────────────────────────────────── */
  const S = {
    crowned: new Set(["c1"]),
    killed: new Set(),
    closed: new Set(),
    answered: {},   // id → { text, ts, pick }
    qopen: {},      // id → the folded question is expanded
    drafts: {},
    model: {},
    toast: null,    // { text, undo: { label, fn } | null }
    showCompleted: false,
    sound: true,
    awake: false,
    activeAccount: { claude: "cl-main", codex: "cx-main" },
    rotateDraft: { engine: "claude", model: "Opus", effort: "high", account: "cl-main" },
    arrival: F.arrival || null,   // { conv } — a decision that arrived while reading elsewhere
    seen: new Set(),
  };
  let toastTimer = null;
  const toast = (text, undo) => {
    S.toast = { text, undo: undo || null };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = null; render(); }, 4000);
  };
  /* The arrival banner collapses into the badge on its own after ~6 s (Q3). */
  let arrivalTimer = null;
  const armArrival = () => { clearTimeout(arrivalTimer); if (S.arrival) arrivalTimer = setTimeout(() => { S.arrival = null; render(); }, 6000); };

  const conv = (id) => F.conversations.find((c) => c.id === id);
  const alive = (c) => Boolean(c) && !S.closed.has(c.id);
  const pipeline = (id) => F.pipelines.find((p) => p.id === id);
  const modelFor = (c) => S.model[c.id] || { model: c.model, effort: c.effort };
  const runtime = () => F.host.runtime;

  /* ── route: screens push, sheets replace ───────────────────────────────── */
  const SHEETS = ["projects", "attention", "menu", "host", "search", "seat", "switch", "model"];
  function parse(hash) {
    const p = (hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
    const screen = ["chat", "pipelines", "pipeline", "accounts"].includes(p[0]) ? p[0] : "board";
    const hasId = screen === "chat" || screen === "pipeline";
    const id = hasId ? p[1] : null;
    const rest = hasId ? p.slice(2) : p.slice(1);
    const kb = rest.includes("kb");
    const subs = rest.filter((x) => x !== "kb");
    const sheet = SHEETS.includes(subs[0]) ? subs[0] : null;
    const base = `#/${[screen, id].filter(Boolean).join("/")}${kb ? "/kb" : ""}`;
    return { screen, id, kb, sheet, sub2: subs[1] || null, base };
  }
  const cur = () => parse(location.hash);
  let depth = 1;
  let lastNav = "load";
  let renderedHash = null;
  function nav(hash, opts = {}) {
    const from = cur();
    const to = parse(hash);
    if (from.base === to.base) {
      history.replaceState({ d: depth }, "", hash);
      lastNav = "sheet";
    } else if (opts.replace) {
      history.replaceState({ d: depth }, "", hash);
      lastNav = opts.kind || "switch";
    } else {
      if (from.sheet) history.replaceState({ d: depth }, "", from.base);
      depth += 1;
      history.pushState({ d: depth }, "", hash);
      lastNav = "push";
    }
    render();
  }
  function back() {
    if (depth > 1) { history.back(); return; }
    nav("#/board", { replace: true, kind: "pop" });
  }
  window.addEventListener("popstate", (e) => {
    const p = cur();
    if (!e.state) {
      /* A fresh same-document navigation (address bar, bench link): a push. */
      depth += 1;
      history.replaceState({ d: depth }, "", location.hash);
      lastNav = "push";
    } else {
      /* A history traversal: pop or forward, and never onto a sheet route. */
      const d = e.state.d || 1;
      lastNav = d < depth ? "pop" : "push";
      depth = d;
      if (p.sheet) history.replaceState({ d }, "", p.base);
    }
    render();
  });
  window.addEventListener("hashchange", () => { if (location.hash !== renderedHash) { lastNav = "push"; render(); } });

  /* ── the attention queue: conversations and pipelines, one list ────────── */
  const NEEDS = new Set(["waiting", "stalled", "limit"]);
  function attention() {
    const convs = F.conversations
      .filter((c) => alive(c) && NEEDS.has(stateBits(c).key))
      .map((c) => { const st = stateBits(c); return { kind: "conv", id: c.id, title: c.title, decision: st.badge, since: st.since, engine: c.engine, model: modelFor(c).model, go: `#/chat/${c.id}` }; });
    const pipes = F.pipelines
      .filter((p) => p.state === "needs_decision")
      .map((p) => ({ kind: "pipeline", id: p.id, title: p.task, decision: "needs a decision", since: p.since, go: `#/pipeline/${p.id}`, p }));
    return [...convs, ...pipes];
  }

  /* ── state precedence (README §4.2): killed > stalled > limit > held >
        waiting > working > returned > done; offline and degraded are
        screen-level and live in the banner slot and the bar meta ────────── */
  function stateBits(c) {
    if (S.killed.has(c.id)) return { key: "killed", dot: "stall", phrase: "killed · messages queue", tone: "tone-danger" };
    if (c.stalled) return { key: "stalled", dot: "stall", phrase: `stalled · ${c.stalled}`, short: c.stalled, since: c.stalled, tone: "tone-danger", badge: "stalled", badgeTone: "b-danger", edge: "stall" };
    if (c.limit) return { key: "limit", dot: "wait", phrase: `limit · ${c.limit.account} resets ${c.limit.resets}`, short: `${c.limit.account} resets ${c.limit.resets}`, since: `resets ${c.limit.resets}`, tone: "tone-warning", badge: "limit", badgeTone: "b-warning", edge: "wait" };
    if (c.held) return { key: "held", dot: "wait", phrase: `held · ${c.held} messages queue`, tone: "tone-warning" };
    if (c.state === "waiting" && !S.answered[c.id]) return { key: "waiting", dot: "wait", phrase: `${c.decision} · ${c.since}`, short: `waiting ${c.since}`, since: c.since, tone: "tone-warning", badge: c.decision, badgeTone: "b-warning", edge: "wait" };
    if (c.state === "working") return { key: "working", dot: "live pulse", phrase: `working ${c.elapsed}`, tone: "tone-success" };
    if (c.state === "returned") return { key: "returned", dot: "acc", phrase: `finished the turn · ${c.age}`, tone: "" };
    return { key: "done", dot: "", phrase: `done · ${c.age}`, tone: "" };
  }
  /* What the agent is doing right now: the running tool, else its last line. */
  const shortTool = (name) => name.split(" ").map((w) => (w.includes("/") ? w.split("/").pop() : w)).join(" ").replace(/^viewer · /, "");
  function nowFragment(c) {
    const last = c.feed[c.feed.length - 1];
    if (last && last.kind === "tool" && last.status === "running") return shortTool(last.tool);
    const agent = [...c.feed].reverse().find((i) => i.kind === "agent");
    return agent ? agent.text.split("\n")[0].slice(0, 60) : "";
  }
  const mark = (engine, cls) => `<span class="mark ${engine} ${cls || ""}">${I(engine === "codex" ? "command" : "sparkle")}</span>`;
  /* Every meter fills with what remains (P2-4). */
  const meter = (left, style) => `<span class="meter ${left <= 10 ? "low" : left <= 30 ? "warn" : ""}" ${style ? `style="${style}"` : ""}><i style="width:${left}%"></i></span>`;
  const pipelineOf = (c) => (c.pipeline ? { p: pipeline(c.pipeline.id), i: c.pipeline.stage } : null);
  const isCurrentStage = (c) => { const x = pipelineOf(c); return Boolean(x && x.p && x.p.stage === x.i && x.p.state !== "completed"); };

  function bar({ back: hasBack, title, base, menu = true, search = false, attn = true }) {
    const n = attention().length;
    return `<header class="bar">
      ${hasBack ? `<button class="ib" data-act="back" aria-label="Back">${I("chevL")}</button>` : ""}
      ${title}
      ${attn && n ? `<button class="attn" data-go="${base}/attention" aria-label="${n} need you"><span>${I("alert")} ${n}</span></button>` : ""}
      ${search ? `<button class="ib" data-go="${base}/search" aria-label="Find your messages">${I("search")}</button>` : ""}
      ${menu ? `<button class="ib" data-go="${base}/menu" aria-label="More actions">${I("more")}</button>` : ""}
    </header>`;
  }

  /* One banner slot. Precedence: offline > degraded > a new arrival. The
     board never shows arrivals (its queue is the first section). */
  function banner(p) {
    const rt = runtime();
    if (rt === "offline") return `<div class="banner info"><div class="open"><b>Offline · reconnecting</b><span>Showing the last state received · ${F.host.lastSeen}</span></div></div>`;
    if (rt === "degraded") return `<div class="banner info"><div class="open"><b>Runtime degraded · polling</b><span>Updates arrive every 10 s</span></div></div>`;
    if (p.screen === "board" || !S.arrival || S.seen.has(S.arrival.conv)) return "";
    const c = conv(S.arrival.conv);
    if (!c || !NEEDS.has(stateBits(c).key) || (p.screen === "chat" && p.id === c.id)) return "";
    const st = stateBits(c);
    return `<div class="banner">
      <button class="open" data-go="#/chat/${c.id}"><b>Needs you · ${esc(st.badge)}</b><span>${esc(c.title)}</span></button>
      <button class="ib" data-act="dismissBanner" aria-label="Dismiss">${I("x")}</button>
    </div>`;
  }

  /* Row = dot · title · one meta line · one trailing element (P2-2). The meta
     line leads with the state phrase, then what the agent is doing, then the
     engine mark and model. Effort lives in the conversation bar and the chip. */
  function convRow(c, { current = false, quiet = false, replace = false } = {}) {
    const st = stateBits(c);
    const m = modelFor(c);
    const phrase = st.badge ? st.short : st.phrase;
    const now = st.key === "working" ? nowFragment(c) : "";
    const trailing = st.badge ? `<span class="badge ${st.badgeTone}">${esc(st.badge)}</span>` : I("chevR", "chev");
    return `<button class="row ${st.edge || ""} ${quiet ? "quiet" : ""} ${current ? "on" : ""}" data-go="#/chat/${c.id}" ${replace ? 'data-replace="1"' : ""}>
      <span class="dot ${st.dot}"></span>
      <span class="main">
        <span class="t ${st.edge ? "two" : ""}"><span>${esc(c.title)}</span>${S.crowned.has(c.id) ? I("crown", "crownmark") : ""}</span>
        <span class="m"><span class="fix ${st.badge ? "" : st.tone}">${esc(phrase)}</span>${now ? `<span class="sep">·</span><span>${esc(now)}</span>` : ""}<span class="sep">·</span>${mark(c.engine)}<span class="fix">${esc(m.model)}</span></span>
      </span>
      ${trailing}
    </button>`;
  }

  function pipelineNeedRow(p) {
    const s = p.stages[p.stage - 1];
    return `<button class="row wait" data-go="#/pipeline/${p.id}">
      <span class="dot wait"></span>
      <span class="main">
        <span class="t two"><span>${esc(p.task)}</span></span>
        <span class="m"><span class="fix">stage ${p.stage}/${p.total} · ${esc(s.name.toLowerCase())} failed${s.findings ? ` · ${s.findings} findings` : ""}</span><span class="sep">·</span><span>${esc(p.since || p.started)}</span></span>
      </span>
      <span class="badge b-warning">needs a decision</span>
    </button>`;
  }

  function seatCard() {
    const s = F.seat;
    if (!s || s.state === "none") {
      return `<div class="seat">
        <button class="open create" data-go="#/board/seat/rotate" aria-label="Create an orchestrator">
          <span class="bot">${I("bot")}</span>
          <span class="main"><span class="t"><span>No orchestrator</span></span><span class="m"><span class="fix">Create an orchestrator ›</span></span></span>
        </button>
      </div>`;
    }
    const o = conv("orch");
    const st = stateBits(o);
    const tone = st.key === "working" ? "b-success" : st.badge ? st.badgeTone : "b-neutral";
    return `<div class="seat">
      <button class="open" data-go="#/chat/orch" aria-label="Open the orchestrator's conversation">
        <span class="bot">${I("bot")}</span>
        <span class="main">
          <span class="t"><span>Orchestrator</span><span class="badge ${tone}">${esc(st.phrase)}</span></span>
          <span class="m now"><span>${esc(nowFragment(o))}</span></span>
          ${meter(100 - s.ctx.used)}
        </span>
      </button>
      <button class="ib" data-go="#/board/seat" aria-label="Orchestrator seat: status, rotate, mandate">${I("sliders")}</button>
    </div>`;
  }

  function pipelinesRow() {
    const ps = F.pipelines;
    const active = ps.filter((p) => p.state === "running" || p.state === "paused").length;
    const need = ps.filter((p) => p.state === "needs_decision").length;
    const done = ps.filter((p) => p.state === "completed").length;
    const parts = [active && `${active} active`, need && `${need} needs you`, done && `${done} done`].filter(Boolean).join(" · ");
    const dot = need ? "wait" : active ? "acc" : "";
    return `<button class="row" data-go="#/pipelines">
      <span class="dot ${dot}"></span>
      <span class="main"><span class="t"><span>${ps.length} pipelines</span></span><span class="m"><span>${parts}</span></span></span>
      ${I("chevR", "chev")}
    </button>`;
  }

  /* The board's sections, shared with the switcher and the swipe list. */
  const needsYou = () => F.conversations.filter((c) => !c.seat && alive(c) && NEEDS.has(stateBits(c).key));
  const working = () => F.conversations.filter((c) => !c.seat && alive(c) && ["working", "held"].includes(stateBits(c).key));
  const recent = () => F.conversations.filter((c) => !c.seat && alive(c) && ["returned", "done", "killed"].includes(stateBits(c).key));
  const switchList = () => [conv("orch"), ...needsYou(), ...working()].filter(alive);

  /* ── screens ───────────────────────────────────────────────────────────── */
  function Board(p) {
    const need = needsYou();
    const needPipes = F.pipelines.filter((x) => x.state === "needs_decision");
    const work = working();
    const rec = recent();
    const anyActive = F.pipelines.some((x) => x.state === "running" || x.state === "paused");
    const total = F.host.hiddenQuiet + F.conversations.length;
    const title = `<button class="title" data-go="#/board/projects" aria-label="Switch project"><span class="h1">${esc(F.project.name)}</span>${I("chevD")}</button>`;
    const pipes = `<div class="sh">Pipelines <span class="n">${F.pipelines.length}</span></div><div class="stack">${pipelinesRow()}</div>`;
    const body = `<div class="body">
      <div class="sh">Orchestrator</div>
      ${seatCard()}
      ${need.length + needPipes.length ? `<div class="sh">Needs you <span class="n">${need.length + needPipes.length}</span></div><div class="stack">${need.map((c) => convRow(c)).join("")}${needPipes.map(pipelineNeedRow).join("")}</div>` : ""}
      ${anyActive ? pipes : ""}
      <div class="sh">Working <span class="n">${work.length}</span></div>
      <div class="stack">${work.length ? work.map((c) => convRow(c)).join("") : '<div class="empty">Nothing is running.</div>'}</div>
      ${anyActive ? "" : pipes}
      <div class="sh">Recent <span class="n">${rec.length}</span></div>
      <div class="stack" style="padding-bottom:12px">${rec.slice(0, 3).map((c) => convRow(c, { quiet: true })).join("")}
        <button class="row quiet" data-act="catalog"><span class="dot"></span><span class="main"><span class="t"><span>All conversations</span></span><span class="m"><span>${total} in the catalog · ${F.host.hiddenQuiet} quiet</span></span></span>${I("chevR", "chev")}</button>
      </div>
    </div>`;
    const dispatch = F.seat && F.seat.state !== "none"
      ? `<button class="dispatch" data-go="#/chat/orch/kb" aria-label="Tell the orchestrator what should get done"><span class="bot">${I("bot")}</span><span class="ph">Tell the orchestrator…</span><span class="mic">${I("mic")}</span></button>`
      : `<button class="dispatch" data-go="#/board/seat/rotate" aria-label="Create an orchestrator"><span class="bot">${I("bot")}</span><span class="ph">Create an orchestrator to talk to…</span></button>`;
    return { html: bar({ title, base: "#/board", search: true }) + banner(p) + body + `<footer class="dock">${dispatch}</footer>`, screen: "board" };
  }

  /* Feed: prose is content, tool calls are chrome. Consecutive tool events
     form a run: a clean run folds to one 44 px line (the running tool stays
     its own last line); a run with a failure expands into one sunken block
     whose lines are 36 px list items (P2-5). */
  const toolName = (t) => (t.includes(" · ") ? t.split(" · ").pop() : t.split(" ")[0]);
  function summary(items) {
    const counts = new Map();
    for (const it of items) counts.set(toolName(it.tool), (counts.get(toolName(it.tool)) || 0) + 1);
    return [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(" · ");
  }
  function toolLine(it) {
    const running = it.status === "running";
    const err = it.status === "error";
    const glyph = running ? I("loader", "spin") : err ? I("x") : I("tool");
    return `<div class="tl ${err ? "err" : ""}">
      <button class="tb" data-act="expand">${glyph}<span class="s">${running ? "running " : ""}${esc(it.tool)}${running ? "…" : ""}</span>${err ? '<span class="d">exit 1</span>' : ""}<span class="d">${it.ts ? `${it.ts} · ` : ""}${it.dur}</span></button>
      ${it.link ? `<button class="link" data-go="#/chat/c1" aria-label="Open the conversation this tool read">${I("open")}</button>` : ""}
    </div>`;
  }
  function foldLine(items) {
    const first = items[0].ts; const last = items[items.length - 1].ts;
    const range = first && last && first !== last ? `${first}–${last}` : first || "";
    return `<div class="tl"><button class="tb" data-act="expand">${I("chevR")}<span class="s">${items.length} actions · ${esc(summary(items))}</span><time>${range}</time></button></div>`;
  }
  function runBlock(items) {
    const rows = items.map((it) => {
      const running = it.status === "running"; const err = it.status === "error";
      const glyph = running ? I("loader", "spin") : err ? I("x") : I("tool");
      return `<span class="tr ${err ? "err" : ""}">${glyph}<span class="s">${running ? "running " : ""}${esc(shortTool(it.tool))}${running ? "…" : ""}</span><span class="d">${err ? "exit 1 · " : ""}${it.ts ? `${it.ts} · ` : ""}${it.dur}</span></span>${err && it.detail ? `<span class="tld">${esc(it.detail)}</span>` : ""}`;
    }).join("");
    return `<button class="trun" data-act="expand" aria-label="${items.length} actions, one failed — expands in place">${rows}</button>`;
  }
  function feedHtml(c) {
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length === 1) out.push(toolLine(run[0]));
      else if (run.some((it) => it.status === "error")) out.push(runBlock(run));
      else {
        const last = run[run.length - 1];
        const done = last.status === "running" ? run.slice(0, -1) : run;
        if (done.length === 1) out.push(toolLine(done[0])); else out.push(foldLine(done));
        if (last.status === "running") out.push(toolLine(last));
      }
      run = [];
    };
    for (const it of c.feed) {
      if (it.kind === "tool") { run.push(it); continue; }
      flush();
      if (it.kind === "user") out.push(`<div class="mu"><div class="bubble">${esc(it.text)}</div></div>`);
      else if (it.kind === "agent") out.push(`<div class="ma"><button class="who" data-act="msgActions" aria-label="Message actions: copy, read aloud">${mark(c.engine)}<b>${esc(c.model)}</b><time>${it.ts}</time></button><div class="txt">${paras(it.text)}</div></div>`);
      else if (it.kind === "group") out.push(`<div class="tl"><button class="tb" data-act="expand">${I("chevR")}<span class="s">${it.count} actions · ${esc(it.parts)}</span><time>${it.range}</time></button></div>`);
    }
    flush();
    return out.join("");
  }

  /* The question card: question, options, "or type your own". Options and
     chips both send on tap (P2-7); afterwards the card folds to one quiet
     line and the reply is the user's bubble in the feed. */
  function questionCard(c) {
    if (!c.question) return "";
    const a = S.answered[c.id];
    if (a) {
      const open = S.qopen[c.id];
      return `<div class="qf"><button class="tb" data-act="qtoggle:${c.id}">${I(open ? "chevD" : "chevR")}<span class="s">question · answered ${a.ts}</span></button>
        ${open ? `<div class="q quiet"><p class="qt">${esc(c.question.text)}</p>${c.question.options.map((o, i) => `<div class="opt ${a.pick === i ? "sel" : ""}"><i></i><span>${esc(o)}</span></div>`).join("")}</div>` : ""}</div>`;
    }
    return `<div class="q">
      <div class="qh">${I("alert")} Needs you · ${c.since}</div>
      <p class="qt">${esc(c.question.text)}</p>
      ${c.question.options.map((o, i) => `<button class="opt" data-act="pick:${c.id}:${i}"><i></i><span>${esc(o)}</span></button>`).join("")}
      <div class="own">Or type your own answer below — it is sent as the reply.</div>
    </div>`;
  }

  /* The composer unit. No status row (P1-4): the send slot is Stop while the
     agent works and the draft is empty, Queue while offline, Respawn when
     killed; elapsed time lives in the bar meta only. */
  function composer(c, kb) {
    const st = stateBits(c);
    const killed = st.key === "killed";
    const offline = runtime() === "offline";
    const waiting = c.state === "waiting" && !S.answered[c.id] && !killed;
    const isWorking = st.key === "working";
    const chips = c.suggested && waiting ? `<div class="chips">${c.suggested.map((s, i) => `<button data-act="chip:${c.id}:${i}"><span>${esc(s)}</span></button>`).join("")}</div>` : "";
    /* The keyboard frame opens with a reply already typed; it is seeded into
       the draft store so the send control acts on it (verify round). */
    if (kb && waiting && S.drafts[c.id] === undefined) S.drafts[c.id] = "Both, by header — and add a test for each format.";
    const draft = S.drafts[c.id] || "";
    const m = modelFor(c);
    const placeholder = killed ? "killed · text queues until a respawn"
      : st.key === "held" ? "held · text you send queues"
        : waiting ? "your own answer…" : c.seat ? `what should get done in ${F.project.name}?` : "message the agent…";
    let slot;
    if (killed) slot = `<button class="send wide" data-act="respawn:${c.id}" aria-label="Respawn the agent"><span>${I("play")} Respawn</span></button>`;
    else if (offline) slot = `<button class="send wide sendbtn ${draft ? "" : "off"}" data-act="send:${c.id}" aria-label="Queue — delivers when reconnected"><span>${I("arrowUp")} Queue</span></button>`;
    else slot = `${isWorking ? `<button class="send stop" data-act="interrupt:${c.id}" aria-label="Stop the agent"><span>${I("square")}</span></button>` : ""}<button class="send sendbtn ${draft ? "" : "off"}" data-act="send:${c.id}" aria-label="Send to the agent"><span>${I("arrowUp")}</span></button>`;
    const chipCls = st.key === "limit" ? "warn" : "";
    const chipText = st.key === "limit" ? `${esc(m.model)} · ${esc(c.limit.account)} at limit` : `${esc(m.model)} · ${esc(m.effort)}`;
    return `<footer class="dock">${chips}
      <label class="box ${isWorking && !offline ? "working" : ""} ${draft ? "has-draft" : ""} ${killed ? "killed" : ""} ${st.key === "held" ? "held" : ""}">
        <textarea rows="1" placeholder="${esc(placeholder)}" aria-label="Text for the agent" data-draft="${c.id}">${esc(draft)}</textarea>
        <div class="tools">
          <button class="chip ${chipCls}" data-go="#/chat/${c.id}${kb ? "/kb" : ""}/model" aria-label="Model and reasoning — applies to your next message"><span>${chipText} ${I("chevD")}</span></button>
          <button class="ib" data-act="attach" aria-label="Add files or images">${I("plus")}</button>
          <button class="ib" data-act="mic" aria-label="Dictate">${I("mic")}</button>
          ${slot}
        </div>
      </label>
    </footer>`;
  }

  function keyboard() {
    const row = (n) => `<div class="krow">${"<i></i>".repeat(n)}</div>`;
    return `<div class="kb" aria-hidden="true"><span class="lbl">on-screen keyboard · 336 px</span>${row(10)}${row(9)}<div class="krow"><i class="w"></i>${"<i></i>".repeat(7)}<i class="w"></i></div><div class="krow"><i class="w"></i><i class="sp"></i><i class="w"></i></div></div>`;
  }

  function Chat(p) {
    const c = conv(p.id);
    if (!c) return Board(p);
    /* Opening a conversation is the "seen" gesture (#1244): a decision the
       operator has looked at is not announced in the banner again. */
    S.seen.add(c.id);
    const kb = p.kb;
    const st = stateBits(c);
    const m = modelFor(c);
    const x = pipelineOf(c);
    const offline = runtime() === "offline";
    const meta = offline
      ? `<span class="fix">offline · reconnecting</span>`
      : `<span class="fix ${st.tone}">${esc(st.phrase)}</span><span class="sep">·</span>${mark(c.engine)}<span>${esc(m.model)} · ${esc(m.effort)}</span>${isCurrentStage(c) ? `<span class="sep">·</span><span class="fix">stage ${x.i}/${x.p.total}</span>` : ""}`;
    const title = `<button class="title stack" data-go="${p.base}/switch" aria-label="Switch conversation">
      <span class="h1">${esc(c.title)}</span>
      <span class="sub"><span class="dot ${offline ? "" : st.dot}"></span>${meta}</span>
    </button>`;
    const feed = `<div class="body feed"><div class="msgs">${feedHtml(c)}${questionCard(c)}</div></div>`;
    return { html: bar({ back: true, title, base: p.base }) + banner(p) + feed + composer(c, kb) + (kb ? keyboard() : ""), screen: "chat", kb };
  }

  function pipelineRow(p) {
    const tone = p.state === "needs_decision" ? "b-warning" : p.state === "running" ? "b-accent" : p.state === "completed" ? "b-success" : "b-neutral";
    const dot = p.state === "needs_decision" ? "wait" : p.state === "running" ? "acc pulse" : p.state === "completed" ? "live" : "";
    const s = p.stages[p.stage - 1];
    return `<button class="row ${p.state === "needs_decision" ? "wait" : ""} ${p.state === "completed" ? "quiet" : ""}" data-go="#/pipeline/${p.id}">
      <span class="dot ${dot}"></span>
      <span class="main"><span class="t ${p.state === "needs_decision" ? "two" : ""}"><span>${esc(p.task)}</span></span><span class="m"><span class="fix">stage ${p.stage}/${p.total} · ${esc(s.name)} · ${esc(s.state.replace("_", " "))}</span><span class="sep">·</span><span>${esc(p.started)}</span></span></span>
      <span class="badge ${tone}">${esc(p.stateWord)}</span>
    </button>`;
  }

  function Pipelines(p) {
    const need = F.pipelines.filter((x) => x.state === "needs_decision");
    const active = F.pipelines.filter((x) => x.state === "running" || x.state === "paused");
    const done = F.pipelines.filter((x) => x.state === "completed");
    const title = `<div class="title"><span class="h1">Pipelines</span></div>`;
    const body = `<div class="body">
      ${need.length ? `<div class="sh">Needs you <span class="n">${need.length}</span></div><div class="stack">${need.map(pipelineRow).join("")}</div>` : ""}
      <div class="sh">Active <span class="n">${active.length}</span></div>
      <div class="stack">${active.length ? active.map(pipelineRow).join("") : '<div class="empty">No pipeline is running.</div>'}</div>
      <div class="sh"><button class="hbtn" style="margin:0 0 0 -8px" data-act="toggleCompleted">${I(S.showCompleted ? "chevD" : "chevR")} ${done.length} completed</button></div>
      ${S.showCompleted ? `<div class="stack">${done.map(pipelineRow).join("")}</div>` : ""}
      <div style="height:16px"></div>
    </div>`;
    return { html: bar({ back: true, title, base: p.base }) + banner(p) + body, screen: "pipelines" };
  }

  /* One pipeline: the bar carries the task title and a meta line (P3-3);
     the findings block, the two actions for the state, the stage list. */
  function PipelineDetail(p) {
    const pl = pipeline(p.id);
    if (!pl) return Pipelines(p);
    const tone = pl.state === "needs_decision" ? "tone-warning" : pl.state === "running" ? "" : pl.state === "completed" ? "tone-success" : "";
    const dot = pl.state === "needs_decision" ? "wait" : pl.state === "running" ? "acc pulse" : pl.state === "completed" ? "live" : "";
    const title = `<div class="title stack"><span class="h1">${esc(pl.task)}</span><span class="sub"><span class="dot ${dot}"></span><span class="fix ${tone}">${esc(pl.stateWord)}</span><span class="sep">·</span><span class="fix">stage ${pl.stage}/${pl.total}</span><span class="sep">·</span><span>${esc(pl.started)}</span></span></div>`;
    const stages = pl.stages.map((s, i) => {
      const k = s.state === "passed" ? `<span class="k pass">${I("check")}</span>` : s.state === "failed" ? `<span class="k fail">${I("x")}</span>` : s.state === "skipped" ? `<span class="k skip">${i + 1}</span>` : s.state === "running" || s.state === "reviewing" ? `<span class="k run">${I("loader", "spin")}</span>` : `<span class="k">${i + 1}</span>`;
      const isCur = i === pl.stage - 1 && pl.state !== "completed";
      const meta = [s.kind === "review-loop" ? `review loop${s.round ? ` · round ${s.round}` : ""}` : "run", s.state.replace("_", " "), s.findings ? `${s.findings} findings` : ""].filter(Boolean).join(" · ");
      const openable = Boolean(s.conv && conv(s.conv));
      return `<button class="stg ${isCur ? "cur" : ""}" ${openable ? `data-go="#/chat/${s.conv}"` : 'data-act="stageNoConv"'}>${k}<span class="main"><span class="t"><span>${esc(s.name)}</span></span><span class="m"><span>${esc(meta)}</span></span></span>${openable ? I("chevR", "chev") : ""}</button>`;
    }).join("");
    const actions = pl.state === "needs_decision"
      ? `<div class="actions"><button class="btn" data-act="pipe:${pl.id}:skip">${I("skip")} Skip stage</button><button class="btn primary" data-act="pipe:${pl.id}:retry">${I("refresh")} Retry stage</button></div>`
      : pl.state === "running"
        ? `<div class="actions"><button class="btn" data-act="pipe:${pl.id}:pause">${I("pause")} Pause</button></div>`
        : pl.state === "paused"
          ? `<div class="actions"><button class="btn primary" data-act="pipe:${pl.id}:resume">${I("play")} Resume</button></div>`
          : `<div class="actions"><button class="btn" data-act="pipe:${pl.id}:archive">${I("archive")} Archive</button></div>`;
    const cs = pl.stages[pl.stage - 1];
    const body = `<div class="body">
      ${pl.findings && pl.state === "needs_decision" ? `<div class="findings"><b>${esc(cs.name)} · round ${cs.round} · ${pl.findings.length} findings</b><ol>${pl.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol></div>` : ""}
      ${actions}
      <div class="sh">Stages <span class="n">${pl.total}</span></div>
      <div class="stages">${stages}</div>
      ${pl.tasks.length ? `<div class="sh">Linked tasks <span class="n">${pl.tasks.length}</span></div><div class="stack">${pl.tasks.map((t) => `<button class="row quiet" data-act="task"><span class="dot"></span><span class="main"><span class="t"><span>${esc(t.title)}</span></span><span class="m"><span>${t.status}</span></span></span>${I("chevR", "chev")}</button>`).join("")}</div>` : ""}
      <div style="height:16px"></div>
    </div>`;
    return { html: bar({ back: true, title, base: p.base }) + banner(p) + body, screen: "pipeline" };
  }

  function accountCard(engine, a) {
    const active = S.activeAccount[engine] === a.id;
    const lowest = a.windows ? a.windows.reduce((m, w) => (w.left < m.left ? w : m)) : null;
    const capCls = !lowest ? "" : lowest.left <= 10 ? "low" : lowest.left <= 30 ? "warn" : "";
    const authed = a.auth === "Authenticated";
    const state = active ? '<span class="badge b-success">active</span>' : authed ? '<span class="badge b-neutral">ready</span>' : `<span class="badge b-warning">${esc(a.auth)}</span>`;
    const head = `<span class="main"><span class="t"><span>${esc(a.label)}</span>${state}</span><span class="m"><span>${esc(a.plan)}</span>${a.checked ? `<span class="sep">·</span><span>checked ${a.checked}</span>` : ""}</span></span>${lowest ? `<span class="cap ${capCls}">${lowest.left}% left<small>${esc(lowest.label)}</small></span>` : ""}`;
    const row = active
      ? `<div class="arow">${mark(engine, "fill lg")}${head}</div>`
      : authed
        ? `<button class="arow" data-act="switchAccount:${engine}:${a.id}" aria-label="Use ${esc(a.label)} for future launches">${mark(engine, "fill lg")}${head}${I("chevR", "chev")}</button>`
        : `<button class="arow" data-act="signIn:${engine}:${a.id}" aria-label="Sign in to ${esc(a.label)}">${mark(engine, "fill lg")}${head}<span class="signin">sign in ${I("arrowR")}</span></button>`;
    if (!active) return `<div class="acct off">${row}</div>`;
    const wins = (a.windows || []).map((w) => `<div class="win"><b>${esc(w.label)}</b>${meter(w.left)}<span class="pct">${w.left}% left</span><span></span><span class="reset">${esc(w.reset)}</span></div>`).join("");
    const resets = a.resets ? `<div class="resets">${a.resets.count ? `${a.resets.count} reset available · expires ${esc(a.resets.expires)}` : "No resets available"}</div>` : "";
    return `<div class="acct">${row}<div class="wins">${wins}</div>${resets}
      <div class="acts">
        <button data-act="refresh:${a.id}" aria-label="Re-read limits for ${esc(a.label)}">${I("refresh")} Refresh</button>
        ${a.resets && a.resets.count ? `<button data-act="useReset:${a.id}" aria-label="Use one usage-limit reset on ${esc(a.label)}">${I("zap")} Use one reset</button>` : ""}
      </div>
    </div>`;
  }

  function Accounts(p) {
    const title = `<div class="title"><span class="h1">Accounts &amp; limits</span></div>`;
    const section = (engine, label) => `<div class="sh">${label} <span class="n">${F.accounts[engine].length}</span></div>${F.accounts[engine].map((a) => accountCard(engine, a)).join("")}<div class="stack"><button class="row quiet" data-act="addAccount:${engine}"><span class="dot"></span><span class="main"><span class="t"><span>Add a ${label} account</span></span><span class="m"><span>opens the device sign-in</span></span></span>${I("plus", "chev")}</button></div>`;
    const body = `<div class="body">${section("claude", "Claude")}${section("codex", "Codex")}<div style="height:20px"></div></div>`;
    return { html: bar({ back: true, title, base: p.base }) + banner(p) + body, screen: "accounts" };
  }

  /* ── sheets ────────────────────────────────────────────────────────────── */
  function sheet(title, body, { full = false, foot = "", closeGo, extra = "" }) {
    const receipt = S.toast ? toastHtml("inflow") : "";
    return `<div class="scrim" data-go="${closeGo}">
      <div class="sheet ${full ? "full" : ""}" role="dialog" aria-label="${esc(title)}">
        ${full ? "" : '<div class="grab"></div>'}
        <div class="shead"><h2>${title}</h2>${extra}<button class="ib" data-go="${closeGo}" aria-label="Close">${I("x")}</button></div>
        <div class="sbody">${body}</div>
        ${receipt}
        ${foot ? `<div class="sfoot">${foot}</div>` : ""}
      </div>
    </div>`;
  }

  function projectsSheet(closeGo) {
    const counts = (p) => `${p.live ? `${p.live} live` : p.quiet ? `quiet · ${p.quiet}` : "quiet"}${p.attention ? ` <span class="badge b-warning">${I("alert")} ${p.attention}</span>` : ""}`;
    const row = (p) => `<button class="mrow ${p.current ? "sel" : ""}" data-act="project:${p.id}">${p.crowned ? I("crown", "crown") : I("folder")}<span>${esc(p.name)}</span><span class="r">${counts(p)}${p.current ? I("check", "check") : ""}</span></button>`;
    const crowned = F.projects.filter((p) => p.crowned);
    const rest = F.projects.filter((p) => !p.crowned);
    const body = `
      <button class="mrow" data-act="overview">${I("layers")}<span>Overview</span><span class="r">${F.projects.length} projects</span></button>
      <div class="hr"></div>
      ${crowned.map(row).join("")}${rest.map(row).join("")}
      <div class="hr"></div>
      <button class="mrow" data-act="archived">${I("archive")}<span>Archive</span><span class="r">${F.archivedProjects.length} project</span></button>
      <button class="mrow" data-act="createProject">${I("plus")}<span>Create project</span></button>`;
    return sheet("Projects", body, { closeGo });
  }

  function attentionSheet(closeGo) {
    const items = attention();
    const row = (a) => a.kind === "conv"
      ? `<button class="mrow" data-go="${a.go}"><span class="dot wait"></span><span class="main"><span class="t"><span>${esc(a.title)}</span></span><span class="m"><span class="fix">${esc(a.decision)} · ${esc(a.since)}</span><span class="sep">·</span>${mark(a.engine)}<span>${esc(a.model)}</span></span></span>${I("chevR", "chev")}</button>`
      : `<button class="mrow" data-go="${a.go}"><span class="dot wait"></span><span class="main"><span class="t"><span>${esc(a.title)}</span></span><span class="m"><span class="fix">pipeline · stage ${a.p.stage}/${a.p.total} · ${esc(a.p.stages[a.p.stage - 1].name.toLowerCase())} failed</span><span class="sep">·</span><span>${esc(a.since)}</span></span></span>${I("chevR", "chev")}</button>`;
    const body = items.length ? items.map(row).join("") : '<div class="empty">Nothing needs you.</div>';
    const extra = items.length > 1 ? `<button class="hbtn" data-act="next">Next ${I("chevR")}</button>` : "";
    return sheet(`Needs you${items.length ? ` · ${items.length}` : ""}`, body, { closeGo, extra });
  }

  function boardMenu(closeGo, base) {
    const rt = runtime();
    const rtBadge = rt === "connected" ? "" : `<span class="badge ${rt === "offline" ? "b-danger" : "b-warning"}">${rt}</span>`;
    const body = `
      <button class="mrow" data-act="newAgent">${I("plus")}<span>New agent</span></button>
      <button class="mrow" data-act="newTask">${I("list")}<span>New task</span></button>
      <button class="mrow" data-act="newPipeline">${I("tree")}<span>New pipeline</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="tasks">${I("list")}<span>Tasks</span><span class="r">3 open</span></button>
      <button class="mrow" data-act="catalog">${I("grid")}<span>All conversations</span><span class="r">catalog · ${F.host.hiddenQuiet + F.conversations.length}</span></button>
      <button class="mrow" data-go="#/accounts">${I("person")}<span>Accounts &amp; limits</span><span class="r">Main · 12% left</span></button>
      <button class="mrow" data-go="${base}/host">${I("info")}<span>Host details</span><span class="r">${rtBadge}${F.host.background.length} tasks</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="sound">${I("bell")}<span>Sound alerts</span><span class="r">${S.sound ? "On" : "Off"}</span></button>
      <button class="mrow" data-act="awake">${I("sun")}<span>Keep screen awake</span><span class="r">${S.awake ? "On" : "Off"}</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="archiveProject">${I("archive")}<span>Archive project</span></button>`;
    return sheet(esc(F.project.name), body, { closeGo });
  }

  function hostSheet(closeGo, c) {
    const host = F.host;
    const rt = runtime();
    const tasks = host.background.length
      ? host.background.map((t) => `<div class="rowd"><span class="dot ${t.live ? "live" : ""}"></span><span class="main"><span class="t"><span>${esc(t.title)}</span></span><span class="m"><span class="mono">PID ${t.pid}</span></span></span><button class="kill" data-act="killTask:${t.pid}" aria-label="Kill ${esc(t.title)}">Kill</button></div>`).join("")
      : '<div class="empty">No background tasks.</div>';
    const x = c ? pipelineOf(c) : null;
    const convBlock = c ? `
      <div class="sh">This conversation</div>
      <div class="kv"><span class="k">Account</span><span class="v">${esc(c.account)} · ${c.engine === "claude" ? "Max plan" : "Pro plan"}</span></div>
      <div class="kv"><span class="k">Context</span><span class="v">${meter(100 - c.ctx, "max-width:120px")}<span>${100 - c.ctx}% left</span></span></div>
      ${c.worktree ? `<div class="kv"><span class="k">Worktree</span><span class="v mono">${esc(c.worktree)}</span></div>` : ""}
      ${x && x.p ? `<div class="kv"><span class="k">Pipeline</span><span class="v">${esc(x.p.task)} · stage ${x.i}/${x.p.total}</span></div>` : ""}
      <div class="hr"></div>` : "";
    const rtWord = rt === "connected" ? "updates stream" : rt === "degraded" ? "polling every 10 s" : "reconnecting";
    const body = `${convBlock}
      <div class="kv"><span class="k">Runtime</span><span class="v"><span class="badge ${rt === "connected" ? "b-success" : rt === "degraded" ? "b-warning" : "b-danger"}">${rt}</span><span>${rtWord}</span></span></div>
      <div class="sh">Background tasks <span class="n">${host.background.length}</span></div>
      ${tasks}
      <div class="sh">Hidden</div>
      <button class="mrow" data-act="catalog">${I("grid")}<span>${host.hiddenQuiet} quiet conversations</span><span class="r">catalog ${I("chevR")}</span></button>
      <button class="mrow" data-act="workers">${I("layers")}<span>${host.collapsedWorkers} collapsed workers</span><span class="r">${I("chevR")}</span></button>`;
    return sheet(c ? "Details & host" : `Host · ${esc(F.project.name)}`, body, { closeGo });
  }

  function searchSheet(closeGo) {
    const body = `
      <div class="field"><input class="inp" placeholder="Find your own messages…" aria-label="Find your messages" autofocus></div>
      <div class="note">Results open the conversation with its composer. Filter: <b>You</b> · Agents.</div>
      <button class="mrow" data-go="#/chat/c1"><span class="main"><span class="t"><span>…keep the tests by path.</span></span><span class="m"><span>Rebuild the board status projection · 13:50</span></span></span>${I("chevR", "chev")}</button>
      <button class="mrow" data-go="#/chat/c3"><span class="main"><span class="t"><span>…against the accounts API.</span></span><span class="m"><span>Review PR 412 · 13:10</span></span></span>${I("chevR", "chev")}</button>`;
    return sheet("Find your messages", body, { closeGo });
  }

  function seatSheet(closeGo) {
    const s = F.seat;
    if (!s || s.state === "none") return rotateSheet(closeGo);
    const o = conv("orch");
    const st = stateBits(o);
    const left = 100 - s.ctx.used;
    const body = `
      <div class="seatid"><span class="bot">${I("bot")}</span><span class="main"><span class="t"><span>${s.model} · ${s.effort}</span><span class="badge ${st.key === "working" ? "b-success" : "b-neutral"}">${esc(st.phrase)}</span></span><span class="m">${mark(s.engine, "fill")}<span>${esc(s.account)} · ${esc(s.plan)}</span><span class="sep">·</span><span>holding the seat for ${s.since}</span></span></span></div>
      <div class="kv"><span class="k">Context</span><span class="v">${meter(left, "max-width:140px")}<span>${left}% left of ${s.ctx.window}</span></span></div>
      ${s.rotation || left <= 30 ? `<div class="note warn">Rotation recommended — ${left}% of the window left.</div>` : ""}
      ${s.predecessor ? `<button class="mrow" data-act="predecessor">${I("branch")}<span>Predecessor</span><span class="r">open ${I("chevR")}</span></button>` : ""}
      <div class="sh">Mandate v${s.mandateVersion} — built-in operating rules</div>
      <div class="mandate">${esc(s.mandate)}</div>
      <button class="mrow" data-go="#/board/seat/rotate">${I("pencil")}<span>Edit the mandate</span><span class="r">replaces the orchestrator</span></button>
      <div class="note">Changing the mandate, model or account means a successor takes the seat.</div>`;
    const foot = `<button class="btn" data-go="#/board/seat/rotate">${I("rotate")} Rotate</button><button class="btn primary" data-go="#/chat/orch">Open conversation</button>`;
    return sheet(`Orchestrator · ${esc(F.project.name)}`, body, { foot, closeGo });
  }

  function rotateSheet(closeGo) {
    const d = S.rotateDraft;
    const creating = !F.seat || F.seat.state === "none";
    const seg = (name, options, current) => `<div class="seg">${options.map((o) => `<button class="${o === current ? "on" : ""}" data-act="rd:${name}:${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
    const accounts = F.accounts[d.engine].map((a) => `<button class="mrow ${d.account === a.id ? "sel" : ""}" data-act="rd:account:${a.id}">${mark(d.engine, "fill")}<span>${esc(a.label)}</span><span class="r">${esc(a.plan)}${d.account === a.id ? I("check", "check") : ""}</span></button>`).join("");
    const body = `
      <div class="note">${creating ? "The orchestrator starts with the mandate below and owns this board from its first turn." : "The successor starts with the mandate below. Its predecessor's transcript and this project's open tasks are handed over by the server; the predecessor's conversation stays on the board, linked to the new one."}</div>
      <div class="field"><label>Engine</label>${seg("engine", ["claude", "codex"], d.engine)}</div>
      <div class="field"><label>Model</label>${seg("model", F.models[d.engine], d.model)}</div>
      <div class="field"><label>Reasoning</label>${seg("effort", F.models.efforts, d.effort)}</div>
      <div class="field"><label>Account</label></div>
      ${accounts}
      <div class="field"><label>Mandate</label><textarea class="ta" aria-label="Mandate" data-draft="rotate">${esc(F.seat && F.seat.mandate ? F.seat.mandate : `You are the ${F.project.name} orchestrator.\n\nYou own this board and you talk to me here.`)}</textarea></div>`;
    const foot = `<button class="btn" data-go="${creating ? "#/board" : "#/board/seat"}">Cancel</button><button class="btn primary" data-act="rotate">${I("rotate")} ${creating ? "Create orchestrator" : "Rotate orchestrator"}</button>`;
    return sheet(creating ? "Create an orchestrator" : "Replace the orchestrator", body, { full: true, foot, closeGo });
  }

  function chatMenu(c, closeGo) {
    const crowned = S.crowned.has(c.id);
    const st = stateBits(c);
    const x = pipelineOf(c);
    const s = x && x.p ? x.p.stages[x.i - 1] : null;
    const body = `
      ${c.seat ? `<button class="mrow" data-go="#/board/seat">${I("bot")}<span>Orchestrator seat</span><span class="r">status · rotate · mandate</span></button><div class="hr"></div>` : ""}
      ${x && x.p ? `<button class="mrow" data-go="#/pipeline/${x.p.id}">${I("tree")}<span class="main"><span class="t"><span>Pipeline · ${esc(x.p.task)}</span></span><span class="m"><span>stage ${x.i}/${x.p.total} · ${esc(s.name)} · ${esc(s.state.replace("_", " "))}</span></span></span>${I("chevR", "chev")}</button><div class="hr"></div>` : ""}
      <button class="mrow" data-act="rename">${I("pencil")}<span>Rename</span></button>
      <button class="mrow" data-act="crown:${c.id}">${I("crown", crowned ? "crown" : "")}<span>${crowned ? "Remove crown" : "Crown"}</span></button>
      <button class="mrow" data-act="handoff">${I("swap")}<span>Hand off to a new agent</span></button>
      <button class="mrow" data-act="compact">${I("compress")}<span>Compact context</span><span class="r">${100 - c.ctx}% left</span></button>
      <button class="mrow" data-go="${closeGo}/host">${I("info")}<span>Details &amp; host</span><span class="r">${F.host.background.length} tasks</span></button>
      <button class="mrow" data-act="terminal">${I("terminal")}<span>Open in terminal</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="close:${c.id}">${I("x")}<span>Close card</span><span class="r">stays in the catalog</span></button>
      <button class="mrow danger" data-act="kill:${c.id}">${I("square")}<span>Kill agent</span><span class="r">${st.key === "stalled" ? "stalled" : st.key === "working" ? "running now" : "not running"}</span></button>`;
    return sheet(esc(c.title), body, { closeGo });
  }

  /* The switcher mirrors the board's sections; rows replace the current
     conversation (a sibling switch), so ‹ still leaves the way you came in. */
  function switchSheet(c, closeGo) {
    const row = (x, section) => { const st = stateBits(x); const m = modelFor(x); return `<button class="mrow ${x.id === c.id ? "sel" : ""}" data-go="#/chat/${x.id}" data-replace="1" data-section="${section}"><span class="dot ${st.dot}"></span><span class="main"><span class="t"><span>${esc(x.title)}</span></span><span class="m"><span class="fix ${st.tone}">${esc(st.phrase)}</span><span class="sep">·</span>${mark(x.engine)}<span>${esc(m.model)}</span></span></span>${x.id === c.id ? I("check", "check") : ""}</button>`; };
    const o = conv("orch");
    const need = needsYou(); const work = working(); const rec = recent();
    const body = `
      ${alive(o) ? row(o, "orchestrator") : ""}
      ${need.length ? `<div class="sh">Needs you <span class="n">${need.length}</span></div>${need.map((x) => row(x, "needs")).join("")}` : ""}
      <div class="sh">Working <span class="n">${work.length}</span></div>${work.map((x) => row(x, "working")).join("")}
      <div class="sh">Recent <span class="n">${rec.length}</span></div>${rec.map((x) => row(x, "recent")).join("")}`;
    return sheet(esc(F.project.name), body, { closeGo, extra: `<button class="hbtn" data-act="toBoard">Board ${I("chevR")}</button>` });
  }

  function modelSheet(c, closeGo) {
    const m = modelFor(c);
    const rows = (name, options, current) => options.map((o) => `<button class="mrow ${o === current ? "sel" : ""}" data-act="md:${c.id}:${name}:${esc(o)}"><span>${esc(o)}</span><span class="r">${o === current ? I("check", "check") : ""}</span></button>`).join("");
    /* Verify round (P2-8 again): only an authenticated account can become the
       launch target; one that is not signed in carries the Accounts screen's
       `sign in →` and opens the device sign-in, leaving the limit in place. */
    const accounts = c.limit ? `<div class="sh">Account</div>${F.accounts[c.engine].map((a) => {
      const blocked = a.label === c.limit.account;
      const authed = a.auth === "Authenticated";
      const actName = blocked ? "noop" : authed ? `md:${c.id}:account:${a.id}` : `signIn:${c.engine}:${a.id}`;
      const trailing = blocked ? `<span class="badge b-warning">limit · resets ${esc(c.limit.resets)}</span>` : authed ? "ready" : `<span class="signin">sign in ${I("arrowR")}</span>`;
      return `<button class="mrow" data-act="${actName}"${authed ? "" : ` aria-label="Sign in to ${esc(a.label)}"`}>${mark(c.engine)}<span>${esc(a.label)}</span><span class="r">${trailing}</span></button>`;
    }).join("")}` : "";
    const body = `
      <div class="note">Applies to your next message: <b>${esc(m.model)} · ${esc(m.effort)}</b></div>
      ${accounts}
      <div class="sh">Model</div>${rows("model", F.models[c.engine], m.model)}
      <div class="sh">Reasoning</div>${rows("effort", F.models.efforts, m.effort)}
      ${c.engine === "codex" ? `<div class="sh">Speed</div>${rows("speed", ["standard", "fast — priority tier"], m.speed || "standard")}` : ""}`;
    return sheet("Next message", body, { closeGo });
  }

  function sheetFor(p) {
    if (!p.sheet) return "";
    const closeGo = p.base;
    const c = p.screen === "chat" ? conv(p.id) : null;
    switch (p.sheet) {
      case "projects": return projectsSheet(closeGo);
      case "attention": return attentionSheet(closeGo);
      case "menu": return c ? chatMenu(c, closeGo) : boardMenu(closeGo, p.base);
      case "host": return hostSheet(closeGo, c);
      case "search": return searchSheet(closeGo);
      case "seat": return p.sub2 === "rotate" ? rotateSheet(F.seat && F.seat.state !== "none" ? "#/board/seat" : "#/board") : seatSheet(closeGo);
      case "switch": return c ? switchSheet(c, closeGo) : "";
      case "model": return c ? modelSheet(c, closeGo) : "";
      default: return "";
    }
  }

  /* ── receipts ──────────────────────────────────────────────────────────── */
  function toastHtml(mode) {
    const t = S.toast;
    return `<div class="toast ${mode}" role="status">${I("check")}<span class="tx">${esc(t.text)}</span>${t.undo ? `<button class="undo" data-act="undo">${esc(t.undo.label)}</button>` : ""}</div>`;
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  const scrollMemo = {};
  let renderedBase = null;
  function render() {
    const p = cur();
    const prev = $phone.querySelector(".body");
    if (prev && renderedBase) scrollMemo[renderedBase] = prev.scrollTop;
    let out;
    if (p.screen === "chat") out = Chat(p);
    else if (p.screen === "pipelines") out = Pipelines(p);
    else if (p.screen === "pipeline") out = PipelineDetail(p);
    else if (p.screen === "accounts") out = Accounts(p);
    else out = Board(p);
    const anim = ["push", "pop", "switch"].includes(lastNav) ? lastNav : "";
    $phone.className = out.kb ? "kbopen" : "";
    $phone.dataset.screen = out.screen;
    $phone.innerHTML = `<div class="screen ${anim}">${out.html}${sheetFor(p)}${S.toast && !p.sheet ? toastHtml("float") : ""}</div>`;
    const scroller = $phone.querySelector(".body");
    if (scroller) {
      const isFeed = scroller.classList.contains("feed");
      const remembered = scrollMemo[p.base];
      if ((lastNav === "sheet" || lastNav === "pop") && remembered !== undefined) scroller.scrollTop = remembered;
      else if (isFeed) scroller.scrollTop = scroller.scrollHeight;
      else if (lastNav === "act" && remembered !== undefined) scroller.scrollTop = remembered;
    }
    /* The receipt sits on the dock's top edge; the scroller gets padding so no
       control ends up under it (P2-6). */
    const t = $phone.querySelector(".toast.float");
    if (t) {
      const dock = $phone.querySelector(".dock");
      const ph = $phone.getBoundingClientRect();
      const safe = parseFloat(getComputedStyle($phone).getPropertyValue("--safe-b")) || 0;
      const bottom = dock ? ph.bottom - dock.getBoundingClientRect().top + 8 : safe + 8;
      t.style.bottom = `${bottom}px`;
      if (scroller) {
        scroller.style.paddingBottom = `${t.offsetHeight + 16}px`;
        if (scroller.classList.contains("feed")) scroller.scrollTop = scroller.scrollHeight;
      }
    }
    if (out.kb) {
      const ta = $phone.querySelector(".box textarea");
      if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
    const navEl = document.getElementById("bench-screens");
    if (navEl) navEl.innerHTML = SCREENS.map((s) => `<a href="${location.pathname}?${s.scenario ? `scenario=${s.scenario}&` : ""}${params.get("scheme") ? `scheme=${params.get("scheme")}&` : ""}${params.get("frame") ? `frame=${params.get("frame")}` : ""}${s.hash}" class="${location.hash === s.hash && (s.scenario || null) === scenario ? "on" : ""}" title="${esc(s.title)}">${s.id}</a>`).join("");
    renderedHash = location.hash;
    renderedBase = p.base;
    lastNav = "act";
    $phone.dataset.ready = "1";
  }

  /* ── actions (no confirmation prompts anywhere) ────────────────────────── */
  function answer(c, text, pick) {
    c.feed.push({ kind: "user", ts: "14:01", text });
    S.answered[c.id] = { text, ts: "14:01", pick: pick === undefined ? null : pick };
    S.drafts[c.id] = "";
    c.state = "working"; c.elapsed = "0:03"; c.age = "now";
    toast(`Answer sent — ${text.split(" — ")[0]}`);
  }
  function act(name) {
    const [head, ...rest] = name.split(":");
    const p = cur();
    const current = p.screen === "chat" ? conv(p.id) : null;
    lastNav = "act";
    switch (head) {
      case "back": back(); return;
      case "toBoard": nav("#/board", { replace: true, kind: "pop" }); return;
      case "dismissBanner": S.arrival = null; break;
      case "pick": { const c = conv(rest[0]); const i = Number(rest[1]); answer(c, c.question.options[i], i); break; }
      case "chip": { const c = conv(rest[0]); answer(c, c.suggested[Number(rest[1])]); break; }
      case "send": {
        const c = conv(rest[0]);
        const text = (S.drafts[c.id] || "").trim();
        if (!text) { toast("Nothing to send yet"); break; }
        if (runtime() === "offline") { c.feed.push({ kind: "user", ts: "14:01", text }); S.drafts[c.id] = ""; toast("Held until reconnected"); break; }
        if (c.state === "waiting" && !S.answered[c.id]) { answer(c, text); if (p.kb) { nav(p.base.replace(/\/kb$/, "")); return; } break; }
        c.feed.push({ kind: "user", ts: "14:01", text });
        S.drafts[c.id] = "";
        if (S.killed.has(c.id)) { toast("Queued — delivers after the respawn"); break; }
        if (c.held) { toast(`Queued — ${c.held + 1} messages wait on the delivery`); c.held += 1; break; }
        if (c.state === "working") { toast("Queued — delivers after the current turn"); break; }
        c.state = "working"; c.elapsed = "0:02"; c.age = "now";
        toast("Sent — delivered to the agent");
        if (p.kb) { nav(p.base.replace(/\/kb$/, "")); return; }
        break;
      }
      case "interrupt": toast("Escape sent — the agent is stopping"); break;
      case "respawn": { const c = conv(rest[0]); S.killed.delete(c.id); c.state = "working"; c.elapsed = "0:01"; toast("Respawned — queued text is delivering"); break; }
      case "kill": {
        const c = conv(rest[0]); S.killed.add(c.id);
        toast("Killed — text you send now queues until a respawn", { label: "Respawn", fn: () => { S.killed.delete(c.id); c.state = "working"; c.elapsed = "0:01"; } });
        nav(`#/chat/${c.id}`); return;
      }
      case "close": {
        const id = rest[0]; S.closed.add(id);
        toast("Closed — still in All conversations", { label: "Reopen", fn: () => { S.closed.delete(id); nav(`#/chat/${id}`); } });
        back(); return;
      }
      case "crown": { const id = rest[0]; if (S.crowned.has(id)) S.crowned.delete(id); else S.crowned.add(id); toast(S.crowned.has(id) ? "Crowned — pinned in every list" : "Crown removed"); nav(`#/chat/${id}`); return; }
      case "killTask": F.host.background = F.host.background.filter((t) => t.pid !== rest[0]); toast(`Killed PID ${rest[0]}`); break;
      case "switchAccount": {
        const [engine, id] = rest; const before = S.activeAccount[engine]; S.activeAccount[engine] = id;
        const a = F.accounts[engine].find((x) => x.id === id);
        toast(`Future launches use ${a.label}`, { label: "Switch back", fn: () => { S.activeAccount[engine] = before; } });
        break;
      }
      case "signIn": { const a = F.accounts[rest[0]].find((x) => x.id === rest[1]); toast(`Device sign-in opens for ${a.label} — it becomes active once signed in`); break; }
      case "refresh": toast("Limits re-read"); break;
      case "useReset": { const a = F.accounts.codex.find((x) => x.id === rest[0]); a.resets.count = 0; a.windows[0].left = 100; a.windows[0].reset = "reset in 5h · 19:32"; toast("Reset used — 5h window is full again, next reset 19:32"); break; }
      case "md": {
        const [id, field, ...val] = rest; const c = conv(id);
        if (field === "account") { c.limit = null; const a = F.accounts[c.engine].find((x) => x.id === val.join(":")); toast(`Next message launches on ${a.label}`); nav(p.base); return; }
        S.model[id] = { ...modelFor(c), [field]: val.join(":") }; nav(p.base); return;
      }
      case "rd": { const [field, ...val] = rest; S.rotateDraft[field] = val.join(":"); if (field === "engine") { S.rotateDraft.model = F.models[S.rotateDraft.engine][0]; S.rotateDraft.account = F.accounts[S.rotateDraft.engine][0].id; } break; }
      case "rotate": {
        const d = S.rotateDraft;
        const creating = !F.seat || F.seat.state === "none";
        F.seat = { ...(creating ? { plan: "Max plan", mandateVersion: 1, predecessor: false, rotation: null, mandate: `You are the ${F.project.name} orchestrator.\n\nYou own this board and you talk to me here.` } : F.seat), state: "live", model: d.model, effort: d.effort, engine: d.engine, account: F.accounts[d.engine].find((a) => a.id === d.account).label, since: "now", ctx: { used: 2, usedLabel: "2k", window: "100k" } };
        let o = conv("orch");
        if (!o) { o = { id: "orch", title: `Orchestrator · ${F.project.name}`, seat: true, account: F.seat.account, ctx: 2, feed: [{ kind: "agent", ts: "14:01", text: "Here. Reading the board first." }] }; F.conversations.unshift(o); }
        Object.assign(o, { model: d.model, effort: d.effort, engine: d.engine, state: "working", elapsed: "0:04", age: "now" });
        toast(creating ? "Orchestrator created — it takes the seat" : "Rotating — the successor takes the seat");
        nav("#/chat/orch"); return;
      }
      case "pipe": {
        const pl = pipeline(rest[0]); const action = rest[1];
        const stage = pl.stages[pl.stage - 1];
        const snap = JSON.stringify(pl);
        const restore = () => Object.assign(pl, JSON.parse(snap));
        if (action === "retry") { stage.state = stage.kind === "review-loop" ? "reviewing" : "running"; stage.round = (stage.round || 0) + 1; pl.state = "running"; pl.stateWord = "running"; toast("Stage retried — a fresh reviewer takes round " + stage.round); }
        if (action === "skip") { stage.state = "skipped"; const next = pl.stages[pl.stage]; if (next) { next.state = "running"; pl.stage += 1; } pl.state = "running"; pl.stateWord = "running"; toast("Stage skipped — the chain moves on", { label: "Retry stage", fn: () => { restore(); act(`pipe:${pl.id}:retry`); } }); }
        if (action === "pause") { pl.state = "paused"; pl.stateWord = "paused"; toast("Paused after the current stage"); }
        if (action === "resume") { pl.state = "running"; pl.stateWord = "running"; toast("Resumed"); }
        if (action === "archive") { const idx = F.pipelines.indexOf(pl); F.pipelines = F.pipelines.filter((x) => x.id !== pl.id); toast("Archived", { label: "Restore", fn: () => { F.pipelines.splice(idx, 0, pl); } }); back(); return; }
        break;
      }
      case "undo": { const u = S.toast && S.toast.undo; S.toast = null; clearTimeout(toastTimer); if (u) { const r = u.fn(); if (r === "navigated") return; } break; }
      case "toggleCompleted": S.showCompleted = !S.showCompleted; break;
      case "qtoggle": S.qopen[rest[0]] = !S.qopen[rest[0]]; break;
      case "next": {
        const items = attention(); if (!items.length) break;
        const here = items.findIndex((a) => (a.kind === "conv" && p.screen === "chat" && p.id === a.id) || (a.kind === "pipeline" && p.screen === "pipeline" && p.id === a.id));
        const target = items[(here + 1) % items.length];
        nav(target.go); return;
      }
      case "project": toast("Project switched — the prototype keeps one project's data"); nav("#/board"); return;
      case "overview": toast("Overview — all projects (same list, every project)"); nav("#/board"); return;
      case "sound": S.sound = !S.sound; break;
      case "awake": S.awake = !S.awake; break;
      case "rename": toast("Rename — the title becomes an inline editor (#1348)"); break;
      case "handoff": toast("Handoff draft opens with this conversation as its source"); break;
      case "compact": toast("Compacting — the band appears in the feed when done"); break;
      case "terminal": toast("Attach command copied"); break;
      case "attach": toast("Opens the photo and file picker"); break;
      case "mic": toast("Dictation — the input becomes the live transcript"); break;
      case "msgActions": toast("Copy · Read aloud"); break;
      case "expand": toast("Expands in place: arguments, output, raw record"); break;
      case "newAgent": toast("Opens a draft agent card"); nav(p.base); return;
      case "newTask": toast("Opens the task editor"); nav(p.base); return;
      case "tasks": toast("Opens the task board sheet (unchanged in v2)"); nav(p.base); return;
      case "newPipeline": toast("Opens the template picker"); nav(p.base); return;
      case "catalog": toast("Opens the full conversation catalog"); break;
      case "workers": toast("Opens the collapsed worker stacks"); break;
      case "archived": toast("Archived projects"); break;
      case "createProject": toast("Create project — name and root directory"); break;
      case "archiveProject": toast("Archived — the project list keeps it under Archive", { label: "Restore", fn: () => {} }); nav("#/board"); return;
      case "predecessor": toast("Opens the predecessor's conversation"); break;
      case "addAccount": toast("Device sign-in opens"); break;
      case "task": toast("Opens the task"); break;
      case "stageNoConv": toast("This stage has not started yet"); return;
      case "noop": return;
      default: break;
    }
    render();
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */
  $phone.addEventListener("click", (event) => {
    const el = event.target.closest("[data-go],[data-act]");
    if (!el) return;
    if (el.classList.contains("scrim") && event.target.closest(".sheet")) return;
    event.preventDefault();
    if (el.dataset.act) { act(el.dataset.act); return; }
    nav(el.dataset.go, { replace: el.dataset.replace === "1" });
  });
  $phone.addEventListener("input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLTextAreaElement) || !el.dataset.draft) return;
    if (el.dataset.draft === "rotate") return;
    S.drafts[el.dataset.draft] = el.value;
    const box = el.closest(".box");
    if (box) {
      box.classList.toggle("has-draft", Boolean(el.value.trim()));
      const send = box.querySelector(".sendbtn");
      if (send) send.classList.toggle("off", !el.value.trim());
    }
  });
  document.addEventListener("click", (event) => {
    const a = event.target.closest("#bench-screens a");
    if (!a) return;
    const url = new URL(a.href);
    if (url.search !== location.search) return; // scenario or scheme changes reload the page
    event.preventDefault();
    nav(url.hash);
  });

  /* Swipe on the bar or the dock: step through the switcher's list in its
     order (orchestrator, Needs you, Working; never Recent); bump at the ends. */
  let swipe = null;
  let drag = null;
  const bump = (side) => { const t = $phone.querySelector(".bar .title"); if (!t) return; t.classList.remove("bump-l", "bump-r"); void t.offsetWidth; t.classList.add(`bump-${side}`); };
  $phone.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; if (!t) return;
    const handle = e.target.closest(".sheet .grab, .sheet .shead");
    if (handle) { const sh = handle.closest(".sheet"); drag = { y: t.clientY, sheet: sh, dy: 0 }; sh.style.transition = "none"; return; }
    if (e.target.closest(".sheet")) return;
    if (e.target.closest(".bar, .dock")) swipe = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  $phone.addEventListener("touchmove", (e) => {
    if (!drag) return;
    drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
    drag.sheet.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: true });
  $phone.addEventListener("touchend", (e) => {
    if (drag) {
      const d = drag; drag = null;
      if (d.dy > 80) { nav(cur().base); return; }
      d.sheet.style.transition = "transform var(--motion-base) var(--ease-standard)";
      d.sheet.style.transform = "";
      return;
    }
    const t = e.changedTouches[0]; const start = swipe; swipe = null;
    const p = cur();
    if (!t || !start || p.screen !== "chat" || p.sheet) return;
    const dx = t.clientX - start.x; const dy = t.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const list = switchList().map((x) => x.id);
    const i = list.indexOf(p.id);
    const j = i + (dx < 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= list.length) { bump(dx < 0 ? "r" : "l"); return; }
    nav(`#/chat/${list[j]}${p.kb ? "/kb" : ""}`, { replace: true, kind: "switch" });
  }, { passive: true });

  const scheme = params.get("scheme");
  if (scheme === "dark" || scheme === "light") root.dataset.theme = scheme;
  const setFrame = (w) => { root.style.setProperty("--frame-w", `${w}px`); root.style.setProperty("--frame-h", w === "430" ? "932px" : "844px"); };
  if (params.get("frame") === "430") setFrame("430");
  const benchFrame = document.getElementById("bench-frame");
  const benchScheme = document.getElementById("bench-scheme");
  if (benchFrame) { benchFrame.value = params.get("frame") === "430" ? "430" : "390"; benchFrame.addEventListener("change", () => setFrame(benchFrame.value)); }
  if (benchScheme) { benchScheme.value = scheme || ""; benchScheme.addEventListener("change", () => { if (benchScheme.value) root.dataset.theme = benchScheme.value; else delete root.dataset.theme; }); }

  if (!location.hash) history.replaceState({ d: 1 }, "", "#/board");
  else history.replaceState({ d: 1 }, "", location.hash);
  armArrival();
  render();
})();
