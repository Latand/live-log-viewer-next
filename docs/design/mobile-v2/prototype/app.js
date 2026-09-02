/* mobile-v2 prototype (issue #1439) — vanilla JS, no build step.

   One hash route + a little in-memory state renders the whole phone. The
   shapes are the product's own (see docs/design/mobile-v2/README.md): one bar,
   one banner slot, one primary surface, sheets for everything secondary, the
   composer and model selector as one unit, and no confirmation prompts. */
(function () {
  "use strict";

  const F = window.FIXTURE;
  const SCREENS = window.SCREENS || [];
  const $phone = document.getElementById("phone");
  const root = document.documentElement;

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
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
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
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
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
    banner: true,
    crowned: new Set(["c1"]),
    killed: new Set(),
    closed: new Set(),
    answered: {},
    pick: {},
    drafts: {},
    model: {},
    toast: null,
    showCompleted: false,
    sound: true,
    awake: false,
    activeAccount: { claude: "cl-main", codex: "cx-main" },
    rotateDraft: { engine: "claude", model: "Opus", effort: "high", account: "cl-main" },
  };
  let toastTimer = null;
  const toast = (text) => {
    S.toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = null; render(); }, 2600);
  };

  const conv = (id) => F.conversations.find((c) => c.id === id);
  const alive = (c) => !S.closed.has(c.id);
  const attention = () => F.attention.filter((a) => !S.answered[a.conv] && alive(conv(a.conv)) && !S.killed.has(a.conv));
  const pipeline = (id) => F.pipelines.find((p) => p.id === id);
  const modelFor = (c) => S.model[c.id] || { model: c.model, effort: c.effort };

  /* ── route ─────────────────────────────────────────────────────────────── */
  const parts = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

  /* ── shared pieces ─────────────────────────────────────────────────────── */
  function stateBits(c) {
    if (S.killed.has(c.id)) return { dot: "stall", text: "killed · messages queue", tone: "tone-danger" };
    if (c.state === "working") return { dot: "live pulse", text: `working ${c.elapsed}`, tone: "tone-success" };
    if (c.state === "waiting" && !S.answered[c.id]) return { dot: "wait", text: `${c.decision} · ${c.since}`, tone: "tone-warning" };
    if (c.state === "returned") return { dot: "acc", text: `finished the turn · ${c.age}`, tone: "" };
    return { dot: "", text: `done · ${c.age}`, tone: "" };
  }
  const mark = (engine, cls) => `<span class="mark ${engine} ${cls || ""}">${I(engine === "codex" ? "command" : "sparkle")}</span>`;

  function bar({ back, title, menuGo, search, attn = true }) {
    const n = attention().length;
    return `<header class="bar">
      ${back ? `<button class="ib" data-go="${back}" aria-label="Back">${I("chevL")}</button>` : ""}
      ${title}
      ${attn && n ? `<button class="attn" data-go="#/board/attention" aria-label="${n} waiting on you"><span>${I("alert")} ${n}</span></button>` : ""}
      ${search ? `<button class="ib" data-go="${search}" aria-label="Find your messages">${I("search")}</button>` : ""}
      ${menuGo ? `<button class="ib" data-go="${menuGo}" aria-label="More actions">${I("more")}</button>` : ""}
    </header>`;
  }

  function banner() {
    const first = attention()[0];
    if (!S.banner || !first) return "";
    const c = conv(first.conv);
    return `<div class="banner">
      <button class="open" data-go="#/chat/${c.id}"><b>Agent is waiting for a reply · ${esc(first.decision)}</b><span>${esc(c.title)}</span></button>
      <button class="ib" data-act="dismissBanner" aria-label="Close the notification">${I("x")}</button>
    </div>`;
  }

  function convRow(c, { go: target = `#/chat/${c.id}`, current = false, quiet = false } = {}) {
    const st = stateBits(c);
    const waiting = c.state === "waiting" && !S.answered[c.id];
    const m = modelFor(c);
    return `<button class="row ${waiting ? "wait" : ""} ${quiet ? "quiet" : ""} ${current ? "on" : ""}" data-go="${target}">
      <span class="dot ${st.dot}"></span>
      <span class="main">
        <span class="t"><span>${esc(c.title)}</span>${S.crowned.has(c.id) ? I("crown", "crownmark") : ""}</span>
        <span class="m">${mark(c.engine)}<span>${esc(m.model)} · ${esc(m.effort)}</span><span class="sep">·</span><span class="${st.tone}">${esc(st.text)}</span></span>
      </span>
      ${waiting ? `<span class="badge b-warning">${esc(c.decision)}</span>` : I("chevR", "chev")}
    </button>`;
  }

  function seatCard() {
    const s = F.seat;
    return `<div class="seat">
      <button class="open" data-go="#/chat/orch" aria-label="Open the orchestrator's conversation">
        <span class="bot">${I("bot")}</span>
        <span class="main">
          <span class="t"><span>Orchestrator</span><span class="badge b-success">${s.stateWord}</span></span>
          <span class="m">${mark(s.engine)}<span>${s.model} · ${s.effort}</span><span class="sep">·</span><span>${esc(s.account)}</span><span class="sep">·</span><span>ctx ${s.ctx.pct}%</span></span>
          <span class="meter ${s.ctx.pct >= 70 ? "warn" : ""}"><i style="width:${s.ctx.pct}%"></i></span>
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
    const parts = [active && `${active} active`, need && `${need} need you`, done && `${done} done`].filter(Boolean).join(" · ");
    return `<button class="row ${need ? "wait" : ""}" data-go="#/pipelines">
      <span class="dots">${active ? '<span class="dot acc"></span>' : ""}${need ? '<span class="dot wait"></span>' : ""}${done ? '<span class="dot live"></span>' : ""}</span>
      <span class="main"><span class="t"><span>${ps.length} pipelines</span></span><span class="m"><span>${parts}</span></span></span>
      ${I("chevR", "chev")}
    </button>`;
  }

  function hostRow() {
    const host = F.host;
    return `<button class="row quiet" data-go="#/board/host">
      <span class="dot ${host.runtime === "live" ? "live" : "wait"}"></span>
      <span class="main"><span class="t"><span>Host</span></span><span class="m"><span>runtime ${host.runtime} · ${host.background.length} background tasks · ${host.hiddenQuiet} quiet · ${host.collapsedWorkers} collapsed workers</span></span></span>
      ${I("chevR", "chev")}
    </button>`;
  }

  /* ── screens ───────────────────────────────────────────────────────────── */
  function Board(sub) {
    const waiting = F.conversations.filter((c) => c.state === "waiting" && !S.answered[c.id] && alive(c) && !S.killed.has(c.id));
    const working = F.conversations.filter((c) => !c.seat && alive(c) && ((c.state === "working" && !S.killed.has(c.id)) || (c.state === "waiting" && S.answered[c.id])));
    const recent = F.conversations.filter((c) => !c.seat && alive(c) && (c.state === "returned" || c.state === "done" || S.killed.has(c.id)));
    const title = `<button class="title" data-go="#/board/projects" aria-label="Switch project"><span class="h1">${esc(F.project.name)}</span>${I("chevD")}</button>`;
    const body = `<div class="body">
      <div class="sh">Orchestrator</div>
      ${seatCard()}
      ${waiting.length ? `<div class="sh">Needs you <span class="n">${waiting.length}</span></div><div class="stack">${waiting.map((c) => convRow(c)).join("")}</div>` : ""}
      <div class="sh">Working <span class="n">${working.length}</span></div>
      <div class="stack">${working.length ? working.map((c) => convRow(c)).join("") : '<div class="empty">Nothing is running.</div>'}</div>
      <div class="sh">Pipelines <span class="n">${F.pipelines.length}</span></div>
      <div class="stack">${pipelinesRow()}</div>
      <div class="sh">Recent <span class="n">${recent.length}</span></div>
      <div class="stack">${recent.map((c) => convRow(c, { quiet: true })).join("")}</div>
      <div class="sh">Host</div>
      <div class="stack" style="padding-bottom:12px">${hostRow()}</div>
    </div>`;
    const dock = `<footer class="dock"><button class="dispatch" data-go="#/chat/orch/kb" aria-label="Tell the orchestrator what should get done"><span class="bot">${I("bot")}</span><span class="ph">Tell the orchestrator what should get done in ${esc(F.project.name)}…</span><span class="mic">${I("mic")}</span></button></footer>`;
    return { html: bar({ title, search: "#/board/search", menuGo: "#/board/menu" }) + banner() + body + dock + boardSheet(sub), screen: "board" };
  }

  function feedItem(c, it) {
    if (it.kind === "user") return `<div class="mu"><div class="bubble">${esc(it.text)}</div></div>`;
    if (it.kind === "agent") {
      return `<div class="ma">
        <button class="who" data-act="msgActions" aria-label="Message actions: copy, read aloud">${mark(c.engine)}<b>${esc(c.model)}</b><time>${it.ts}</time></button>
        <div class="txt">${paras(it.text)}</div>
      </div>`;
    }
    if (it.kind === "group") {
      return `<div class="tl"><button class="tb" data-act="expand">${I("chevR")}<span class="s">${it.count} actions · ${esc(it.parts)}</span><time>${it.range}</time></button></div>`;
    }
    if (it.kind === "tool") {
      const running = it.status === "running";
      const err = it.status === "error";
      const glyph = running ? I("loader", "spin") : err ? I("x") : I("tool");
      return `<div class="tl ${err ? "err" : ""}">
        <button class="tb" data-act="expand">${glyph}<span class="s">${running ? "running " : ""}${esc(it.tool)}${running ? "…" : ""}</span>${err ? '<span class="d">exit 1</span>' : ""}<span class="d">${it.ts ? `${it.ts} · ` : ""}${it.dur}</span></button>
        ${it.link ? `<button class="link" data-go="#/chat/c1" aria-label="Open the conversation this tool read">${I("open")}</button>` : ""}
      </div>${err && it.detail ? `<div class="tld">${esc(it.detail)}</div>` : ""}`;
    }
    return "";
  }

  function questionCard(c) {
    if (!c.question) return "";
    if (S.answered[c.id]) return `<div class="answered">${I("check")}<span>Answered: ${esc(S.answered[c.id])}</span></div>`;
    return `<div class="q">
      <div class="qh">${I("alert")} waiting for your answer · ${c.since}</div>
      <p class="qt">${esc(c.question.text)}</p>
      ${c.question.options.map((o, i) => `<button class="opt ${S.pick[c.id] === i ? "sel" : ""}" data-act="pick:${c.id}:${i}"><i></i><span>${esc(o)}</span></button>`).join("")}
      <div class="own">Or type your own answer below — it is sent as the reply.</div>
    </div>`;
  }

  function composer(c, kb) {
    const killed = S.killed.has(c.id);
    const working = c.state === "working" && !killed;
    const waiting = c.state === "waiting" && !S.answered[c.id] && !killed;
    let status = "";
    /* The status row exists for the states the composer must act on: working
       (elapsed time + Stop) and killed (Respawn). A waiting turn says so in the
       bar's meta line and in the question card — a third copy here would break
       the "a state appears once" rule and steal 36 px from the question. */
    if (!kb && working) status = `<div class="status"><span class="w"><span class="dot live pulse"></span>working · ${c.elapsed}</span><span class="sep">·</span><span>live tail</span><button class="stop" data-act="interrupt">${I("square")} Stop</button></div>`;
    else if (!kb && killed) status = `<div class="status"><span class="w danger">killed · text you send now queues until a respawn</span><button class="stop" data-act="respawn">${I("play")} Respawn</button></div>`;
    const chips = c.suggested && waiting ? `<div class="chips">${c.suggested.map((s) => `<button data-act="chip:${esc(s)}"><span>${esc(s)}</span></button>`).join("")}</div>` : "";
    const draft = S.drafts[c.id] !== undefined ? S.drafts[c.id] : kb ? (waiting ? "Both, by header — and add a test for each format." : "") : "";
    const m = modelFor(c);
    return `<footer class="dock">${status}${chips}
      <label class="box">
        <textarea rows="1" placeholder="${waiting ? "your own answer…" : c.seat ? `what should get done in ${esc(F.project.name)}?` : "message the agent…"}" aria-label="Text for the agent" data-draft="${c.id}">${esc(draft)}</textarea>
        <div class="tools">
          <button class="chip" data-go="#/chat/${c.id}/model" aria-label="Model and reasoning — applies to your next message"><span>${esc(m.model)} · ${esc(m.effort)} ${I("chevD")}</span></button>
          <button class="ib" data-act="attach" aria-label="Add files or images">${I("plus")}</button>
          <button class="ib" data-act="mic" aria-label="Dictate">${I("mic")}</button>
          <button class="send ${draft ? "" : "off"}" data-act="send:${c.id}" aria-label="Send to the agent"><span>${I("arrowUp")}</span></button>
        </div>
      </label>
    </footer>`;
  }

  function keyboard() {
    const row = (n) => `<div class="krow">${"<i></i>".repeat(n)}</div>`;
    return `<div class="kb" aria-hidden="true"><span class="lbl">on-screen keyboard · 336 px</span>${row(10)}${row(9)}<div class="krow"><i class="w"></i>${"<i></i>".repeat(7)}<i class="w"></i></div><div class="krow"><i class="w"></i><i class="sp"></i><i class="w"></i></div></div>`;
  }

  function Chat(id, sub) {
    const c = conv(id);
    if (!c) return Board([]);
    const kb = sub.includes("kb");
    const st = stateBits(c);
    const m = modelFor(c);
    const title = `<button class="title stack" data-go="#/chat/${id}/switch" aria-label="Switch conversation">
      <span class="h1">${esc(c.title)}</span>
      <span class="sub"><span class="dot ${st.dot}"></span><span>${esc(m.model)} · ${esc(m.effort)}</span><span class="sep">·</span><span class="${st.tone}">${esc(st.text)}</span></span>
    </button>`;
    const feed = `<div class="body feed"><div class="msgs">${c.feed.map((it) => feedItem(c, it)).join("")}${questionCard(c)}</div></div>`;
    return {
      html: bar({ back: "#/board", title, menuGo: `#/chat/${id}/menu` }) + feed + composer(c, kb) + (kb ? keyboard() : "") + chatSheet(c, sub),
      screen: "chat",
      kb,
    };
  }

  function pipelineRow(p) {
    const tone = p.state === "needs_decision" ? "b-warning" : p.state === "running" ? "b-accent" : p.state === "completed" ? "b-success" : p.state === "paused" ? "b-neutral" : "b-neutral";
    const dot = p.state === "needs_decision" ? "wait" : p.state === "running" ? "acc pulse" : p.state === "completed" ? "live" : "";
    return `<button class="row ${p.state === "needs_decision" ? "wait" : ""} ${p.state === "completed" ? "quiet" : ""}" data-go="#/pipeline/${p.id}">
      <span class="dot ${dot}"></span>
      <span class="main"><span class="t"><span>${esc(p.task)}</span></span><span class="m"><span>stage ${p.stage}/${p.total}</span><span class="sep">·</span><span>${esc(p.stages[p.stage - 1].name)} · ${esc(p.stages[p.stage - 1].state.replace("_", " "))}</span><span class="sep">·</span><span>${esc(p.started)}</span></span></span>
      <span class="badge ${tone}">${esc(p.stateWord)}</span>
    </button>`;
  }

  function Pipelines() {
    const need = F.pipelines.filter((p) => p.state === "needs_decision");
    const active = F.pipelines.filter((p) => p.state === "running" || p.state === "paused");
    const done = F.pipelines.filter((p) => p.state === "completed");
    const title = `<div class="title"><span class="h1">Pipelines</span></div>`;
    const body = `<div class="body">
      ${need.length ? `<div class="sh">Needs you <span class="n">${need.length}</span></div><div class="stack">${need.map(pipelineRow).join("")}</div>` : ""}
      <div class="sh">Active <span class="n">${active.length}</span></div>
      <div class="stack">${active.length ? active.map(pipelineRow).join("") : '<div class="empty">No pipeline is running.</div>'}</div>
      <div class="sh"><button class="hbtn" style="margin:0 0 0 -8px" data-act="toggleCompleted">${I(S.showCompleted ? "chevD" : "chevR")} ${done.length} completed</button></div>
      ${S.showCompleted ? `<div class="stack">${done.map(pipelineRow).join("")}</div>` : ""}
      <div style="height:16px"></div>
    </div>`;
    return { html: bar({ back: "#/board", title, menuGo: "#/board/menu" }) + body, screen: "pipelines" };
  }

  function PipelineDetail(id) {
    const p = pipeline(id);
    if (!p) return Pipelines();
    const title = `<div class="title"><span class="h1">Pipeline</span></div>`;
    const tone = p.state === "needs_decision" ? "b-warning" : p.state === "running" ? "b-accent" : p.state === "completed" ? "b-success" : "b-neutral";
    const stages = p.stages.map((s, i) => {
      const k = s.state === "passed" ? `<span class="k pass">${I("check")}</span>` : s.state === "failed" ? `<span class="k fail">${I("x")}</span>` : s.state === "skipped" ? `<span class="k skip">${i + 1}</span>` : s.state === "running" || s.state === "reviewing" ? `<span class="k run">${I("loader", "spin")}</span>` : `<span class="k">${i + 1}</span>`;
      const cur = i === p.stage - 1 && p.state !== "completed";
      const meta = [s.kind === "review-loop" ? `review loop${s.round ? ` · round ${s.round}` : ""}` : "run", s.state.replace("_", " "), s.findings ? `${s.findings} findings` : ""].filter(Boolean).join(" · ");
      const openable = Boolean(s.conv);
      return `<button class="stg ${cur ? "cur" : ""}" data-go="${openable ? `#/chat/${s.conv}` : `#/pipeline/${p.id}`}" ${openable ? "" : 'data-act="stageNoConv"'}>${k}<span class="main"><span class="t"><span>${esc(s.name)}</span></span><span class="m"><span>${esc(meta)}</span></span></span>${openable ? I("chevR", "chev") : ""}</button>`;
    }).join("");
    const actions = p.state === "needs_decision"
      ? `<div class="actions"><button class="btn" data-act="pipe:${p.id}:skip">${I("skip")} Skip stage</button><button class="btn primary" data-act="pipe:${p.id}:retry">${I("refresh")} Retry stage</button></div>`
      : p.state === "running"
        ? `<div class="actions"><button class="btn" data-act="pipe:${p.id}:pause">${I("pause")} Pause</button></div>`
        : p.state === "paused"
          ? `<div class="actions"><button class="btn primary" data-act="pipe:${p.id}:resume">${I("play")} Resume</button></div>`
          : `<div class="actions"><button class="btn" data-act="pipe:${p.id}:archive">${I("archive")} Archive</button></div>`;
    const body = `<div class="body">
      <div class="phead">
        <div class="pt">${esc(p.task)}</div>
        <div class="m"><span class="badge ${tone}">${esc(p.stateWord)}</span><span>stage ${p.stage}/${p.total}</span><span class="sep">·</span><span>started ${esc(p.started)}</span></div>
        <div class="m"><span>${esc(p.template)}</span></div>
      </div>
      ${p.findings && p.state === "needs_decision" ? `<div class="findings"><b>Review round ${p.stages[p.stage - 1].round} · REQUEST_CHANGES</b><ol>${p.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol></div>` : ""}
      ${actions}
      <div class="sh">Stages <span class="n">${p.total}</span></div>
      <div class="stages">${stages}</div>
      ${p.tasks.length ? `<div class="sh">Linked tasks <span class="n">${p.tasks.length}</span></div><div class="stack">${p.tasks.map((t) => `<button class="row quiet" data-act="task"><span class="dot"></span><span class="main"><span class="t"><span>${esc(t.title)}</span></span><span class="m"><span>${t.status}</span></span></span>${I("chevR", "chev")}</button>`).join("")}</div>` : ""}
      <div style="height:16px"></div>
    </div>`;
    return { html: bar({ back: "#/pipelines", title, menuGo: "#/board/menu" }) + body, screen: "pipeline" };
  }

  function accountCard(engine, a) {
    const active = S.activeAccount[engine] === a.id;
    const cap = a.windows ? Math.min(...a.windows.map((w) => w.pct)) : null;
    const capCls = cap === null ? "" : cap <= 10 ? "low" : cap <= 30 ? "warn" : "";
    const state = active ? '<span class="badge b-success">active</span>' : a.auth === "Authenticated" ? '<span class="badge b-neutral">ready</span>' : `<span class="badge b-warning">${esc(a.auth)}</span>`;
    const head = `<span class="main"><span class="t"><span>${esc(a.label)}</span>${state}</span><span class="m"><span>${esc(a.plan)}</span>${a.checked ? `<span class="sep">·</span><span>checked ${a.checked}</span>` : ""}</span></span>${cap !== null ? `<span class="cap ${capCls}">${cap}% left</span>` : ""}`;
    const row = active
      ? `<div class="arow">${mark(engine, "lg")}${head}</div>`
      : `<button class="arow" data-act="switchAccount:${engine}:${a.id}" aria-label="Use ${esc(a.label)} for future launches">${mark(engine, "lg")}${head}${I("chevR", "chev")}</button>`;
    if (!active) return `<div class="acct off">${row}</div>`;
    const wins = (a.windows || []).map((w) => `<div class="win"><b>${esc(w.label)}</b><span class="meter ${w.pct <= 10 ? "low" : w.pct <= 30 ? "warn" : ""}"><i style="width:${w.pct}%"></i></span><span class="pct">${w.pct}% left</span><span></span><span class="reset">${esc(w.reset)}</span></div>`).join("");
    const resets = a.resets ? `<div class="resets">${a.resets.count ? `${a.resets.count} reset available · expires ${esc(a.resets.expires)}` : "No resets available"}</div>` : "";
    return `<div class="acct">${row}<div class="wins">${wins}</div>${resets}
      <div class="acts">
        <button data-act="refresh:${a.id}" aria-label="Re-read limits for ${esc(a.label)}">${I("refresh")} Refresh</button>
        ${a.resets && a.resets.count ? `<button data-act="useReset:${a.id}" aria-label="Use one usage-limit reset on ${esc(a.label)}">${I("zap")} Use one reset</button>` : ""}
      </div>
    </div>`;
  }

  function Accounts() {
    const title = `<div class="title"><span class="h1">Accounts &amp; limits</span></div>`;
    const section = (engine, label) => `<div class="sh">${label} <span class="n">${F.accounts[engine].length}</span></div>${F.accounts[engine].map((a) => accountCard(engine, a)).join("")}<div class="stack"><button class="row quiet" data-act="addAccount:${engine}"><span class="dot"></span><span class="main"><span class="t"><span>Add a ${label} account</span></span><span class="m"><span>opens the device sign-in</span></span></span>${I("plus", "chev")}</button></div>`;
    const body = `<div class="body">${section("claude", "Claude")}${section("codex", "Codex")}<div class="note" style="padding:12px 16px 20px">Tap an account to use it for future launches. Refresh re-reads that account's live limits; Use one reset redeems one usage-limit reset. Nothing here asks you to confirm.</div></div>`;
    return { html: bar({ back: "#/board", title, menuGo: "#/board/menu" }) + body, screen: "accounts" };
  }

  /* ── sheets ────────────────────────────────────────────────────────────── */
  function sheet(title, body, { full = false, foot = "", closeGo, extra = "" }) {
    return `<div class="scrim" data-go="${closeGo}">
      <div class="sheet ${full ? "full" : ""}" role="dialog" aria-label="${esc(title)}">
        ${full ? "" : '<div class="grab"></div>'}
        <div class="shead"><h2>${title}</h2>${extra}<button class="ib" data-go="${closeGo}" aria-label="Close">${I("x")}</button></div>
        <div class="sbody">${body}</div>
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
    const body = items.length
      ? items.map((a) => { const c = conv(a.conv); return `<button class="mrow" data-go="#/chat/${c.id}"><span class="dot wait"></span><span class="main"><span class="t"><span>${esc(c.title)}</span></span><span class="m"><span>${esc(a.decision)} · ${esc(a.since)}</span><span class="sep">·</span>${mark(c.engine)}<span>${esc(c.model)}</span></span></span>${I("chevR", "chev")}</button>`; }).join("")
      : '<div class="empty">Nothing is waiting on you.</div>';
    const extra = items.length ? `<button class="hbtn" data-act="next">Next ${I("chevR")}</button>` : "";
    return sheet(`Waiting on you${items.length ? ` · ${items.length}` : ""}`, body, { closeGo, extra });
  }

  function boardMenu(closeGo) {
    const body = `
      <button class="mrow" data-act="newAgent">${I("plus")}<span>New agent</span></button>
      <button class="mrow" data-act="newTask">${I("list")}<span>New task</span></button>
      <button class="mrow" data-act="newPipeline">${I("tree")}<span>New pipeline</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="tasks">${I("list")}<span>Tasks</span><span class="r">3 open</span></button>
      <button class="mrow" data-act="catalog">${I("grid")}<span>All conversations</span><span class="r">catalog · ${F.host.hiddenQuiet + 6}</span></button>
      <button class="mrow" data-go="#/accounts">${I("person")}<span>Accounts &amp; limits</span><span class="r">Main · 12% left</span></button>
      <button class="mrow" data-go="#/board/host">${I("info")}<span>Host details</span><span class="r">${F.host.background.length} tasks</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="sound">${I("bell")}<span>Sound alerts</span><span class="r">${S.sound ? "On" : "Off"}</span></button>
      <button class="mrow" data-act="awake">${I("sun")}<span>Keep screen awake</span><span class="r">${S.awake ? "On" : "Off"}</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="archiveProject">${I("archive")}<span>Archive project</span></button>`;
    return sheet(esc(F.project.name), body, { closeGo });
  }

  function hostSheet(closeGo, c) {
    const host = F.host;
    const tasks = host.background.length
      ? host.background.map((t) => `<div class="rowd"><span class="dot ${t.live ? "live" : ""}"></span><span class="main"><span class="t"><span>${esc(t.title)}</span></span><span class="m"><span class="mono">PID ${t.pid}</span></span></span><button class="kill" data-act="killTask:${t.pid}" aria-label="Kill ${esc(t.title)}">Kill</button></div>`).join("")
      : '<div class="empty">No background tasks.</div>';
    const convBlock = c ? `
      <div class="sh">This conversation</div>
      <div class="kv"><span class="k">Account</span><span class="v">${esc(c.account)} · ${c.engine === "claude" ? "Max plan" : "Pro plan"}</span></div>
      <div class="kv"><span class="k">Context</span><span class="v"><span class="meter ${c.ctx >= 70 ? "warn" : ""}" style="max-width:120px"><i style="width:${c.ctx}%"></i></span>${c.ctx}%</span></div>
      ${c.worktree ? `<div class="kv"><span class="k">Worktree</span><span class="v mono">${esc(c.worktree)}</span></div>` : ""}
      <div class="kv"><span class="k">Transport</span><span class="v">structured host · ${esc(c.engine)}</span></div>
      <div class="hr"></div>` : "";
    const body = `${convBlock}
      <div class="kv"><span class="k">Runtime</span><span class="v"><span class="badge ${host.runtime === "live" ? "b-success" : "b-warning"}">${host.runtime}</span><span>updates stream; polling stands by</span></span></div>
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
    const body = `
      <div class="seatid"><span class="bot">${I("bot")}</span><span class="main"><span class="t"><span>${s.model} · ${s.effort}</span><span class="badge b-success">${s.stateWord}</span></span><span class="m">${mark(s.engine)}<span>${esc(s.account)}</span><span class="sep">·</span><span>holding the seat for ${s.since}</span></span></span></div>
      <div class="kv"><span class="k">Context</span><span class="v"><span class="meter ${s.ctx.pct >= 70 ? "warn" : ""}" style="max-width:140px"><i style="width:${s.ctx.pct}%"></i></span><span>${s.ctx.used} of ${s.ctx.window} · ${s.ctx.pct}%</span></span></div>
      <div class="kv"><span class="k">Working dir</span><span class="v mono">the project's checkout</span></div>
      ${s.rotation ? `<div class="note warn">Rotation recommended — context is at ${s.ctx.pct}% of the model's window.</div>` : ""}
      ${s.predecessor ? `<button class="mrow" data-act="predecessor">${I("branch")}<span>Replaced an earlier orchestrator</span><span class="r">open ${I("chevR")}</span></button>` : ""}
      <div class="sh">Mandate v${s.mandateVersion} — built-in operating rules</div>
      <div class="mandate">${esc(s.mandate)}</div>
      <button class="mrow" data-go="#/board/seat/rotate">${I("pencil")}<span>Edit the mandate</span><span class="r">opens a rotation</span></button>
      <div class="note">Changing the mandate, model or account means a successor takes the seat. Nothing rotates until you confirm the draft.</div>`;
    const foot = `<button class="btn" data-go="#/board/seat/rotate">${I("rotate")} Rotate</button><button class="btn primary" data-go="#/chat/orch">Open conversation</button>`;
    /* A bottom sheet: the seat reads in half a screen and
       its two actions park at the thumb, with the board still visible behind. */
    return sheet(`Orchestrator · ${esc(F.project.name)}`, body, { foot, closeGo });
  }

  function rotateSheet(closeGo) {
    const d = S.rotateDraft;
    const seg = (name, options, current) => `<div class="seg">${options.map((o) => `<button class="${o === current ? "on" : ""}" data-act="rd:${name}:${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
    const accounts = F.accounts[d.engine].map((a) => `<button class="mrow ${d.account === a.id ? "sel" : ""}" data-act="rd:account:${a.id}">${mark(d.engine)}<span>${esc(a.label)}</span><span class="r">${esc(a.plan)}${d.account === a.id ? I("check", "check") : ""}</span></button>`).join("");
    const body = `
      <div class="note">The successor starts with the mandate below. Its predecessor's transcript and this project's open tasks are handed over by the server; the predecessor's conversation stays on the board, linked to the new one.</div>
      <div class="field"><label>Engine</label>${seg("engine", ["claude", "codex"], d.engine)}</div>
      <div class="field"><label>Model</label>${seg("model", F.models[d.engine], d.model)}</div>
      <div class="field"><label>Reasoning</label>${seg("effort", F.models.efforts, d.effort)}</div>
      <div class="field"><label>Account</label></div>
      ${accounts}
      <div class="field"><label>Mandate</label><textarea class="ta" aria-label="Mandate" data-draft="rotate">${esc(F.seat.mandate)}</textarea></div>
      <div class="note">The successor continues in the project's checkout.</div>`;
    const foot = `<button class="btn" data-go="#/board/seat">Keep this one</button><button class="btn primary" data-act="rotate">${I("rotate")} Rotate orchestrator</button>`;
    return sheet("Replace the orchestrator", body, { full: true, foot, closeGo });
  }

  function boardSheet(sub) {
    const s = sub[0];
    if (s === "projects") return projectsSheet("#/board");
    if (s === "attention") return attentionSheet("#/board");
    if (s === "menu") return boardMenu("#/board");
    if (s === "host") return hostSheet("#/board", null);
    if (s === "search") return searchSheet("#/board");
    if (s === "seat") return sub[1] === "rotate" ? rotateSheet("#/board/seat") : seatSheet("#/board");
    return "";
  }

  function chatMenu(c, closeGo) {
    const crowned = S.crowned.has(c.id);
    const body = `
      ${c.seat ? `<button class="mrow" data-go="#/board/seat">${I("bot")}<span>Orchestrator seat</span><span class="r">status · rotate · mandate</span></button><div class="hr"></div>` : ""}
      <button class="mrow" data-act="rename">${I("pencil")}<span>Rename</span></button>
      <button class="mrow" data-act="crown:${c.id}">${I("crown", crowned ? "crown" : "")}<span>${crowned ? "Remove crown" : "Crown"}</span></button>
      <button class="mrow" data-act="handoff">${I("swap")}<span>Hand off to a new agent</span></button>
      <button class="mrow" data-act="compact">${I("compress")}<span>Compact context</span><span class="r">ctx ${c.ctx}%</span></button>
      <button class="mrow" data-go="#/chat/${c.id}/host">${I("info")}<span>Details &amp; host</span><span class="r">${F.host.background.length} tasks</span></button>
      <button class="mrow" data-act="terminal">${I("terminal")}<span>Open in terminal</span></button>
      <div class="hr"></div>
      <button class="mrow" data-act="close:${c.id}">${I("x")}<span>Close card</span><span class="r">stays in the catalog</span></button>
      <button class="mrow danger" data-act="kill:${c.id}">${I("square")}<span>Kill agent</span><span class="r">${c.state === "working" ? "running now" : "not running"}</span></button>`;
    return sheet(esc(c.title), body, { closeGo });
  }

  function switchSheet(c, closeGo) {
    const row = (x) => { const st = stateBits(x); const m = modelFor(x); return `<button class="mrow ${x.id === c.id ? "sel" : ""}" data-go="#/chat/${x.id}"><span class="dot ${st.dot}"></span><span class="main"><span class="t"><span>${esc(x.title)}</span></span><span class="m">${mark(x.engine)}<span>${esc(m.model)}</span><span class="sep">·</span><span class="${st.tone}">${esc(st.text)}</span></span></span>${x.id === c.id ? I("check", "check") : ""}</button>`; };
    const list = F.conversations.filter((x) => !x.seat && alive(x));
    const waiting = list.filter((x) => x.state === "waiting" && !S.answered[x.id] && !S.killed.has(x.id));
    const working = list.filter((x) => (x.state === "working" && !S.killed.has(x.id)) || (x.state === "waiting" && S.answered[x.id]));
    const recent = list.filter((x) => x.state === "returned" || x.state === "done" || S.killed.has(x.id));
    const body = `
      ${row(conv("orch"))}
      ${waiting.length ? `<div class="sh">Needs you <span class="n">${waiting.length}</span></div>${waiting.map(row).join("")}` : ""}
      <div class="sh">Working <span class="n">${working.length}</span></div>${working.map(row).join("")}
      <div class="sh">Recent <span class="n">${recent.length}</span></div>${recent.map(row).join("")}
      <div class="note">Swipe the title bar left or right to step through this list without opening it.</div>`;
    return sheet(esc(F.project.name), body, { closeGo, extra: `<button class="hbtn" data-go="#/board">Board ${I("chevR")}</button>` });
  }

  function modelSheet(c, closeGo) {
    const m = modelFor(c);
    const rows = (name, options, current) => options.map((o) => `<button class="mrow ${o === current ? "sel" : ""}" data-act="md:${c.id}:${name}:${esc(o)}"><span>${esc(o)}</span><span class="r">${o === current ? I("check", "check") : ""}</span></button>`).join("");
    const body = `
      <div class="note">Applies to your next message: <b>${esc(m.model)} · ${esc(m.effort)}</b></div>
      <div class="sh">Model</div>${rows("model", F.models[c.engine], m.model)}
      <div class="sh">Reasoning</div>${rows("effort", F.models.efforts, m.effort)}
      ${c.engine === "codex" ? `<div class="sh">Speed</div>${rows("speed", ["standard", "fast — priority tier"], m.speed || "standard")}` : ""}`;
    return sheet("Next message", body, { closeGo });
  }

  function chatSheet(c, sub) {
    const s = sub.find((x) => x !== "kb");
    const closeGo = `#/chat/${c.id}`;
    if (s === "menu") return chatMenu(c, closeGo);
    if (s === "switch") return switchSheet(c, closeGo);
    if (s === "model") return modelSheet(c, closeGo);
    if (s === "host") return hostSheet(closeGo, c);
    return "";
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  function render() {
    const p = parts();
    const screen = p[0] || "board";
    let out;
    if (screen === "chat") out = Chat(p[1], p.slice(2));
    else if (screen === "pipelines") out = Pipelines();
    else if (screen === "pipeline") out = PipelineDetail(p[1]);
    else if (screen === "accounts") out = Accounts();
    else out = Board(p.slice(1));
    $phone.className = out.kb ? "kbopen" : "";
    $phone.dataset.screen = out.screen;
    $phone.innerHTML = out.html + (S.toast ? `<div class="toast" role="status">${I("check")}<span>${esc(S.toast)}</span></div>` : "");
    const feed = $phone.querySelector(".feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
    if (out.kb) {
      const ta = $phone.querySelector(".box textarea");
      if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
    const nav = document.getElementById("bench-screens");
    if (nav) nav.innerHTML = SCREENS.map((s) => `<a href="${s.hash}" class="${location.hash === s.hash ? "on" : ""}" title="${esc(s.title)}">${s.id}</a>`).join("");
    $phone.dataset.ready = "1";
  }

  /* ── actions (no confirmation prompts anywhere) ────────────────────────── */
  function act(name) {
    const [head, ...rest] = name.split(":");
    const p = parts();
    const current = p[0] === "chat" ? conv(p[1]) : null;
    switch (head) {
      case "dismissBanner": S.banner = false; break;
      case "pick": {
        const c = conv(rest[0]);
        const i = Number(rest[1]);
        S.pick[c.id] = i;
        S.answered[c.id] = c.question.options[i].split(" — ")[0];
        c.state = "working"; c.elapsed = "0:03"; c.age = "now";
        toast(`Answer sent — ${S.answered[c.id]}`);
        break;
      }
      case "chip": if (current) S.drafts[current.id] = rest.join(":"); break;
      case "send": {
        const c = conv(rest[0]);
        const text = (S.drafts[c.id] || "").trim();
        if (!text) { toast("Nothing to send yet"); break; }
        c.feed.push({ kind: "user", ts: "14:01", text });
        S.drafts[c.id] = "";
        if (c.state === "waiting") S.answered[c.id] = text;
        if (S.killed.has(c.id)) { toast("Queued — delivers after the respawn"); break; }
        c.state = "working"; c.elapsed = "0:02"; c.age = "now";
        toast("Sent — delivered to the agent");
        if (p.includes("kb")) { go(`#/chat/${c.id}`); return; }
        break;
      }
      case "interrupt": toast("Escape sent — the agent is stopping"); break;
      case "respawn": if (current) { S.killed.delete(current.id); current.state = "working"; current.elapsed = "0:01"; toast("Respawned — queued text is delivering"); } break;
      case "kill": { const c = conv(rest[0]); S.killed.add(c.id); toast("Killed — text you send now queues until a respawn"); go(`#/chat/${c.id}`); return; }
      case "close": { S.closed.add(rest[0]); toast("Closed — still in All conversations"); go("#/board"); return; }
      case "crown": { const id = rest[0]; if (S.crowned.has(id)) S.crowned.delete(id); else S.crowned.add(id); toast(S.crowned.has(id) ? "Crowned — pinned in every list" : "Crown removed"); go(`#/chat/${id}`); return; }
      case "killTask": F.host.background = F.host.background.filter((t) => t.pid !== rest[0]); toast(`Killed PID ${rest[0]}`); break;
      case "switchAccount": { const [engine, id] = rest; S.activeAccount[engine] = id; const a = F.accounts[engine].find((x) => x.id === id); toast(`Future launches use ${a.label}`); break; }
      case "refresh": toast("Limits re-read"); break;
      case "useReset": { const a = F.accounts.codex.find((x) => x.id === rest[0]); a.resets.count = 0; a.windows[0].pct = 100; a.windows[0].reset = "reset in 5h · 19:32"; toast("Reset used — the new window is shown"); break; }
      case "md": { const [id, field, ...val] = rest; const c = conv(id); S.model[id] = { ...modelFor(c), [field]: val.join(":") }; go(`#/chat/${id}`); return; }
      case "rd": { const [field, ...val] = rest; S.rotateDraft[field] = val.join(":"); if (field === "engine") { S.rotateDraft.model = F.models[S.rotateDraft.engine][0]; S.rotateDraft.account = F.accounts[S.rotateDraft.engine][0].id; } break; }
      case "rotate": { const d = S.rotateDraft; Object.assign(F.seat, { model: d.model, effort: d.effort, engine: d.engine, since: "now", ctx: { pct: 2, used: "2k", window: "100k" } }); const o = conv("orch"); o.model = d.model; o.effort = d.effort; o.engine = d.engine; o.elapsed = "0:04"; toast("Rotating — the successor takes the seat"); go("#/chat/orch"); return; }
      case "pipe": {
        const pl = pipeline(rest[0]); const action = rest[1];
        const stage = pl.stages[pl.stage - 1];
        if (action === "retry") { stage.state = stage.kind === "review-loop" ? "reviewing" : "running"; stage.round = (stage.round || 0) + 1; pl.state = "running"; pl.stateWord = "running"; toast("Stage retried — a fresh reviewer takes round " + stage.round); }
        if (action === "skip") { stage.state = "skipped"; const next = pl.stages[pl.stage]; if (next) { next.state = "running"; pl.stage += 1; } pl.state = "running"; pl.stateWord = "running"; toast("Stage skipped — the chain moves on"); }
        if (action === "pause") { pl.state = "paused"; pl.stateWord = "paused"; toast("Paused after the current stage"); }
        if (action === "resume") { pl.state = "running"; pl.stateWord = "running"; toast("Resumed"); }
        if (action === "archive") { F.pipelines = F.pipelines.filter((x) => x.id !== pl.id); toast("Archived"); go("#/pipelines"); return; }
        break;
      }
      case "toggleCompleted": S.showCompleted = !S.showCompleted; break;
      case "next": { const a = attention()[0]; if (a) { go(`#/chat/${a.conv}`); return; } break; }
      case "project": toast("Project switched — the prototype keeps one project's data"); go("#/board"); return;
      case "overview": toast("Overview — all projects (same list, every project)"); go("#/board"); return;
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
      case "newAgent": toast("Opens a draft agent card"); go("#/board"); return;
      case "newTask": toast("Opens the task editor"); go("#/board"); return;
      case "tasks": toast("Opens the task board sheet (unchanged in v2)"); go("#/board"); return;
      case "newPipeline": toast("Opens the template picker"); go("#/board"); return;
      case "catalog": toast("Opens the full conversation catalog"); break;
      case "workers": toast("Opens the collapsed worker stacks"); break;
      case "archived": toast("Archived projects"); break;
      case "createProject": toast("Create project — name and root directory"); break;
      case "archiveProject": toast("Archived — restore from the project list"); go("#/board"); return;
      case "predecessor": toast("Opens the predecessor's conversation"); break;
      case "addAccount": toast("Device sign-in opens"); break;
      case "task": toast("Opens the task"); break;
      case "stageNoConv": toast("This stage has not started yet"); return;
      default: break;
    }
    render();
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */
  $phone.addEventListener("click", (event) => {
    const el = event.target.closest("[data-go],[data-act]");
    if (!el) return;
    if (el.classList.contains("scrim") && event.target.closest(".sheet")) return;
    if (el.dataset.act) { event.preventDefault(); act(el.dataset.act); return; }
    event.preventDefault();
    go(el.dataset.go);
  });
  $phone.addEventListener("input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLTextAreaElement) || !el.dataset.draft) return;
    if (el.dataset.draft === "rotate") return;
    S.drafts[el.dataset.draft] = el.value;
    const send = $phone.querySelector(".box .send");
    if (send) send.classList.toggle("off", !el.value.trim());
  });
  /* Header swipe: step through the conversation list without opening it. */
  let swipe = null;
  $phone.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (t && e.target.closest(".bar")) swipe = { x: t.clientX, y: t.clientY }; }, { passive: true });
  $phone.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0]; const start = swipe; swipe = null;
    if (!t || !start || parts()[0] !== "chat") return;
    const dx = t.clientX - start.x; const dy = t.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const list = F.conversations.filter((x) => alive(x)).map((x) => x.id);
    const i = list.indexOf(parts()[1]);
    const next = list[Math.min(list.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)))];
    if (next) go(`#/chat/${next}`);
  }, { passive: true });

  const params = new URLSearchParams(location.search);
  const scheme = params.get("scheme");
  if (scheme === "dark" || scheme === "light") root.dataset.theme = scheme;
  const setFrame = (w) => { root.style.setProperty("--frame-w", `${w}px`); root.style.setProperty("--frame-h", w === "430" ? "932px" : "844px"); };
  if (params.get("frame") === "430") setFrame("430");
  const benchFrame = document.getElementById("bench-frame");
  const benchScheme = document.getElementById("bench-scheme");
  if (benchFrame) { benchFrame.value = params.get("frame") === "430" ? "430" : "390"; benchFrame.addEventListener("change", () => setFrame(benchFrame.value)); }
  if (benchScheme) { benchScheme.value = scheme || ""; benchScheme.addEventListener("change", () => { if (benchScheme.value) root.dataset.theme = benchScheme.value; else delete root.dataset.theme; }); }

  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash = "#/board";
  render();
})();
