/* desktop-v2 prototype (issue #1453) — vanilla JS, no build step.

   One frame: rail (projects) · column (the project's triage list, the seat
   first) · stage (one primary surface: a conversation, a pipeline, the seat,
   accounts, the map, the overview) · an optional pinned pane at ≥ 1600 px ·
   a status bar (runtime, accounts, hosts). Dialogs and popovers open over the
   stage and never create history; stage routes push. Every action acts on the
   click and answers with a receipt that carries the inverse action. The
   keyboard map is single keys while nothing is being typed (the product's own
   convention: n, N, /), so a power user never leaves the home row.

   The shapes are docs/design/desktop-v2/README.md; the vocabulary and the
   state precedence are the mobile-v2 ones (docs/design/mobile-v2/README.md). */
(function () {
  "use strict";

  const F = window.FIXTURE;
  const SCREENS = window.SCREENS || [];
  const $app = document.getElementById("app");
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const scenario = params.get("scenario");
  if (scenario && window.SCENARIOS && window.SCENARIOS[scenario]) window.SCENARIOS[scenario](F);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── icons (24 × 24, stroke) ───────────────────────────────────────────── */
  const ICONS = {
    chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    bot: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M12 9V5"/><path d="M9 14h.01M15 14h.01"/><path d="M2 14h2M20 14h2"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', arrowR: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="2"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>', check: '<path d="m5 12 5 5L20 7"/>',
    crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>', layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>',
    sparkle: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/>',
    command: '<path d="M15 6a3 3 0 1 1 3 3h-3V6zM9 6a3 3 0 1 0-3 3h3V6zM15 18a3 3 0 1 0 3-3h-3v3zM9 18a3 3 0 1 1-3-3h3v3z"/><path d="M9 9h6v6H9z"/>',
    terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 17h7"/>', pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13 7 4 4"/>',
    open: '<path d="M14 5h5v5"/><path d="M19 5l-9 9"/><path d="M19 13v6H5V5h6"/>', folder: '<path d="M3 6h6l2 2h10v11H3V6z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>', person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="M7 4v16l13-8L7 4z"/>', skip: '<path d="M5 5v14l9-7-9-7z"/><path d="M19 5v14"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10"/><path d="M18 10a6 6 0 0 1-6 6H6"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v4"/>',
    tool: '<path d="M14.5 4.5a5 5 0 0 0-6 6.3L3 16.3V21h4.7l5.5-5.5a5 5 0 0 0 6.3-6l-3 3-3-1-1-3 3-3z"/>',
    compress: '<path d="M4 14h5v5M20 10h-5V5M9 14l-5 5M15 10l5-5"/>', archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3V9z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    wifiOff: '<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12.5a10 10 0 0 1 8.5-2.8"/><path d="M8.5 16a5 5 0 0 1 4-1.3"/><path d="M12 20h.01"/><path d="m3 3 18 18"/>',
    pin: '<path d="M12 17v5"/><path d="M8 3h8l-1 7 3 3H6l3-3-1-7z"/>', panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>', paper: '<path d="M21 3 3 10l7 3 3 7 8-17z"/>',
    flag: '<path d="M5 21V4h12l-2 4 2 4H5"/>', plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    clip: '<path d="m16 6-7.5 7.5a2 2 0 0 0 3 3L19 9a4 4 0 0 0-6-6L5.5 10.5a6 6 0 0 0 8.5 8.5L20 13"/>',
    fitBox: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>', minus: '<path d="M5 12h14"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  };
  const I = (name, cls) => `<svg class="i ${cls || ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const paras = (text) => String(text).split(/\n\n+/).map((p) => {
    const lines = p.split("\n");
    if (lines.every((l) => l.startsWith("- "))) return `<ul>${lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join("")}</ul>`;
    return `<p>${esc(p)}</p>`;
  }).join("");
  const mark = (engine, cls) => `<svg class="mark ${engine} ${cls || ""}" viewBox="0 0 24 24" aria-hidden="true">${engine === "codex" ? ICONS.command : ICONS.sparkle}</svg>`;

  /* ── state ─────────────────────────────────────────────────────────────── */
  const S = {
    project: F.project, view: "list", rail: params.get("rail") !== "0", pin: F.pin || null,
    crowned: new Set(["c1"]), killed: new Set(), closed: new Set(), seen: new Set(), collapsed: new Set(), recentAll: false,
    drafts: {}, next: {}, sound: true, toast: null, toastTimer: null, arrival: null, arrivalTimer: null, arrivalDismissed: false,
    hl: -1, filter: "", search: "", searchScope: "mine", answers: {}, editorDraft: null, archivedProjects: new Set(), deletedProjects: new Set(),
    pickedOption: {}, trigger: null, cycle: -1,
  };
  const P = (id) => F.projects.find((p) => p.id === id);
  const conv = (id) => F.conversations.find((c) => c.id === id);
  const pipe = (id) => F.pipelines.find((p) => p.id === id);
  const width = () => Number($app.dataset.w || 1440);
  const canPin = () => width() >= 1600;
  const seatConv = () => F.conversations.find((c) => c.seat && c.project === S.project);

  /* ── state precedence — one place, used by every surface ──────────────── */
  function stateBits(c) {
    if (S.killed.has(c.id) || c.state === "killed") return { key: "killed", tone: "dng", dot: "dng", phrase: "killed · messages queue", badge: null };
    if (c.state === "stalled") return { key: "stalled", tone: "dng", dot: "dng", phrase: `stalled · ${c.stalledFor || "14 min"}`, badge: "stalled", edge: "dng" };
    if (c.state === "limit") return { key: "limit", tone: "warn", dot: "warn", phrase: `limit · ${c.account || "Main"} resets ${c.limitReset || "16:40"}`, badge: "limit", edge: "warn" };
    if (c.state === "held") return { key: "held", tone: "warn", dot: "warn", phrase: `held · ${c.heldCount || 2} messages queue`, badge: null };
    if (c.state === "waiting" && !S.answers[c.id]) return { key: "waiting", tone: "warn", dot: "warn", phrase: c.plan ? `plan approval · ${c.waitedFor}` : `a question · ${c.waitedFor}`, badge: c.plan ? "plan approval" : "a question", edge: "warn" };
    if (c.state === "working" || (c.state === "waiting" && S.answers[c.id])) return { key: "working", tone: "ok", dot: "ok", phrase: `working ${c.elapsed || "0:12"}`, badge: null };
    if (c.state === "returned") return { key: "returned", tone: "acc", dot: "acc", phrase: `finished the turn · ${c.age}`, badge: null };
    return { key: "done", tone: "neu", dot: "", phrase: `done · ${c.age}`, badge: null };
  }
  const pipeBits = (p) => ({
    running: { tone: "acc", phrase: "running", badge: "running", cls: "acc" },
    needs_decision: { tone: "warn", phrase: "needs a decision", badge: "needs a decision", cls: "warn" },
    paused: { tone: "neu", phrase: "paused", badge: "paused", cls: "" },
    draft: { tone: "neu", phrase: "draft", badge: "draft", cls: "" },
    completed: { tone: "ok", phrase: "completed", badge: "completed", cls: "ok" },
    closed: { tone: "neu", phrase: "archived", badge: "archived", cls: "" },
  })[p.state];
  const stageOf = (p) => p.stages.find((s) => s.id === p.cursor.stageId) || p.stages[0];
  const stageIndex = (p, s) => p.stages.indexOf(s) + 1;
  const nowFragment = (c) => c.tool ? c.tool : (c.feed || []).slice().reverse().find((m) => m.kind === "agent")?.text.split("\n")[0].slice(0, 60) || "";
  const projectName = (id) => (P(id) || { name: id }).name;
  const inScope = (c) => !S.closed.has(c.id) && !c.child && (S.project === "all" ? !S.deletedProjects.has(c.project) : c.project === S.project);
  const scopedPipes = () => F.pipelines.filter((p) => (S.project === "all" ? !S.deletedProjects.has(p.project) : p.project === S.project) && p.state !== "closed");

  /* The queue: Needs you holds both kinds, in the column's order. */
  function attention() {
    const items = [];
    for (const c of F.conversations) { if (!inScope(c) || c.seat) continue; const b = stateBits(c); if (b.edge) items.push({ kind: "conv", id: c.id, go: `#/chat/${c.id}`, title: c.title, project: c.project, sub: b.phrase, badge: b.badge, tone: b.edge }); }
    for (const p of scopedPipes()) if (p.state === "needs_decision") { const s = stageOf(p); items.push({ kind: "pipe", id: p.id, go: `#/pipeline/${p.id}`, title: p.task, project: p.project, sub: `stage ${stageIndex(p, s)}/${p.stages.length} · ${s.id} failed · ${p.findings.length} findings`, badge: "needs a decision", tone: "warn" }); }
    return items;
  }
  const attentionAll = () => { const keep = S.project; S.project = "all"; const a = attention(); S.project = keep; return a; };

  /* ── route ─────────────────────────────────────────────────────────────── */
  const hashOf = () => (location.hash || "#/board").split("?")[0];
  const segs = () => hashOf().slice(2).split("/").filter(Boolean);
  const isDialog = (h) => /\/(menu|model|details|create|search|host|keys|new-agent|new-pipeline|rotate|switch)$/.test(h) || /\/add\/\d+$/.test(h);
  function go(h, opts) {
    const cur = hashOf();
    if (h === cur) { render(); return; }
    const dialog = isDialog(h);
    if (dialog) { S.trigger = opts?.trigger || null; history.replaceState({ d: 1 }, "", h); }
    else if (opts?.replace || isDialog(cur)) history.replaceState({}, "", h);
    else history.pushState({}, "", h);
    render();
  }
  window.addEventListener("popstate", () => render());
  const closeDialog = () => { const h = hashOf(); const base = h.replace(/\/(menu|model|details|create|search|host|keys|new-agent|new-pipeline|rotate|switch)$/, "").replace(/\/add\/\d+$/, ""); history.replaceState({}, "", base || "#/board"); render(); refocusTrigger(); };
  function refocusTrigger() { if (!S.trigger) return; const el = $app.querySelector(`[data-go="${S.trigger}"], [data-act="${S.trigger}"]`); if (el) el.focus(); S.trigger = null; }

  /* ── receipts ──────────────────────────────────────────────────────────── */
  function toast(msg, sub, undo) {
    clearTimeout(S.toastTimer);
    S.toast = { msg, sub, undo };
    S.toastTimer = setTimeout(() => { S.toast = null; render(); }, 4000);
    render();
  }
  const toastHtml = () => S.toast ? `<div class="receipt" role="status"><span class="msg">${esc(S.toast.msg)}${S.toast.sub ? `<small>${esc(S.toast.sub)}</small>` : ""}</span>${S.toast.undo ? `<button class="btn link" data-act="undo">${esc(S.toast.undo.label)}</button>` : ""}</div>` : "";

  /* ── shared pieces ─────────────────────────────────────────────────────── */
  const badge = (text, cls) => text ? `<span class="badge ${cls || ""}">${esc(text)}</span>` : "";
  const meter = (left, label) => { const cls = left <= 10 ? "dng" : left <= 30 ? "warn" : ""; return `<span class="meter ${cls}" title="${esc(label || "")}"><i style="width:${Math.max(2, left)}%"></i></span>`; };
  const projectChip = (id) => S.project === "all" ? `<span class="pj">${esc(projectName(id))}</span>` : "";

  function convRow(c, opts) {
    const b = stateBits(c);
    const cur = hashOf() === `#/chat/${c.id}` || (hashOf() === "#/seat" && c.seat);
    const meta = b.key === "working" ? `<span class="fix">${esc(b.phrase)}</span>${nowFragment(c) ? `<span>·</span><span class="rest">${esc(nowFragment(c))}</span>` : ""}` : `<span class="fix">${esc(b.edge ? (b.key === "waiting" ? `waiting ${c.waitedFor}` : b.phrase) : b.phrase)}</span>`;
    const stage = c.pipeline ? `<span>·</span><span class="fix">stage ${c.pipeline.k}/${c.pipeline.n}</span>` : "";
    return `<button class="row ${b.edge ? `wait ${b.edge === "dng" ? "dng" : ""}` : ""} ${cur ? "on" : ""} ${opts?.quiet ? "quiet" : ""}" data-go="#/chat/${c.id}" data-row aria-current="${cur ? "true" : "false"}">
      <span class="dot ${b.dot} ${b.key === "working" && cur ? "pulse" : ""}"></span>
      <span class="min0"><span class="t ${b.edge ? "two" : "trunc"}">${esc(c.title)}</span><span class="m">${meta}<span>·</span>${mark(c.engine)}<span class="fix">${esc(c.model)}</span>${stage}</span></span>
      <span class="r">${projectChip(c.project)}${b.badge ? badge(b.badge, b.edge === "dng" ? "dng" : "warn") : (S.crowned.has(c.id) ? `<svg class="i crown" viewBox="0 0 24 24" aria-hidden="true">${ICONS.crown}</svg>` : I("chevR"))}</span>
    </button>`;
  }
  function pipeRow(p) {
    const b = pipeBits(p); const s = stageOf(p); const cur = hashOf().startsWith(`#/pipeline/${p.id}`);
    const need = p.state === "needs_decision";
    return `<button class="row ${need ? "wait" : ""} ${cur ? "on" : ""}" data-go="#/pipeline/${p.id}" data-row aria-current="${cur ? "true" : "false"}">
      <span class="dot ${b.cls === "acc" ? "acc" : b.cls === "ok" ? "ok" : ""} ${p.state === "running" && cur ? "pulse" : ""}"></span>
      <span class="min0"><span class="t ${need ? "two" : "trunc"}">${esc(p.task)}</span><span class="m"><span class="fix">${p.state === "draft" ? `${p.stages.length} stages · not started` : `stage ${stageIndex(p, s)}/${p.stages.length} · ${esc(s.id)}`}</span>${need ? `<span>·</span><span class="fix">${p.findings.length} findings</span>` : p.state === "running" ? `<span>·</span><span class="rest">${esc(b.phrase)} ${p.started}</span>` : ""}${p.stages.some((x) => x.pendingEdit) ? `<span>·</span><span class="fix" style="color:var(--color-accent)">edit pending</span>` : ""}</span></span>
      <span class="r">${projectChip(p.project)}${need ? badge("needs a decision", "warn") : badge(b.badge, b.cls)}</span>
    </button>`;
  }

  /* ── rail ──────────────────────────────────────────────────────────────── */
  function rail() {
    const q = S.projFilter || "";
    const rows = F.projects.filter((p) => !p.archived && !S.archivedProjects.has(p.id) && !S.deletedProjects.has(p.id) && (!q || p.name.includes(q)));
    const crowned = rows.filter((p) => p.crowned); const rest = rows.filter((p) => !p.crowned);
    const archived = F.projects.filter((p) => (p.archived || S.archivedProjects.has(p.id)) && !S.deletedProjects.has(p.id));
    const prow = (p) => { const needs = attentionAll().filter((a) => a.project === p.id).length; return `<button class="prow ${S.project === p.id ? "on" : ""} ${p.quiet ? "quiet" : ""}" data-go="#/board" data-project="${p.id}" title="${esc(p.name)}">
        <span class="ini">${esc(p.name.slice(0, 2))}${needs ? `<b>${needs}</b>` : ""}</span>
        <span class="dot ${needs ? "warn" : p.working ? "ok" : ""}"></span>
        <span class="n"><span class="trunc">${esc(p.name)}</span><small>${needs ? `${needs} need${needs > 1 ? "" : "s"} you · ` : ""}${p.working ? `${p.working} working` : `quiet · ${p.age}`}</small></span>
        <span class="cnt">${p.crowned ? `<svg class="i sm crown" viewBox="0 0 24 24" aria-hidden="true">${ICONS.crown}</svg>` : ""}${needs ? badge(String(needs), "warn") : ""}</span>
      </button>`; };
    return `<aside class="rail">
      <div class="rail-head"><span class="app">Agent Log Viewer</span><button class="iconbtn" data-act="rail" aria-label="${S.rail ? "Collapse the project rail" : "Expand the project rail"}" title="${S.rail ? "Collapse" : "Expand"} ([)">${I(S.rail ? "chevL" : "chevR")}</button></div>
      <div class="rail-search"><input class="field" placeholder="Filter projects…" value="${esc(q)}" data-act="projFilter" aria-label="Filter projects"></div>
      <nav class="rail-list" aria-label="Projects">
        <button class="prow ${S.project === "all" ? "on" : ""}" data-go="#/overview"><span class="ini">All</span>${I("grid")}<span class="n">Overview<small>${attentionAll().length} need you across ${F.projects.filter((p) => !p.archived).length} projects</small></span></button>
        ${crowned.length ? `<h2 style="padding:8px 8px 2px">Crowned</h2>${crowned.map(prow).join("")}` : ""}
        <h2 style="padding:8px 8px 2px">Projects</h2>${rest.map(prow).join("")}
        ${archived.length ? `<button class="sec-h" data-act="toggle:archive" aria-expanded="${S.collapsed.has("archive") ? "false" : "true"}"><span>Archive</span><span class="c">· ${archived.length}</span>${I("chevD")}</button>${S.collapsed.has("archive") ? "" : archived.map((p) => `<button class="prow quiet" data-go="#/board" data-project="${p.id}"><span class="ini">${esc(p.name.slice(0, 2))}</span><span class="dot"></span><span class="n"><span class="trunc">${esc(p.name)}</span><small>archived · ${p.age}</small></span></button>`).join("")}` : ""}
      </nav>
      <div class="rail-foot"><button class="btn quiet" data-act="createProject" style="width:100%;justify-content:flex-start">${I("plus")}<span>Create project</span></button></div>
    </aside>`;
  }

  /* ── column ────────────────────────────────────────────────────────────── */
  function seatCard() {
    if (S.project === "all") return "";
    const c = seatConv();
    /* The filter narrows the whole column, the seat included: a typed query
       that does not name the orchestrator hides the card, so ↓ and Enter land
       on the first matching row. */
    const q = S.filter.trim().toLowerCase();
    if (q && !"orchestrator".includes(q) && !(c && c.title.toLowerCase().includes(q))) return "";
    if (F.seat.state === "none" || !c) return `<div class="seat none" data-seat="none"><button class="main" data-go="#/seat/rotate" data-create><span class="l1">${I("bot")}<span class="t">No orchestrator</span></span><span class="l2 create">Create an orchestrator ›</span></button><span></span></div>`;
    const b = stateBits(c);
    return `<div class="seat" data-seat="live"><button class="main" data-go="#/chat/orch"><span class="l1">${I("bot")}<span class="t">Orchestrator</span>${badge(b.phrase, b.tone === "neu" ? "" : b.tone)}</span><span class="l2"><span class="trunc">${esc(nowFragment(c))}</span></span><span class="l2">${meter(F.seat.ctx.left, `${F.seat.ctx.left}% left of ${F.seat.ctx.window}`)}<span class="tn">${F.seat.ctx.left}% left</span></span></button><button class="iconbtn cog" data-go="#/seat" aria-label="Orchestrator seat: status, mandate, rotate" title="Seat (o)">${I("sliders")}</button></div>`;
  }
  function section(key, label, rowsHtml, count, extra) {
    if (!count && key !== "needs") return "";
    const open = !S.collapsed.has(key);
    return `<section class="sec" data-sec="${key}"><button class="sec-h" data-act="toggle:${key}" aria-expanded="${open}"><span>${label}</span><span class="c">· ${count}</span>${I("chevD")}</button>${open ? rowsHtml + (extra || "") : ""}</section>`;
  }
  function column() {
    const q = S.filter.trim().toLowerCase();
    const match = (t) => !q || t.toLowerCase().includes(q);
    const convs = F.conversations.filter((c) => inScope(c) && !c.seat && match(c.title));
    const pipes = scopedPipes().filter((p) => match(p.task));
    const need = attention().filter((a) => match(a.title));
    const working = convs.filter((c) => stateBits(c).key === "working" || stateBits(c).key === "held");
    const recent = convs.filter((c) => ["returned", "done", "killed"].includes(stateBits(c).key));
    const active = pipes.filter((p) => p.state !== "completed");
    const completed = pipes.filter((p) => p.state === "completed");
    const needRows = need.map((a) => a.kind === "conv" ? convRow(conv(a.id)) : pipeRow(pipe(a.id))).join("") || `<div class="quietline muted" style="padding:8px 10px;font-size:var(--text-label)">Nothing needs you.</div>`;
    const recentRows = (S.recentAll || q ? recent : recent.slice(0, 5)).map((c) => convRow(c, { quiet: true })).join("");
    const more = !S.recentAll && !q && recent.length > 5 ? `<button class="more" data-act="recentAll">All conversations · ${recent.length} ${I("chevR", "sm")}</button>` : "";
    const title = S.project === "all" ? "All projects" : projectName(S.project);
    const sub = S.project === "all" ? `${need.length} need you · ${working.length} working` : `${need.length} need you · ${working.length} working · ${active.length} pipelines`;
    return `<section class="col" aria-label="Board">
      <div class="col-head"><h1><span class="trunc">${esc(title)}</span><small>${sub}</small></h1>
        <div class="seg" role="group" aria-label="View"><button class="${S.view === "list" ? "on" : ""}" data-act="view:list" aria-pressed="${S.view === "list"}" title="List (m)">${I("list", "sm")}</button><button class="${S.view === "map" ? "on" : ""}" data-act="view:map" aria-pressed="${S.view === "map"}" title="Map (m)">${I("map", "sm")}</button></div>
        <button class="iconbtn" data-go="#/board/create" aria-label="Create: conversation, task, pipeline" title="Create (c)">${I("plus")}</button>
        <button class="iconbtn" data-go="#/board/menu" aria-label="More" title="More">${I("more")}</button></div>
      <div class="col-filter"><input class="field" placeholder="Filter · ↑ ↓ Enter" value="${esc(S.filter)}" data-act="filter" data-focus="filter" aria-label="Filter conversations and pipelines"></div>
      <div class="col-body">
        ${seatCard()}
        ${section("needs", "Needs you", needRows, need.length)}
        ${section("pipelines", "Pipelines", active.map(pipeRow).join(""), active.length, completed.length ? `<button class="more quiet" data-act="toggle:completed" style="color:var(--color-muted)">${S.collapsed.has("completed") ? "Show" : "Hide"} ${completed.length} completed</button>${S.collapsed.has("completed") ? "" : completed.map(pipeRow).join("")}` : "")}
        ${section("working", "Working", working.map((c) => convRow(c)).join(""), working.length)}
        ${section("recent", "Recent", recentRows, recent.length, more)}
      </div>
    </section>`;
  }

  /* ── stage: banner ─────────────────────────────────────────────────────── */
  function banner() {
    if (F.runtime === "offline") return `<div class="banner info" data-banner="offline">${I("wifiOff")}<span class="txt"><b>Offline · reconnecting</b>Showing the last state received · 14:02</span></div>`;
    if (F.runtime === "degraded") return `<div class="banner info" data-banner="degraded">${I("info")}<span class="txt"><b>Runtime degraded · polling</b>Updates arrive every 10 s</span></div>`;
    if (S.arrival && !S.arrivalDismissed && !S.seen.has(S.arrival.id) && hashOf() !== `#/chat/${S.arrival.id}`) {
      const c = conv(S.arrival.id); const b = stateBits(c);
      return `<div class="banner" data-banner="arrival">${I("alert")}<button class="open" data-act="openArrival"><b style="font-size:var(--text-label);color:var(--color-warning)">Needs you · ${esc(b.badge || "a question")} · ${esc(projectName(c.project))}</b><span class="trunc">${esc(c.title)}</span></button><button class="iconbtn" data-act="dismissArrival" aria-label="Dismiss">${I("x")}</button></div>`;
    }
    return "";
  }

  /* ── stage: conversation ───────────────────────────────────────────────── */
  function feedHtml(c) {
    const out = [];
    for (const m of c.feed || []) {
      if (m.kind === "user") out.push(`<div class="mu"><div class="bubble">${esc(m.text)}</div></div>`);
      else if (m.kind === "agent") out.push(`<div class="ma"><button class="mh" data-act="msg" aria-label="Message actions: copy, read aloud">${mark(c.engine)}<span>${esc(c.model)}</span><span class="ts tn">${esc(m.ts)}</span></button><div class="txt">${paras(m.text)}</div></div>`);
      else if (m.kind === "tool") out.push(`<button class="run" data-act="msg">${I(m.status === "running" ? "refresh" : "tool")}<span class="trunc">${esc(m.tool)}</span>${m.status === "running" ? `<span class="badge ok">running</span>` : ""}${m.link ? `<span class="badge acc">open ›</span>` : ""}<span class="ts tn">${esc(m.dur)}${m.ts ? ` · ${esc(m.ts)}` : ""}</span></button>`);
      else if (m.kind === "run") out.push(`<button class="run" data-act="msg">${I("chevR")}<span>${m.items.reduce((n, i) => n + i.n, 0)} actions · ${m.items.map((i) => `${esc(i.tool)} ×${i.n}`).join(" · ")}</span><span class="ts tn">${esc(m.ts)}</span></button>`);
      else if (m.kind === "runfail") out.push(`<div class="runx">${m.items.map((i) => `<div class="li ${i.status === "fail" ? "fail" : i.status === "running" ? "live" : ""}">${I(i.status === "fail" ? "x" : i.status === "running" ? "refresh" : "tool")}<span>${esc(i.tool)} ${esc(i.detail)}</span>${i.status === "fail" ? `<span class="badge dng">exit 1</span>` : ""}<span class="ts tn">${esc(i.ts)} ${esc(i.dur)}</span></div>${i.error ? `<div class="err">${esc(i.error)}</div>` : ""}`).join("")}</div>`);
    }
    if (c.question) {
      const a = S.answers[c.id];
      if (a) out.push(`<div class="mu"><div class="bubble">${esc(a)}</div></div><button class="qf" data-act="toggleQ:${c.id}">${I("chevR")}<span>question · answered ${F.now}</span></button>${S.pickedOption[c.id + ":open"] ? questionCard(c, true) : ""}`);
      else out.push(questionCard(c, false));
    }
    return out.join("");
  }
  function questionCard(c, quiet) {
    const q = c.question; const picked = S.answers[c.id];
    return `<div class="q ${quiet ? "quiet" : ""}"><div class="qh">${I("alert", "sm")}Needs you · ${esc(c.waitedFor)}</div><div class="qt">${esc(q.text)}</div>${q.options.map((o, i) => `<button class="opt ${picked === o.label ? "on" : ""}" data-act="${quiet ? "noop" : `answer:${c.id}:${i}`}"><span class="rad"></span><span><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ""}</span></button>`).join("")}${quiet ? "" : `<div class="own">Or type your own answer below — it is sent as the reply.</div>`}</div>`;
  }
  function composer(c, focusPrefix) {
    const b = stateBits(c); const draft = S.drafts[c.id] || ""; const nx = S.next[c.id] || { model: c.model, effort: c.effort, account: c.account };
    const fp = focusPrefix || "";
    let slot;
    if (F.runtime === "offline") slot = `<button class="send queue" data-act="queue:${c.id}" data-focus="${fp}send"><span class="cap">Queue</span></button>`;
    else if (b.key === "killed") slot = `<button class="send respawn" data-act="respawn:${c.id}" data-focus="${fp}send"><span class="cap">${I("refresh", "sm")}Respawn</span></button>`;
    else if (b.key === "working" && !draft) slot = `<button class="send stop" data-act="stop:${c.id}" data-focus="${fp}send" aria-label="Stop the agent"><span class="cap">${I("square", "sm")}Stop</span></button>`;
    else slot = `<button class="send ${draft ? "" : "off"}" data-act="send:${c.id}" data-focus="${fp}send" aria-label="Send"><span class="cap">${I("arrowUp", "sm")}</span></button>`;
    const placeholder = b.key === "killed" ? "killed · text queues until a respawn" : b.key === "held" ? "held · text you send queues" : F.runtime === "offline" ? "offline · held until reconnected" : c.question && !S.answers[c.id] ? "Your own answer…" : c.seat ? "Tell the orchestrator…" : "Message the agent…";
    const chipText = b.key === "limit" ? `${nx.model} · ${c.account} at limit` : `${nx.model} · ${nx.effort}`;
    return `<div class="box"><textarea data-focus="${fp}field" placeholder="${esc(placeholder)}" aria-label="Message" rows="2">${esc(draft)}</textarea>
      <div class="tools"><button class="chipbtn" data-go="#/chat/${c.id}/model" data-focus="${fp}chip" aria-label="Next message: model, reasoning, account"><span class="chip ${b.key === "limit" ? "warn" : ""}">${mark(c.engine)}${esc(chipText)}${I("chevD", "sm")}</span></button>
      <button class="iconbtn" data-act="attach" data-focus="${fp}attach" aria-label="Attach files or images">${I("clip")}</button><button class="iconbtn" data-act="dictate" data-focus="${fp}mic" aria-label="Dictate">${I("mic")}</button>
      <span class="hint"><span class="kbd">Enter</span> send · <span class="kbd">Shift</span>+<span class="kbd">Enter</span> newline</span>${slot}</div></div>`;
  }
  function chatHead(c, pinned) {
    const b = stateBits(c);
    const stage = c.pipeline ? `<span>·</span><span>stage ${c.pipeline.k}/${c.pipeline.n}</span>` : "";
    return `<div class="chat-head"><span class="dot ${b.dot} ${b.key === "working" ? "pulse" : ""}"></span><div class="tt"><div class="t trunc">${esc(c.title)}</div><div class="sub"><span class="st ${b.tone === "neu" ? "" : b.tone}">${esc(b.phrase)}</span><span>·</span>${mark(c.engine)}<span>${esc(c.model)}</span><span>·</span><span>${esc(c.effort)}</span>${stage}${c.worktree ? `<span>·</span><span class="mono">${esc(c.worktree)}</span>` : ""}</div></div>
      ${pinned ? `<button class="iconbtn" data-act="unpin" aria-label="Unpin">${I("x")}</button>` : `${canPin() && !S.pin ? `<button class="iconbtn" data-act="pin:${c.id}" aria-label="Pin beside" title="Pin beside">${I("panel")}</button>` : ""}${c.seat ? `<button class="iconbtn ${hashOf() === "#/seat" ? "on" : ""}" data-go="#/seat" aria-label="Orchestrator seat" title="Seat">${I("sliders")}</button>` : ""}<button class="iconbtn" data-go="#/chat/${c.id}/menu" aria-label="Conversation actions" title="More">${I("more")}</button>`}</div>`;
  }
  function chatView(c, opts) {
    const pinned = opts?.pinned; const fp = pinned ? "pin-" : "";
    const members = c.children && c.children.length ? `<div class="members">${I("branch", "sm")}<span>${c.children.length} members ·</span>${c.children.map((k) => `<span class="badge ${k.state === "working" ? "ok" : ""}">${esc(k.title)}</span>`).join("")}</div>` : "";
    const chips = c.question && !S.answers[c.id] && !pinned ? `<div class="chips">${c.question.chips.map((t) => `<button data-act="answerText:${c.id}:${esc(t)}"><span class="chip">${esc(t)}</span></button>`).join("")}</div>` : "";
    return `<div class="chat" data-conv="${c.id}">${chatHead(c, pinned)}${opts?.seatPanel ? seatPanel() : ""}${members}<div class="feed"><div class="inner">${feedHtml(c)}</div></div>${chips}${pinned ? "" : toastHtml()}${composer(c, fp)}</div>`;
  }
  function seatPanel() {
    const s = F.seat; const c = seatConv();
    const rot = s.ctx.left <= 30 ? `<div class="warnline">${I("alert", "sm")} Rotation recommended · ${s.ctx.left}% of the window left</div>` : "";
    return `<div class="seatpanel" data-seatpanel><div class="id">${mark(s.engine, "fill")}<span class="t">${esc(s.model)} · ${esc(s.effort)}<small>${esc(s.account)} · ${esc(s.plan)} · holding the seat for ${esc(s.since)}${s.predecessor ? " · predecessor" : ""}</small></span>${c ? badge(stateBits(c).phrase, stateBits(c).tone === "neu" ? "" : stateBits(c).tone) : ""}</div>
      <div class="ctx">${meter(s.ctx.left)}<span class="tn">${s.ctx.left}% left of ${esc(s.ctx.window)}</span>${s.predecessor ? `<button class="btn link" data-act="predecessor">Predecessor · open ›</button>` : ""}</div>
      <div class="mand">Mandate v${s.mandateVersion}\n${esc(s.mandate)}</div>${rot}
      <div class="sbtns"><button class="btn primary" data-go="#/seat/rotate" data-orchestrator-rotate>${I("rotate", "sm")}Rotate</button><button class="btn" data-go="#/seat/rotate">${I("pencil", "sm")}Edit the mandate</button><span class="muted" style="font-size:var(--text-label);max-width:180px;line-height:1.35">Changing the mandate, model or account means a successor.</span></div></div>`;
  }

  /* ── stage: pipeline ───────────────────────────────────────────────────── */
  const ROLES = ["architect", "builder", "reviewer", "auditor"]; const MODELS = { claude: ["Opus", "Sonnet", "Haiku"], codex: ["gpt-5.6", "gpt-5.5"] }; const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  function stageCard(p, s, i) {
    const cur = p.cursor.stageId === s.id && p.state !== "draft" && p.state !== "completed"; const sel = hashOf() === `#/pipeline/${p.id}/stage/${s.id}`;
    const last = s.attempts[s.attempts.length - 1];
    const att = last ? `${s.attempts.length} attempt${s.attempts.length > 1 ? "s" : ""} · ${last.state}` : "not started";
    const attCls = last ? ({ passed: "ok", failed: "warn", running: "acc", pending: "" })[last.state] : "";
    return `<button class="stg ${cur ? "cur" : ""} ${sel ? "on" : ""}" data-go="#/pipeline/${p.id}/stage/${s.id}" data-stage="${s.id}"><span class="k"><span>${i + 1}/${p.stages.length}</span><span>${esc(s.id)}</span>${last ? badge(last.state, attCls) : ""}</span><span class="role">${esc(s.role)}</span><span class="cfg">${mark(s.engine)}<span>${esc(s.model)} · ${esc(s.effort)}</span><span>· ${s.access === "read-only" ? "read-only" : "read-write"}</span></span><span class="att">${esc(att)}${last && last.conv ? `<span class="badge acc">open ›</span>` : ""}</span>${s.pendingEdit ? `<span class="pend">edit pending · applies from attempt ${s.attempts.length + 1}</span>` : ""}${s.notes && s.notes.length ? `<span class="pend">${s.notes.length} note${s.notes.length > 1 ? "s" : ""} for the next attempt</span>` : ""}</button>`;
  }
  function edgeHtml(p, s, i) {
    if (i === p.stages.length - 1) return `<div class="edge"><button class="iconbtn addstage" data-go="#/pipeline/${p.id}/add/${i + 1}" aria-label="Add a stage after ${esc(s.id)}">${I("plusCircle")}</button></div>`;
    const fail = s.onFail ? `<span class="fail" title="fail edge">↺ ${esc(s.onFail.to)} ×${s.onFail.maxRounds}</span>` : "";
    return `<div class="edge">${I("arrowR")}${fail}<button class="iconbtn addstage" data-go="#/pipeline/${p.id}/add/${i + 1}" aria-label="Add a stage after ${esc(s.id)}" title="Add a stage here">${I("plusCircle", "sm")}</button></div>`;
  }
  function pipeView(p, selStage, addIndex) {
    const b = pipeBits(p); const s = stageOf(p); const need = p.state === "needs_decision";
    const findings = need ? `<div class="card findings"><h3>Review · attempt ${s.attempts.length} · ${p.findings.length} findings <span class="c">· stage ${stageIndex(p, s)}/${p.stages.length} · ${esc(s.id)}</span></h3><ol>${p.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol><div class="answer"><input class="field" placeholder="Answer for the next attempt (sent as a note with the question)…" data-act="answerField" aria-label="Answer"><button class="btn primary" data-act="pa:answer:${p.id}">Answer</button></div></div>` : "";
    const waiting = p.waiting ? `<div class="card" style="border-left:3px solid var(--color-info)"><h3>Waiting · ${esc(p.waiting.kind)} since ${esc(p.waiting.since)}</h3></div>` : "";
    const act = (id, label, icon, cls) => `<button class="btn ${cls || ""}" data-act="pa:${id}:${p.id}">${icon ? I(icon, "sm") : ""}${label}</button>`;
    let actions = "";
    if (p.state === "draft") actions = act("start", "Start pipeline", "play", "primary") + act("discard", "Discard draft", "trash", "danger");
    else if (need) actions = act("retry", "Retry stage", "refresh", "primary") + act("skip", "Skip stage", "skip") + act("pause", "Pause", "pause") + act("archive", "Archive", "archive");
    else if (p.state === "paused") actions = act("resume", "Resume", "play", "primary") + act("archive", "Archive", "archive");
    else if (p.state === "running") actions = act("pause", "Pause", "pause") + act("checkpoint", "Checkpoint", "flag") + act("archive", "Archive", "archive");
    else if (p.state === "completed") actions = act("rerunLast", "Re-run the last stage", "refresh", "primary") + act("archive", "Archive", "archive");
    else if (p.state === "closed") actions = act("restore", "Restore", "undo", "primary");
    const sub = p.state === "draft" ? `${p.stages.length} stages · not started` : `${esc(b.phrase)} · stage ${stageIndex(p, s)}/${p.stages.length} · started ${esc(p.started)} · <span class="mono">${esc(p.branch || "")}</span> · rev ${p.revision}${p.lastEdit ? ` · last edit by ${esc(p.lastEdit.actor)} ${esc(p.lastEdit.at)} ago` : ""}`;
    const editor = selStage ? stageEditor(p, selStage) : addIndex !== undefined ? addStageEditor(p, addIndex) : "";
    const log = p.mutations.length ? `<div class="card log"><details ${selStage ? "" : "open"}><summary>${I("chevD", "sm")}Changes · ${p.mutations.length} <span class="c muted">· every mutation is attributed and revision-stamped</span></summary>${p.mutations.slice().reverse().map((m) => `<div class="mrow"><span class="badge">rev ${m.revision}</span><span class="l"><b>${esc(m.action)}</b>${m.stage ? ` · ${esc(m.stage)}` : ""}${m.detail ? ` · ${esc(m.detail)}` : ""}<small>${esc(m.actor)} · ${esc(m.at)} · ${esc(m.effect)}</small></span></div>`).join("")}</details></div>` : "";
    const tasks = F.tasks.filter((t) => t.linked && p.stages.some((x) => x.attempts.some((a) => a.conv === t.linked)));
    return `<div class="pipe" data-pipeline="${p.id}"><div class="pipe-head"><span class="dot ${b.cls === "acc" ? "acc pulse" : b.cls === "ok" ? "ok" : need ? "warn" : ""}"></span><div class="tt"><div class="t trunc">${esc(p.task)}</div><div class="sub">${sub}</div></div>${need ? badge("needs a decision", "warn") : badge(b.badge, b.cls)}<button class="iconbtn" data-go="#/pipelines" aria-label="All pipelines" title="Pipelines (p)">${I("layers")}</button></div>
      <div class="pipe-body">${findings}${waiting}
        <div class="actions">${actions}<span class="payload">PATCH /api/pipelines/${esc(p.id)} · expectedRevision ${p.revision}</span></div>
        <div class="pipe-grid ${editor ? "" : "noed"}"><div><div class="card"><h3>Stages <span class="c">· click a stage to edit it, an edge to add one · edits after start land on the next attempt</span></h3><div class="stages">${p.stages.map((x, i) => stageCard(p, x, i) + edgeHtml(p, x, i)).join("")}</div></div>${toastHtml()}${log}${tasks.length ? `<div class="card"><h3>Linked tasks · ${tasks.length}</h3>${tasks.map((t) => `<button class="row" data-go="#/tasks"><span class="dot ${t.state === "waiting" ? "warn" : "ok"}"></span><span class="min0"><span class="t trunc">${esc(t.title)}</span><span class="m"><span class="fix">${esc(t.state)}</span></span></span><span class="r">${I("chevR")}</span></button>`).join("")}</div>` : ""}</div>${editor}</div>
      </div></div>`;
  }
  function segHtml(name, options, value, act) { return `<div class="seg" role="group" aria-label="${esc(name)}">${options.map((o) => `<button class="${o === value ? "on" : ""}" data-act="${act}:${esc(o)}" aria-pressed="${o === value}">${esc(o)}</button>`).join("")}</div>`; }
  function stageEditor(p, s) {
    const d = S.editorDraft && S.editorDraft.stage === s.id && S.editorDraft.pipeline === p.id ? S.editorDraft : (S.editorDraft = { pipeline: p.id, stage: s.id, role: s.role, engine: s.engine, model: s.model, effort: s.effort, access: s.access, sandbox: s.sandbox, outputs: s.outputs.join(", "), account: "Main", prompt: s.prompt, passTo: s.next || "", failTo: s.onFail ? s.onFail.to : "", maxRounds: s.onFail ? s.onFail.maxRounds : 3, note: "", rerunFrom: "worktree", stopCurrent: false });
    const running = s.attempts.some((a) => a.state === "running" || a.state === "pending");
    const nextAttempt = s.attempts.length + 1;
    const others = p.stages.filter((x) => x.id !== s.id).map((x) => x.id);
    const sel = (name, opts, value, act, allowNone) => `<select class="field" data-act="${act}" aria-label="${esc(name)}">${allowNone ? `<option value="" ${value ? "" : "selected"}>none</option>` : ""}${opts.map((o) => `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    const closed = p.state === "closed";
    return `<div class="card editor" data-editor="${s.id}"><h3>${I("pencil", "sm")}Stage ${stageIndex(p, s)}/${p.stages.length} · ${esc(s.id)} ${badge(running ? `attempt ${s.attempts.length} running` : s.attempts.length ? `${s.attempts.length} attempts` : "not started", running ? "acc" : "")}<button class="iconbtn" data-go="#/pipeline/${p.id}" aria-label="Close the editor">${I("x")}</button></h3>
      <label>Role ${segHtml("Role", ROLES, d.role, "ed:role")}</label>
      <label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "ed:engine")}</label>
      <label>Model ${segHtml("Model", MODELS[d.engine], d.model, "ed:model")}</label>
      <label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "ed:effort")}</label>
      <div class="rowf"><label style="flex:1">Access ${segHtml("Access", ["read-write", "read-only"], d.access, "ed:access")}</label><label style="flex:1">Sandbox ${segHtml("Sandbox", ["full", "restricted"], d.sandbox, "ed:sandbox")}</label></div>
      ${d.access === "read-only" ? `<label>Declared outputs <input class="field mono" value="${esc(d.outputs)}" data-act="ed:outputs" placeholder="paths this stage may write"></label>` : ""}
      <label>Account ${sel("Account", ["Main", "Lab"], d.account, "ed:account")}</label>
      <label>Prompt <textarea class="field" data-act="ed:prompt" data-autofocus>${esc(d.prompt)}</textarea></label>
      <div class="note">${closed ? "Archived pipelines are read-only; restore it to edit." : running ? `Attempt ${s.attempts.length} is running with its own copy of this definition. Saving applies from attempt ${nextAttempt}; Restart stops attempt ${s.attempts.length} and starts ${nextAttempt} from the current worktree.` : p.state === "completed" ? `The pipeline is completed. Save the edit first, then re-run this stage to reopen it: the new attempt binds the saved definition.` : `Applies from attempt ${nextAttempt} — the next time this stage runs.`}</div>
      <div class="btns"><button class="btn primary" data-act="pa:editStage:${p.id}:${s.id}" ${closed ? "disabled" : ""}>Save · from attempt ${nextAttempt}</button>${running ? `<button class="btn danger" data-act="pa:editRestart:${p.id}:${s.id}">Restart now</button>` : ""}</div>
      <div class="grp"><h4>Edges</h4><div class="rowf"><span class="muted" style="width:44px">pass →</span>${sel("Pass edge", others.concat(["publish"]).filter((v, i, a) => a.indexOf(v) === i), d.passTo, "ed:passTo", true)}</div><div class="rowf"><span class="muted" style="width:44px">fail ↺</span>${sel("Fail edge", others, d.failTo, "ed:failTo", true)}<input class="field num tn" type="number" min="0" max="20" value="${d.maxRounds}" data-act="ed:maxRounds" aria-label="Max rounds"></div><div class="note">Round budgets derive from activation records; lowering below the used count parks the next fail verdict. A traversed edge may still be rewired.</div><div class="btns"><button class="btn" data-act="pa:setEdge:${p.id}:${s.id}" ${closed ? "disabled" : ""}>Save edges</button></div></div>
      <div class="grp"><h4>Note for the next attempt</h4><textarea class="field" style="min-height:56px" data-act="ed:note" placeholder="Rendered into the prompt of attempt ${nextAttempt} as a titled block">${esc(d.note)}</textarea><div class="btns"><button class="btn" data-act="pa:note:${p.id}:${s.id}" ${closed ? "disabled" : ""}>Add note</button></div></div>
      <div class="grp"><h4>Re-run this stage</h4><div class="rowf">${segHtml("From", ["worktree", "last-passed", "checkpoint"], d.rerunFrom, "ed:rerunFrom")}</div>${d.rerunFrom === "checkpoint" ? sel("Checkpoint", p.checkpoints.map((c) => c.name), p.checkpoints[0]?.name, "ed:checkpoint") : ""}${running ? `<button class="check" data-act="ed:stopCurrent:toggle" aria-pressed="${d.stopCurrent ? "true" : "false"}"><span class="bx">${d.stopCurrent ? I("check", "sm") : ""}</span>Stop attempt ${s.attempts.length} first</button>` : ""}<div class="note ${running && !d.stopCurrent ? "warn" : ""}">${running && !d.stopCurrent ? `Refused while attempt ${s.attempts.length} is unsettled — tick «Stop attempt first» to re-run now.` : p.state === "completed" ? "Reopens the completed pipeline at this stage." : `Creates attempt ${nextAttempt} from the ${d.rerunFrom === "worktree" ? "current worktree, no reset" : d.rerunFrom === "last-passed" ? "last passed commit (resets the worktree)" : "named checkpoint (resets the worktree)"}.`}</div><div class="btns"><button class="btn ${running && !d.stopCurrent ? "" : "primary"}" data-act="pa:rerun:${p.id}:${s.id}" ${closed || (running && !d.stopCurrent) ? "disabled" : ""}>Re-run · attempt ${nextAttempt}</button></div></div>
      <div class="grp"><h4>Remove</h4>${s.attempts.length ? `<div class="note">This stage has attempts, so it stays as history. Route around it with the edges above.</div>` : `<div class="btns"><button class="btn danger" data-act="pa:removeStage:${p.id}:${s.id}">Remove stage</button></div>`}</div>
      <div class="note mono">edit-stage {stageId: "${esc(s.id)}", expectedRevision: ${p.revision}}</div></div>`;
  }
  function addStageEditor(p, index) {
    const d = S.editorDraft && S.editorDraft.add === index && S.editorDraft.pipeline === p.id ? S.editorDraft : (S.editorDraft = { pipeline: p.id, add: index, id: "", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", prompt: "" });
    const after = p.stages[index - 1]; const before = p.stages[index];
    return `<div class="card editor" data-editor="add"><h3>${I("plusCircle", "sm")}Add a stage ${after ? `after ${esc(after.id)}` : "first"}${before ? ` · before ${esc(before.id)}` : ""}<button class="iconbtn" data-go="#/pipeline/${p.id}" aria-label="Close the editor">${I("x")}</button></h3>
      <label>Stage id <input class="field mono" value="${esc(d.id)}" data-act="ed:id" placeholder="e.g. verify-2" data-autofocus></label>
      <label>Role ${segHtml("Role", ROLES, d.role, "ed:role")}</label>
      <label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "ed:engine")}</label>
      <label>Model ${segHtml("Model", MODELS[d.engine], d.model, "ed:model")}</label>
      <label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "ed:effort")}</label>
      <label>Prompt <textarea class="field" data-act="ed:prompt">${esc(d.prompt)}</textarea></label>
      <div class="note">${after ? `Inserted at its seam: ${esc(after.id)} → new stage → ${before ? esc(before.id) : "end"}. ${p.state !== "draft" && index <= p.stages.indexOf(stageOf(p)) ? "It sits before the cursor, so it is history-only until an edge or a re-run reaches it." : ""}` : "Becomes the first stage."}</div>
      <div class="btns"><button class="btn primary" data-act="pa:addStage:${p.id}:${index}">Add stage</button><button class="btn" data-go="#/pipeline/${p.id}">Cancel</button></div>
      <div class="note mono">add-stage {index: ${index}, expectedRevision: ${p.revision}}</div></div>`;
  }
  function pipelinesList() {
    const ps = scopedPipes().concat(F.pipelines.filter((p) => p.state === "closed" && (S.project === "all" || p.project === S.project)));
    const grp = (label, items) => items.length ? `<div class="card"><h3>${label} <span class="c">· ${items.length}</span></h3><div class="plist">${items.map(pipeRow).join("")}</div></div>` : "";
    return `<div class="pipe"><div class="pipe-head"><div class="tt"><div class="t">Pipelines</div><div class="sub">${ps.length} in ${S.project === "all" ? "all projects" : esc(projectName(S.project))}</div></div><button class="btn" data-go="#/board/new-pipeline">${I("plus", "sm")}New pipeline</button></div><div class="pipe-body">${grp("Needs you", ps.filter((p) => p.state === "needs_decision"))}${grp("Active", ps.filter((p) => ["running", "paused"].includes(p.state)))}${grp("Drafts", ps.filter((p) => p.state === "draft"))}${grp("Completed", ps.filter((p) => p.state === "completed"))}${grp("Archived", ps.filter((p) => p.state === "closed"))}${toastHtml()}</div></div>`;
  }

  /* ── stage: overview, accounts, tasks, map, empty ──────────────────────── */
  function overview() {
    const cards = F.projects.filter((p) => !p.archived && !S.archivedProjects.has(p.id) && !S.deletedProjects.has(p.id)).map((p) => {
      const convs = F.conversations.filter((c) => c.project === p.id && !c.seat && !c.child && !S.closed.has(c.id));
      const order = { stalled: 0, limit: 1, waiting: 2, held: 3, working: 4, returned: 5, killed: 6, done: 7 };
      const rows = convs.slice().sort((a, b) => order[stateBits(a).key] - order[stateBits(b).key]).slice(0, 4);
      const needs = attentionAll().filter((a) => a.project === p.id).length;
      const keep = S.project; S.project = "all";
      const html = `<div class="card pc"><button class="ph" data-go="#/board" data-project="${p.id}"><span class="dot ${needs ? "warn" : p.working ? "ok" : ""}"></span><span class="t trunc">${esc(p.name)}</span>${p.crowned ? `<svg class="i sm crown" viewBox="0 0 24 24" aria-hidden="true">${ICONS.crown}</svg>` : ""}<span class="cnt">${needs ? `<span style="color:var(--color-warning);font-weight:600">${needs} need you</span>` : ""}<span>${p.working} working</span><span>${p.total} total</span></span>${I("chevR")}</button>${rows.length ? rows.map((c) => convRow(c).replace('data-go="#/chat/', `data-project="${p.id}" data-go="#/chat/`)).join("") : `<div class="quietline">quiet · last activity ${esc(p.age)}</div>`}${convs.length > 4 ? `<div class="quietline">${convs.length - 4} more</div>` : ""}</div>`;
      S.project = keep; return html;
    }).join("");
    return `<div class="ov"><div class="ov-grid">${cards}</div>${toastHtml()}</div>`;
  }
  function accountsView() {
    const eng = (engine, list) => {
      const active = list.find((a) => a.active); const low = active ? active.windows.slice().sort((a, b) => a.left - b.left)[0] : null;
      const rows = list.filter((a) => !a.active).map((a) => `<button class="arow" data-act="${a.auth === "Authenticated" ? `switch:${engine}:${a.id}` : `signIn:${engine}:${a.id}`}"><span class="dot ${a.auth === "Authenticated" ? "ok" : ""}"></span><span class="t">${esc(a.label)}<small>${esc(a.plan)}${a.checked ? ` · checked ${a.checked}` : ""}</small></span>${a.auth === "Authenticated" ? badge("ready", "ok") : `<span class="signin">sign in →</span>`}</button>`).join("");
      return `<div class="card eng"><h2>${mark(engine)}${engine === "claude" ? "Claude" : "Codex"} accounts</h2>${active ? `<div class="acct"><div class="ah">${mark(engine, "fill")}<span class="t">${esc(active.label)} ${badge("active", "acc")}<small>${esc(active.plan)} · checked ${active.checked}</small></span><span class="corner">${low ? `<b class="tn ${low.left <= 10 ? "dng" : low.left <= 30 ? "warn" : ""}">${low.left}% left</b>${esc(low.label)}` : ""}</span></div>${active.windows.map((w) => `<div class="win"><span>${esc(w.label)}</span>${meter(w.left)}<span class="tn" style="text-align:right">${w.left}% left</span><small>${esc(w.reset)}</small></div>`).join("")}<div class="btns"><button class="btn" data-act="refresh:${engine}">${I("refresh", "sm")}Refresh</button><button class="btn" data-act="useReset:${engine}">Use one reset</button></div></div>` : ""}${rows}<button class="arow" data-act="addAccount:${engine}">${I("plus", "sm")}<span class="t">Add a ${engine === "claude" ? "Claude" : "Codex"} account</span></button></div>`;
    };
    return `<div class="pipe"><div class="pipe-head"><div class="tt"><div class="t">Accounts & limits</div><div class="sub">Meters fill with what remains · switching changes future launches only</div></div></div><div class="acc-body">${eng("claude", F.accounts.claude)}${eng("codex", F.accounts.codex)}</div>${toastHtml()}</div>`;
  }
  function tasksView() {
    return `<div class="pipe"><div class="pipe-head"><div class="tt"><div class="t">Tasks</div><div class="sub">${F.tasks.length} in ${esc(projectName(S.project === "all" ? "atlas" : S.project))}</div></div><button class="btn" data-act="newTask">${I("plus", "sm")}New task</button></div><div class="pipe-body"><div class="card tasks-list">${F.tasks.map((t) => `<button class="row" data-go="${t.linked ? `#/chat/${t.linked}` : "#/tasks"}"><span class="dot ${t.state === "waiting" ? "warn" : t.state === "in progress" ? "ok" : ""}"></span><span class="min0"><span class="t trunc">${esc(t.title)}</span><span class="m"><span class="fix">${esc(t.state)}</span>${t.linked ? `<span>·</span><span class="rest">${esc(conv(t.linked)?.title || "")}</span>` : ""}</span></span><span class="r">${badge(t.state, t.state === "waiting" ? "warn" : t.state === "in progress" ? "ok" : "")}</span></button>`).join("")}</div>${toastHtml()}</div></div>`;
  }
  function mapView() {
    const pipes = scopedPipes().filter((p) => p.state !== "completed" && p.state !== "draft");
    const inPipe = new Set(); pipes.forEach((p) => p.stages.forEach((s) => s.attempts.forEach((a) => a.conv && inPipe.add(a.conv))));
    const tile = (c) => { const b = stateBits(c); return `<button class="tile ${b.edge ? "wait" : ""}" data-go="#/chat/${c.id}"><span class="k"><span class="dot ${b.dot}"></span>${c.pipeline ? `stage ${c.pipeline.k}/${c.pipeline.n}` : c.seat ? "seat" : "conversation"}${b.badge ? badge(b.badge, "warn") : ""}</span><span class="t two">${esc(c.title)}</span><span class="m"><span>${esc(b.phrase)}</span><span>·</span>${mark(c.engine)}<span>${esc(c.model)}</span></span></button>`; };
    const ghost = (p, s, i) => `<button class="tile ghost" data-go="#/pipeline/${p.id}/stage/${s.id}"><span class="k"><span class="dot"></span>stage ${i + 1}/${p.stages.length} · ${esc(s.id)}</span><span class="t">${esc(s.role)} · not started</span><span class="m">${mark(s.engine)}<span>${esc(s.model)} · ${esc(s.effort)}</span></span></button>`;
    const regions = pipes.map((p) => `<div class="region"><span class="hub"><button class="chipbtn" data-go="#/pipeline/${p.id}" aria-label="Pipeline ${esc(p.task)}"><span class="chip ${p.state === "needs_decision" ? "warn" : "acc"}">${I("layers", "sm")}${esc(p.task)} · ${stageIndex(p, stageOf(p))}/${p.stages.length} · ${esc(pipeBits(p).phrase)}</span></button></span>${p.stages.map((s, i) => { const last = s.attempts[s.attempts.length - 1]; const c = last && last.conv ? conv(last.conv) : null; return c ? tile(c) : ghost(p, s, i); }).join("")}</div>`).join("");
    const loose = F.conversations.filter((c) => inScope(c) && !inPipe.has(c.id) && ["working", "waiting", "held", "stalled", "limit", "returned"].includes(stateBits(c).key)).map(tile).join("");
    return `<div class="map" data-map><div class="map-tools"><button class="iconbtn" data-act="zoom:-" aria-label="Zoom out">${I("minus")}</button><span class="zoom tn">100%</span><button class="iconbtn" data-act="zoom:+" aria-label="Zoom in">${I("plus")}</button><button class="iconbtn" data-act="zoom:fit" aria-label="Fit everything">${I("fitBox")}</button><button class="iconbtn" data-act="view:list" aria-label="Back to the list (m)">${I("list")}</button></div><div class="world">${regions}<div class="loose">${loose}</div></div><div class="minimap" aria-hidden="true"></div></div>`;
  }
  function emptyStage() {
    const a = attention();
    return `<div class="empty"><h2>${a.length ? `${a.length} need${a.length > 1 ? "" : "s"} you` : "Nothing needs you"}</h2><p>${a.length ? "Press n to open the next decision, or pick a row on the left." : "Pick a conversation on the left, or press o to talk to the orchestrator."}</p><div class="keys"><span><span class="kbd">n</span></span><span>next decision</span><span><span class="kbd">o</span></span><span>orchestrator</span><span><span class="kbd">/</span></span><span>find my messages</span><span><span class="kbd">m</span></span><span>map</span><span><span class="kbd">?</span></span><span>all shortcuts</span></div>${toastHtml()}</div>`;
  }

  /* ── dialogs ───────────────────────────────────────────────────────────── */
  const mrow = (icon, label, go, opts) => `<button class="mrow ${opts?.cls || ""}" ${go.startsWith("#") ? `data-go="${go}"` : `data-act="${go}"`} ${opts?.checked !== undefined ? `role="menuitemcheckbox" aria-checked="${opts.checked}"` : ""}>${I(icon)}<span class="l">${esc(label)}${opts?.sub ? `<small>${esc(opts.sub)}</small>` : ""}</span>${opts?.right ? `<span class="r">${opts.right}</span>` : ""}${opts?.kbd ? `<span class="kbd">${esc(opts.kbd)}</span>` : ""}</button>`;
  function dialogShell(title, body, opts) {
    return `<div class="scrim ${opts?.clear ? "clear" : ""}" data-scrim><div class="dialog ${opts?.wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-dialog><div class="dh"><h2>${esc(title)}${opts?.sub ? `<small>${esc(opts.sub)}</small>` : ""}</h2>${opts?.head || ""}<button class="iconbtn" data-act="close" aria-label="Close">${I("x")}</button></div>${body}${opts?.foot ? `<div class="df">${S.toast ? toastHtml() : ""}${opts.foot}</div>` : ""}</div></div>`;
  }
  function popShell(body, style, label) { return `<div class="scrim clear" data-scrim><div class="pop" role="dialog" aria-label="${esc(label || "Menu")}" style="${style}" data-dialog>${body}</div></div>`; }
  function dialogs() {
    const h = hashOf(); const s = segs();
    const c = s[0] === "chat" ? conv(s[1]) : null;
    if (h === "#/board/create") return popShell(`${mrow("plus", "New conversation", "#/board/new-agent", { sub: "engine, model, reasoning, account, prompt", kbd: "c" })}${mrow("flag", "New task", "newTask")}${mrow("layers", "New pipeline", "#/board/new-pipeline", { sub: "from a template or a blank graph" })}${F.seat.state === "none" ? mrow("bot", "Create an orchestrator", "#/seat/rotate") : ""}`, `top:52px;left:calc(var(--rail) + var(--col) - 96px)`, "Create");
    if (h === "#/board/menu") return popShell(`${mrow("flag", "Tasks", "#/tasks", { kbd: "t" })}${mrow("layers", "Pipelines", "#/pipelines", { kbd: "p" })}${mrow("list", "All conversations", "recentAll", { sub: `${F.conversations.filter(inScope).length} in this project` })}${mrow("person", "Accounts & limits", "#/accounts", { kbd: "a" })}${mrow("terminal", "Host details", "#/board/host", { right: F.runtime !== "connected" ? badge(F.runtime, F.runtime === "offline" ? "dng" : "info") : "", sub: `${F.hosts.length} background tasks` })}${mrow("keyboard", "Keyboard shortcuts", "#/board/keys", { kbd: "?" })}${mrow("bell", "Sound", "sound", { checked: S.sound })}<div class="msep"></div>${mrow("archive", "Archive project", "archiveProject", { sub: "moves it to the rail's Archive · Restore in the receipt" })}${mrow("trash", "Delete project", "deleteProject", { cls: "dng", sub: "acts now · Restore in the receipt for 4 s" })}`, `top:52px;left:calc(var(--rail) + var(--col) - 48px)`, "Board menu");
    if (h === "#/board/host") return dialogShell("Host details", `<div class="db"><div class="mrow" style="min-height:40px"><span class="dot ${F.runtime === "connected" ? "ok" : F.runtime === "degraded" ? "warn" : "dng"}"></span><span class="l">Runtime · ${F.runtime === "connected" ? "connected · updates stream" : F.runtime === "degraded" ? "degraded · polling every 10 s" : "offline · reconnecting"}</span></div><div class="mgrp">Background tasks · ${F.hosts.length}</div>${F.hosts.map((x) => `<div class="hostrow"><span class="n">${esc(x.name)}<small>pid <span class="mono">${x.pid}</span> · ${esc(x.mem)} · ${esc(x.since)}</small></span><button class="btn danger" data-act="killHost:${x.pid}">Kill</button></div>`).join("")}<div class="mgrp">Hidden · ${S.closed.size} closed conversations</div>${S.closed.size ? [...S.closed].map((id) => `<div class="hostrow"><span class="n">${esc(conv(id)?.title || id)}</span><button class="btn" data-act="reopen:${id}">Reopen</button></div>`).join("") : ""}</div>`, { sub: "the runtime, background tasks, hidden conversations", foot: `<button class="btn" data-act="close">Close</button>` });
    if (h === "#/board/keys") return dialogShell("Keyboard shortcuts", `<div class="keys-grid">${[["n", "next decision"], ["N", "previous decision"], ["o", "orchestrator"], ["/", "find my messages"], ["m", "map ⇄ list"], ["a", "accounts & limits"], ["p", "pipelines"], ["t", "tasks"], ["c", "create"], ["[", "collapse the rail"], ["↑ ↓", "move in the column"], ["Enter", "open the highlighted row"], ["Esc", "close · back to the column"], ["?", "this list"], ["Enter", "send (in the composer)"], ["Shift+Enter", "newline (in the composer)"]].map(([k, l]) => `<div class="kr"><span class="kbd">${esc(k)}</span><span>${esc(l)}</span></div>`).join("")}</div>`, { sub: "single keys while nothing is being typed", foot: `<button class="btn" data-act="close">Close</button>` });
    if (h === "#/board/search") {
      const q = S.search.trim().toLowerCase();
      const hits = []; for (const cv of F.conversations) for (const m of cv.feed || []) { if (S.searchScope === "mine" && m.kind !== "user") continue; if (m.kind !== "user" && m.kind !== "agent") continue; if (q && !m.text.toLowerCase().includes(q)) continue; hits.push({ cv, m }); }
      const hl = (t) => q ? esc(t).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (x) => `<mark>${x}</mark>`) : esc(t);
      return dialogShell("Find my messages", `<div class="db form" style="padding-bottom:0"><div class="rowf" style="display:flex;gap:6px"><input class="field" style="flex:1" value="${esc(S.search)}" data-act="search" data-autofocus placeholder="Search everything you've sent…" aria-label="Search"><div class="seg"><button class="${S.searchScope === "mine" ? "on" : ""}" data-act="scope:mine" aria-pressed="${S.searchScope === "mine"}">My messages</button><button class="${S.searchScope === "all" ? "on" : ""}" data-act="scope:all" aria-pressed="${S.searchScope === "all"}">Everything</button></div></div><div class="hint">${q ? `${hits.length} results · ranked in memory · ↑ ↓ to move · Enter opens the conversation at the message` : "Every project, engine and account. Results open in the conversation with the composer."}</div></div><div class="db search-rows">${hits.slice(0, 8).map(({ cv, m }) => `<button class="mrow" data-go="#/chat/${cv.id}" data-project="${cv.project}"><span class="l"><b class="trunc">${esc(cv.title)}</b><span class="snip trunc">${hl(m.text.split("\n")[0])}</span></span><span class="r"><span class="pj">${esc(projectName(cv.project))}</span>${mark(cv.engine)}<span class="tn">${esc(m.ts || "")}</span></span></button>`).join("")}${q && !hits.length ? `<div class="hint" style="padding:12px">Nothing found for «${esc(S.search)}»</div>` : ""}</div>`, { wide: true });
    }
    if (h === "#/board/new-agent") {
      const d = S.newAgent || (S.newAgent = { engine: "claude", model: "Opus", effort: "high", account: "cl-main", cwd: "~/Projects/atlas", prompt: "" });
      const accts = F.accounts[d.engine];
      return dialogShell("New conversation", `<div class="db form"><label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "na:engine")}</label><label>Model ${segHtml("Model", MODELS[d.engine], d.model, "na:model")}</label><label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "na:effort")}</label><label>Account</label>${accts.map((a) => `<button class="arow ${d.account === a.id ? "on" : ""}" data-act="${a.auth === "Authenticated" ? `na:account:${a.id}` : `signIn:${d.engine}:${a.id}`}"><span class="dot ${a.auth === "Authenticated" ? "ok" : ""}"></span><span class="t">${esc(a.label)}<small>${esc(a.plan)}${a.windows[0] ? ` · ${a.windows[0].left}% left` : ""}</small></span>${a.auth === "Authenticated" ? (d.account === a.id ? badge("chosen", "acc") : badge("ready", "ok")) : `<span class="signin">sign in →</span>`}</button>`).join("")}<label>Directory <input class="field mono" value="${esc(d.cwd)}" data-act="na:cwd"></label><label>First message <textarea class="field" data-act="na:prompt" data-autofocus placeholder="What should the agent do?">${esc(d.prompt)}</textarea></label></div>`, { sub: `in ${projectName(S.project === "all" ? "atlas" : S.project)}`, foot: `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="startAgent">Start conversation</button>` });
    }
    if (h === "#/board/new-pipeline") return dialogShell("New pipeline", `<div class="db form"><label>Repository <input class="field mono" value="~/Projects/${esc(S.project === "all" ? "atlas" : S.project)}" data-act="np:repo"></label><div class="hint">Repository ready · the pipeline gets its own worktree and branch.</div><div class="tpl">${[["Plan → Build → Review", ["architect", "builder", "reviewer ↺"]], ["Build → Review", ["builder", "reviewer ↺"]], ["Build → Verify", ["builder", "verifier"]], ["Blank graph", []]].map(([t, roles], i) => `<button data-act="np:template:${i}" ${i === 0 ? "data-autofocus" : ""}><b>${esc(t)}</b>${roles.length ? `<span class="flow">${roles.map((r) => badge(r, r.includes("↺") ? "acc" : "")).join(I("arrowR", "sm"))}</span>` : `<span class="hint">Start empty and assemble the stages by hand.</span>`}</button>`).join("")}</div></div>`, { sub: "a draft lands on the board; edit stages before or after start" });
    if (h === "#/seat/rotate") {
      const create = F.seat.state === "none"; const d = S.rotate || (S.rotate = { engine: F.seat.engine, model: F.seat.model, effort: F.seat.effort, account: "cl-main", mandate: F.seat.mandate });
      return dialogShell(create ? "Create an orchestrator" : "Rotate the orchestrator", `<div class="db form"><div class="hint">${create ? "The orchestrator runs this board and talks to you here. It starts with the mandate below." : "A successor takes the seat with the mandate below; the current orchestrator hands over its context and stops."}</div><label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "ro:engine")}</label><label>Model ${segHtml("Model", MODELS[d.engine], d.model, "ro:model")}</label><label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "ro:effort")}</label><label>Account</label>${F.accounts[d.engine].filter((a) => a.auth === "Authenticated").map((a) => `<button class="arow ${d.account === a.id ? "on" : ""}" data-act="ro:account:${a.id}"><span class="dot ok"></span><span class="t">${esc(a.label)}<small>${esc(a.plan)}</small></span>${d.account === a.id ? badge("chosen", "acc") : badge("ready", "ok")}</button>`).join("")}<label>Mandate <textarea class="field" data-act="ro:mandate" data-autofocus data-orchestrator-mandate>${esc(d.mandate)}</textarea></label></div>`, { foot: `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="${create ? "createSeat" : "rotateSeat"}" data-orchestrator-primary>${create ? "Create orchestrator" : "Rotate orchestrator"}</button>` });
    }
    if (c && h.endsWith("/menu")) {
      const b = stateBits(c); const p = c.pipeline ? pipe(c.pipeline.id) : null;
      const first = (c.seat ? mrow("bot", "Orchestrator seat", "#/seat", { sub: "status · context · mandate · rotate" }) : "") + (p ? mrow("layers", `Pipeline · ${p.task}`, `#/pipeline/${p.id}`, { sub: `stage ${c.pipeline.k}/${c.pipeline.n} · ${c.pipeline.stage} · ${pipeBits(p).phrase}` }) : "");
      return popShell(`${first}${first ? '<div class="msep"></div>' : ""}${canPin() ? mrow("panel", S.pin === c.id ? "Unpin" : "Pin beside", S.pin === c.id ? "unpin" : `pin:${c.id}`) : ""}${mrow("pencil", "Rename", `rename:${c.id}`)}${mrow("crown", S.crowned.has(c.id) ? "Remove crown" : "Crown", `crown:${c.id}`)}${mrow("swap", "Hand off", `handoff:${c.id}`, { sub: "start a successor with this context" })}${mrow("compress", "Compact context", `compact:${c.id}`, { right: `${100 - (c.ctx || 0)}% left` })}${mrow("info", "Details & host", `#/chat/${c.id}/details`)}${mrow("terminal", "Open in terminal", `terminal:${c.id}`)}<div class="msep"></div>${mrow("x", "Close card", `close:${c.id}`, { sub: "Reopen in the receipt" })}${mrow("square", "Kill agent", `kill:${c.id}`, { cls: "dng", sub: b.key === "working" ? "running now" : b.key === "stalled" ? "stalled" : "not running" })}`, `top:52px;right:8px`, "Conversation actions");
    }
    if (c && h.endsWith("/model")) {
      const nx = S.next[c.id] || { model: c.model, effort: c.effort, account: c.account }; const b = stateBits(c);
      const acct = b.key === "limit" ? `<div class="mgrp">Account</div>${F.accounts[c.engine].map((a) => a.active ? `<div class="mrow"><span class="dot warn"></span><span class="l">${esc(a.label)}<small>limit · resets ${esc(c.limitReset || "16:40")}</small></span>${badge("limit", "warn")}</div>` : `<button class="mrow" data-act="${a.auth === "Authenticated" ? `md:${c.id}:account:${a.id}` : `signIn:${c.engine}:${a.id}`}"><span class="dot ${a.auth === "Authenticated" ? "ok" : ""}"></span><span class="l">${esc(a.label)}<small>${esc(a.plan)}</small></span>${a.auth === "Authenticated" ? badge("ready", "ok") : `<span class="signin">sign in →</span>`}</button>`).join("")}<div class="msep"></div>` : "";
      return popShell(`<div class="mgrp">Applies to your next message · ${esc(nx.model)} · ${esc(nx.effort)}</div>${acct}<div class="mgrp">Model</div>${MODELS[c.engine].map((m) => `<button class="mrow ${nx.model === m ? "on" : ""}" data-act="md:${c.id}:model:${m}">${mark(c.engine)}<span class="l">${esc(m)}</span>${nx.model === m ? I("check") : ""}</button>`).join("")}<div class="mgrp">Reasoning</div>${EFFORTS.map((e) => `<button class="mrow ${nx.effort === e ? "on" : ""}" data-act="md:${c.id}:effort:${e}">${I("zap")}<span class="l">${esc(e)}</span>${nx.effort === e ? I("check") : ""}</button>`).join("")}${c.engine === "codex" ? `<div class="mgrp">Speed</div>${["standard", "fast · priority tier"].map((sp, i) => `<button class="mrow ${(nx.speed || 0) === i ? "on" : ""}" data-act="md:${c.id}:speed:${i}">${I("zap")}<span class="l">${esc(sp)}</span>${(nx.speed || 0) === i ? I("check") : ""}</button>`).join("")}` : ""}`, `bottom:70px;left:calc(var(--rail) + var(--col) + 24px)`, "Next message");
    }
    if (c && h.endsWith("/details")) {
      const p = c.pipeline ? pipe(c.pipeline.id) : null;
      return dialogShell("Details & host", `<div class="db"><div class="mgrp">This conversation</div><dl class="details-grid"><dt>Account</dt><dd>${esc(c.account)} · ${esc(c.engine === "claude" ? "Claude" : "Codex")}</dd><dt>Context</dt><dd style="display:flex;align-items:center;gap:8px">${meter(100 - (c.ctx || 0))}<span class="tn">${100 - (c.ctx || 0)}% left</span></dd><dt>Worktree</dt><dd class="mono">${esc(c.worktree || "—")}</dd><dt>Pipeline</dt><dd>${p ? `${esc(p.task)} · stage ${c.pipeline.k}/${c.pipeline.n}` : "—"}</dd><dt>Members</dt><dd>${c.children ? c.children.map((k) => `${esc(k.title)} · ${esc(k.state)}`).join("<br>") : "—"}</dd></dl><div class="mgrp">Host</div><div class="mrow" style="min-height:40px"><span class="dot ${F.runtime === "connected" ? "ok" : "warn"}"></span><span class="l">Runtime · ${esc(F.runtime)}</span></div>${F.hosts.map((x) => `<div class="hostrow"><span class="n">${esc(x.name)}<small>pid <span class="mono">${x.pid}</span> · ${esc(x.mem)}</small></span><button class="btn danger" data-act="killHost:${x.pid}">Kill</button></div>`).join("")}</div>`, { sub: c.title, foot: `<button class="btn" data-act="close">Close</button>` });
    }
    return "";
  }

  /* ── stage router ──────────────────────────────────────────────────────── */
  function stage() {
    const s = segs(); const h = hashOf();
    if (S.view === "map" && (s[0] === "board" || s[0] === "map")) return mapView();
    if (s[0] === "overview") return overview();
    if (s[0] === "chat") { const c = conv(s[1]); return c ? chatView(c) : emptyStage(); }
    if (s[0] === "seat") { const c = seatConv(); return c ? chatView(c, { seatPanel: true }) : emptyStage(); }
    if (s[0] === "pipelines") return pipelinesList();
    if (s[0] === "pipeline") { const p = pipe(s[1]); if (!p) return emptyStage(); return pipeView(p, s[2] === "stage" ? p.stages.find((x) => x.id === s[3]) : null, s[2] === "add" ? Number(s[3]) : undefined); }
    if (s[0] === "accounts") return accountsView();
    if (s[0] === "tasks") return tasksView();
    return emptyStage();
  }
  function statusBar() {
    const rt = F.runtime; const cl = F.accounts.claude.find((a) => a.active); const cx = F.accounts.codex.find((a) => a.active);
    const low = (a) => a && a.windows.length ? Math.min(...a.windows.map((w) => w.left)) : null;
    const acc = (engine, a) => { const l = low(a); return `<button class="sbtn" data-go="#/accounts" aria-label="${engine} account ${a ? a.label : ""}"><span class="sb ${l !== null && l <= 10 ? "dng" : l !== null && l <= 30 ? "warn" : ""}">${mark(engine)}${a ? `${esc(a.label)} · <span class="tn">${l}% left</span>` : "no account"}</span></button>`; };
    return `<div class="statusbar"><button class="sbtn" data-go="#/board/host" aria-label="Runtime ${rt}"><span class="sb ${rt === "offline" ? "dng" : rt === "degraded" ? "warn" : ""}"><span class="dot ${rt === "connected" ? "ok" : rt === "degraded" ? "warn" : "dng"}"></span>${rt === "connected" ? "connected" : rt === "degraded" ? "degraded · polling" : "offline · reconnecting"}</span></button><button class="sbtn" data-go="#/board/host" aria-label="Background tasks"><span class="sb">${I("terminal", "sm")}${F.hosts.length} background tasks</span></button><span class="sp"></span>${acc("claude", cl)}${acc("codex", cx)}<button class="sbtn" data-go="#/board/keys" aria-label="Keyboard shortcuts"><span class="sb"><span class="kbd">?</span> shortcuts</span></button></div>`;
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  let lastHash = "";
  function render() {
    const h = hashOf(); const s = segs();
    if (s[0] === "overview") S.project = "all";
    else if (S.project === "all" && s[0] !== "overview") { const c = s[0] === "chat" ? conv(s[1]) : null; const p = s[0] === "pipeline" ? pipe(s[1]) : null; if (c && !c.seat) S.project = c.project; else if (p) S.project = p.project; }
    if (s[0] === "map") S.view = "map"; /* the route names the view, so a deep link to #/map shows the map */
    if (s[0] === "chat" && conv(s[1])) S.seen.add(s[1]);
    if (s[0] !== "pipeline") S.editorDraft = null;
    $app.dataset.rail = S.rail ? "1" : "0";
    $app.dataset.pin = S.pin && canPin() ? "1" : "0";
    const pinConv = S.pin && canPin() ? conv(S.pin) : null;
    $app.innerHTML = `${rail()}${column()}<main class="stage" aria-label="Stage">${banner()}${stage()}</main>${pinConv ? `<aside class="pin" aria-label="Pinned conversation">${chatView(pinConv, { pinned: true })}</aside>` : ""}${statusBar()}${dialogs()}`;
    const screen = SCREENS.find((x) => x.hash === location.hash || x.hash.split("?")[0] === h);
    $app.dataset.screen = screen ? screen.id : h;
    $app.dataset.ready = "1";
    if (h !== lastHash) {
      lastHash = h;
      const dlg = $app.querySelector("[data-dialog]");
      if (dlg) { const first = dlg.querySelector("[data-autofocus]") || dlg.querySelector("button, input, textarea, select"); if (first) first.focus(); }
      const feed = $app.querySelector(".stage .feed"); if (feed) feed.scrollTop = feed.scrollHeight;
    }
    const bench = document.getElementById("bench-screens"); if (bench && !bench.childElementCount) bench.innerHTML = SCREENS.map((x) => `<a href="?${x.scenario ? `scenario=${x.scenario}&` : ""}w=${width()}${params.get("scheme") ? `&scheme=${params.get("scheme")}` : ""}${x.hash}" ${x.id === $app.dataset.screen ? 'class="on"' : ""}>${esc(x.id)}</a>`).join("");
    if (S.arrival === null && F.arrival && !S.arrivalTimer) { S.arrivalTimer = setTimeout(() => { S.arrival = { id: F.arrival.id }; render(); setTimeout(() => { S.arrivalDismissed = true; render(); }, 6000); }, F.arrival.after || 400); }
  }

  /* ── acts ──────────────────────────────────────────────────────────────── */
  function attempt(p, s, state) { const n = s.attempts.length + 1; s.attempts.push({ n, state, conv: null, head: "worktree" }); return n; }
  function mutate(p, action, stageId, effect, detail) { p.revision += 1; p.mutations.push({ seq: p.mutations.length + 1, at: F.now, actor: "operator", action, stage: stageId, effect, revision: p.revision, detail }); p.lastEdit = { actor: "operator", at: "now", action: `${action}${stageId ? ` · ${stageId}` : ""}` }; }
  function pipelineAct(kind, pid, sid) {
    const p = pipe(pid); if (!p) return; const s = sid ? p.stages.find((x) => x.id === sid) : null; const d = S.editorDraft || {};
    const rev = () => `rev ${p.revision} · expectedRevision ${p.revision - 1}`;
    if (kind === "start") { p.state = "running"; p.started = "now"; p.branch = `pipeline/${p.id}`; attempt(p, p.stages[0], "running"); p.cursor = { stageId: p.stages[0].id, attempt: 1 }; mutate(p, "start", null, "applied"); toast("Pipeline started", `attempt 1 of ${p.stages[0].id} · ${rev()}`, { label: "Pause", act: `pa:pause:${pid}` }); }
    else if (kind === "discard") { p.state = "closed"; toast("Draft discarded", null, { label: "Restore", act: `pa:restore:${pid}` }); go("#/pipelines", { replace: true }); }
    else if (kind === "retry") { const cur = stageOf(p); attempt(p, cur, "running"); p.state = "running"; p.findings = []; mutate(p, "rerun-stage", cur.id, "applied", "from last-passed"); toast(`Attempt ${cur.attempts.length} of ${cur.id} started`, `from the last passed commit · ${rev()}`, { label: "Pause", act: `pa:pause:${pid}` }); }
    else if (kind === "skip") { const cur = stageOf(p); const i = p.stages.indexOf(cur); const nx = p.stages.find((x) => x.id === cur.next) || p.stages[i + 1]; cur.attempts.push({ n: cur.attempts.length + 1, state: "skipped", conv: null, head: null }); if (nx) { p.cursor = { stageId: nx.id, attempt: 1 }; attempt(p, nx, "running"); p.state = "running"; } else p.state = "completed"; p.findings = []; mutate(p, "skip-stage", cur.id, "applied", "no worktree reset"); toast(`Skipped ${cur.id}`, nx ? `${nx.id} started · ${rev()}` : `pipeline completed · ${rev()}`, { label: "Retry stage", act: `pa:retryStage:${pid}:${cur.id}` }); }
    else if (kind === "retryStage") { const cur = s; cur.attempts.pop(); const nxt = p.stages.find((x) => x.id === cur.next); if (nxt && nxt.attempts.length) nxt.attempts.pop(); p.cursor = { stageId: cur.id, attempt: cur.attempts.length + 1 }; attempt(p, cur, "running"); p.state = "running"; mutate(p, "rerun-stage", cur.id, "applied", "undo skip"); toast(`Attempt ${cur.attempts.length} of ${cur.id} started`, rev()); }
    else if (kind === "pause") { p.pausedFrom = p.state; p.state = "paused"; mutate(p, "pause", null, "applied"); toast("Paused", "a parked stage stays visible while paused", { label: "Resume", act: `pa:resume:${pid}` }); }
    else if (kind === "resume") { p.state = p.pausedFrom || "running"; mutate(p, "resume", null, "applied"); toast("Resumed", rev()); }
    else if (kind === "archive") { p.prevState = p.state; p.state = "closed"; mutate(p, "close", null, "applied"); toast("Archived", "hosts stopped · worktree kept", { label: "Restore", act: `pa:restore:${pid}` }); }
    else if (kind === "restore") { p.state = p.prevState || (p.mutations.length ? "running" : "draft"); toast("Restored", rev()); }
    else if (kind === "checkpoint") { const name = `checkpoint-${p.checkpoints.length + 1}`; p.checkpoints.push({ name, sha: "f00d1e", at: F.now }); mutate(p, "checkpoint", stageOf(p).id, "applied", name); toast(`Checkpoint ${name}`, `worktree committed · ${rev()}`); }
    else if (kind === "answer") { const field = $app.querySelector('[data-act="answerField"]'); const text = field ? field.value.trim() : ""; const cur = stageOf(p); const n = attempt(p, cur, "running"); p.state = "running"; p.findings = []; mutate(p, "answer", cur.id, "applied", text ? text.slice(0, 40) : "(empty)"); toast(`Answered · attempt ${n} of ${cur.id} started`, `the question and your answer travel as a note · ${rev()}`, { label: "Pause", act: `pa:pause:${pid}` }); }
    else if (kind === "editStage" || kind === "editRestart") {
      const running = s.attempts.some((a) => a.state === "running" || a.state === "pending");
      Object.assign(s, { role: d.role, engine: d.engine, model: d.model, effort: d.effort, access: d.access, sandbox: d.sandbox, outputs: d.outputs ? d.outputs.split(",").map((x) => x.trim()).filter(Boolean) : [], prompt: d.prompt });
      if (kind === "editRestart" && running) { const last = s.attempts[s.attempts.length - 1]; last.state = "failed"; last.stopped = true; const n = attempt(p, s, "running"); s.pendingEdit = null; mutate(p, "edit-stage", s.id, "restarted-attempt", `restart: attempt ${last.n} stopped, ${n} started`); toast(`Saved and restarted · attempt ${n} of ${s.id}`, `attempt ${last.n} stopped · ${rev()}`); }
      else if (running) { s.pendingEdit = { fromRevision: p.revision + 1, appliesFrom: s.attempts.length + 1 }; mutate(p, "edit-stage", s.id, "pending-next-attempt", `applies from attempt ${s.attempts.length + 1}`); toast(`Saved · applies from attempt ${s.attempts.length + 1} of ${s.id}`, `attempt ${s.attempts.length} keeps its own definition · ${rev()}`); }
      else { mutate(p, "edit-stage", s.id, "applied", `applies from attempt ${s.attempts.length + 1}`); toast(`Saved · ${s.id}`, `applies from attempt ${s.attempts.length + 1} · ${rev()}`); }
    }
    else if (kind === "setEdge") { s.next = d.passTo || null; s.onFail = d.failTo ? { to: d.failTo, maxRounds: Number(d.maxRounds) || 0 } : null; mutate(p, "set-edge", s.id, "applied", `pass → ${s.next || "end"} · fail ↺ ${s.onFail ? `${s.onFail.to} ×${s.onFail.maxRounds}` : "none"}`); toast(`Edges saved · ${s.id}`, `applies at the next verdict · ${rev()}`); }
    else if (kind === "note") { const t = (d.note || "").trim(); if (!t) { toast("Write the note first"); return; } s.notes = s.notes || []; if (s.notes.length >= 10) { toast("Ten notes are pending on this stage", "the next attempt takes them; add more after it binds"); return; } s.notes.push({ seq: s.notes.length + 1, text: t }); d.note = ""; mutate(p, "note", s.id, "applied", `applies from attempt ${s.attempts.length + 1}`); toast(`Note added · attempt ${s.attempts.length + 1} of ${s.id} takes it`, rev()); }
    else if (kind === "rerun") { const running = s.attempts.some((a) => a.state === "running" || a.state === "pending"); if (running && !d.stopCurrent) { toast("Refused: an attempt is unsettled", `attempt ${s.attempts.length} of ${s.id} is running`); return; } if (running) { const last = s.attempts[s.attempts.length - 1]; last.state = "failed"; last.stopped = true; } const n = attempt(p, s, "running"); p.cursor = { stageId: s.id, attempt: n }; p.state = "running"; p.findings = []; s.pendingEdit = null; mutate(p, "rerun-stage", s.id, running ? "restarted-attempt" : "applied", `from ${d.rerunFrom}${running ? " · stopCurrent" : ""}`); toast(`Attempt ${n} of ${s.id} started`, `from ${d.rerunFrom}${running ? " · stopCurrent" : ""} · ${rev()}`, { label: "Pause", act: `pa:pause:${pid}` }); }
    else if (kind === "rerunLast") { const last = p.stages[p.stages.length - 1]; const n = attempt(p, last, "running"); p.cursor = { stageId: last.id, attempt: n }; p.state = "running"; mutate(p, "rerun-stage", last.id, "applied", "reopened a completed pipeline"); toast(`Reopened · attempt ${n} of ${last.id} started`, rev()); }
    else if (kind === "removeStage") { if (s.attempts.length) return; const i = p.stages.indexOf(s); p.stages.splice(i, 1); for (const x of p.stages) { if (x.next === s.id) x.next = p.stages[i] ? p.stages[i].id : null; if (x.onFail && x.onFail.to === s.id) x.onFail = null; } mutate(p, "remove-stage", s.id, "applied"); toast(`Removed ${s.id}`, rev(), { label: "Undo", act: `pa:restoreStage:${pid}:${i}` }); S.removed = { stage: s, index: i }; go(`#/pipeline/${pid}`, { replace: true }); }
    else if (kind === "restoreStage") { if (!S.removed) return; p.stages.splice(S.removed.index, 0, S.removed.stage); mutate(p, "add-stage", S.removed.stage.id, "applied", "undo remove"); S.removed = null; toast("Stage restored", rev()); }
    else if (kind === "addStage") { const index = Number(sid); const id = (d.id || "").trim() || `stage-${p.stages.length + 1}`; if (p.stages.some((x) => x.id === id)) { toast("A stage with that id exists"); return; } const prev = p.stages[index - 1]; const nxt = p.stages[index]; const st = { id, role: d.role, engine: d.engine, model: d.model, effort: d.effort, access: d.access, sandbox: d.sandbox, outputs: [], next: nxt ? nxt.id : null, onFail: null, attempts: [], prompt: d.prompt || "{{prev.output}}" }; p.stages.splice(index, 0, st); if (prev) prev.next = id; mutate(p, "add-stage", id, "applied", `at ${index}`); S.editorDraft = null; toast(`Added ${id}`, `inserted at its seam · ${rev()}`, { label: "Undo", act: `pa:removeStage:${pid}:${id}` }); go(`#/pipeline/${pid}/stage/${id}`, { replace: true }); return; }
    render();
  }
  function act(name, el) {
    const [kind, a, b, c] = name.split(":");
    if (kind === "close" && !a) return closeDialog(); /* «close» = the dialog; «close:<id>» = the card, below */
    if (kind === "undo") { const u = S.toast && S.toast.undo; S.toast = null; if (u) return act(u.act, el); return render(); }
    if (kind === "rail") { S.rail = !S.rail; return render(); }
    if (kind === "view") { S.view = a; if (a === "map" && !/^#\/(board|map)/.test(hashOf())) return go("#/map"); if (a === "list" && hashOf() === "#/map") return go("#/board", { replace: true }); return render(); }
    if (kind === "toggle") { if (S.collapsed.has(a)) S.collapsed.delete(a); else S.collapsed.add(a); return render(); }
    if (kind === "recentAll") { S.recentAll = true; if (isDialog(hashOf())) return closeDialog(); return render(); }
    if (kind === "sound") { S.sound = !S.sound; return render(); }
    if (kind === "msg") return toast("Copied the message", "Read aloud is the other action here");
    if (kind === "attach") return toast("Attach files or images", "opens the file picker");
    if (kind === "dictate") return toast("Dictation started", "speak, then send", { label: "Stop", act: "noop" });
    if (kind === "noop") return render();
    if (kind === "send") { const cv = conv(a); const t = (S.drafts[a] || "").trim(); if (!t) return; cv.feed.push({ kind: "user", ts: F.now, text: t }); if (cv.question && !S.answers[a]) S.answers[a] = t; S.drafts[a] = ""; if (cv.state !== "working") { cv.state = "working"; cv.elapsed = "0:03"; cv.tool = undefined; } toast("Sent", `${cv.title} · ${F.now}`); return; }
    if (kind === "stop") { const cv = conv(a); cv.state = "returned"; cv.age = "now"; toast("Stopped the agent", "the turn ended; text you send starts a new one", { label: "Resume", act: `resume:${a}` }); return; }
    if (kind === "resume") { conv(a).state = "working"; return render(); }
    if (kind === "queue") { const cv = conv(a); const t = (S.drafts[a] || "").trim(); if (!t) return; cv.feed.push({ kind: "user", ts: F.now, text: t }); S.drafts[a] = ""; toast("Held until reconnected", "delivered in order when the runtime returns"); return; }
    if (kind === "respawn") { S.killed.delete(a); const cv = conv(a); cv.state = "working"; toast("Respawned", "queued messages deliver in order"); return; }
    if (kind === "kill") { S.killed.add(a); if (isDialog(hashOf())) closeDialog(); toast("Killed the agent", "text you send queues until a respawn", { label: "Respawn", act: `respawn:${a}` }); return; }
    if (kind === "close") { S.closed.add(a); closeDialog(); go("#/board", { replace: true }); toast("Closed the card", "it stays in Host details › Hidden", { label: "Reopen", act: `reopen:${a}` }); return; }
    if (kind === "reopen") { S.closed.delete(a); toast("Reopened"); return go(`#/chat/${a}`, { replace: true }); }
    if (kind === "crown") { if (S.crowned.has(a)) S.crowned.delete(a); else S.crowned.add(a); closeDialog(); toast(S.crowned.has(a) ? "Crowned" : "Crown removed"); return; }
    if (kind === "rename") { closeDialog(); const cv = conv(a); const t = prompt ? null : null; cv.title = cv.title.endsWith(" ✎") ? cv.title : cv.title; toast("Rename", "the title cell becomes editable in place"); return; }
    if (kind === "handoff") { closeDialog(); const cv = conv(a); const nc = { id: `h-${a}`, project: cv.project, title: `${cv.title} · handoff`, engine: cv.engine, model: cv.model, effort: cv.effort, account: cv.account, state: "working", elapsed: "0:02", age: "now", ctx: 4, feed: [{ kind: "user", ts: F.now, text: `Continue from the handoff of «${cv.title}».` }] }; F.conversations.push(nc); toast("Handed off", `a successor started with this context`, { label: "Open successor", act: `open:${nc.id}` }); return; }
    if (kind === "open") return go(`#/chat/${a}`);
    if (kind === "compact") { closeDialog(); const cv = conv(a); cv.ctx = Math.max(2, Math.round((cv.ctx || 0) / 3)); toast("Compacted the context", `${100 - cv.ctx}% left`); return; }
    if (kind === "terminal") { closeDialog(); toast("Opened in the terminal", "attach command copied"); return; }
    if (kind === "pin") { S.pin = a; closeDialog(); toast("Pinned beside", "the pane stays while you move around", { label: "Unpin", act: "unpin" }); return; }
    if (kind === "unpin") { S.pin = null; if (isDialog(hashOf())) closeDialog(); return render(); }
    if (kind === "answer") { const cv = conv(a); const o = cv.question.options[Number(b)]; S.answers[a] = o.label; cv.feed.push({ kind: "agent-hidden" }); cv.state = "working"; cv.elapsed = "0:02"; toast("Answered", `${o.label} · ${F.now}`); return; }
    if (kind === "answerText") { const cv = conv(a); const t = name.slice(name.indexOf(":", name.indexOf(":") + 1) + 1); S.answers[a] = t; cv.state = "working"; cv.elapsed = "0:02"; toast("Answered", `${t} · ${F.now}`); return; }
    if (kind === "toggleQ") { const k = a + ":open"; S.pickedOption[k] = !S.pickedOption[k]; return render(); }
    if (kind === "md") { const nx = S.next[a] || (S.next[a] = { model: conv(a).model, effort: conv(a).effort, account: conv(a).account }); if (b === "account") { const acc = F.accounts[conv(a).engine].find((x) => x.id === c); nx.account = acc.label; conv(a).state = "working"; conv(a).account = acc.label; closeDialog(); toast(`Next message launches on ${acc.label}`, "the limit on Main stays until it resets", { label: "Switch back", act: `md:${a}:back:0` }); return; } if (b === "back") { conv(a).state = "limit"; return render(); } nx[b] = b === "speed" ? Number(c) : c; closeDialog(); return; }
    if (kind === "switch") { const list = F.accounts[a]; const prev = list.find((x) => x.active); list.forEach((x) => { x.active = x.id === b; }); toast(`Future launches use ${list.find((x) => x.active).label}`, "running conversations keep their account", { label: "Switch back", act: `switch:${a}:${prev.id}` }); return; }
    if (kind === "signIn") { toast("Device sign-in opened", "the account becomes active only after it returns"); return; }
    if (kind === "refresh") { toast("Refreshed", `checked ${F.now}`); return; }
    if (kind === "useReset") { const acc = F.accounts[a].find((x) => x.active); acc.windows[0].left = 100; toast("Used one reset", "the 5 h window is full again"); return; }
    if (kind === "addAccount") { toast("Add an account", "opens the device sign-in"); return; }
    if (kind === "killHost") { const i = F.hosts.findIndex((x) => x.pid === Number(a)); const h = F.hosts[i]; if (i >= 0) F.hosts.splice(i, 1); toast(`Killed ${h ? h.name : a}`, `pid ${a}`); return; }
    if (kind === "archiveProject") { closeDialog(); const p = S.project; S.archivedProjects.add(p); go("#/overview", { replace: true }); toast(`Archived ${projectName(p)}`, "it stays in the rail's Archive", { label: "Restore", act: `restoreProject:${p}` }); return; }
    if (kind === "restoreProject") { S.archivedProjects.delete(a); S.deletedProjects.delete(a); toast(`Restored ${projectName(a)}`); return; }
    if (kind === "deleteProject") { closeDialog(); const p = S.project; S.deletedProjects.add(p); go("#/overview", { replace: true }); toast(`Deleted ${projectName(p)}`, "conversations stay on disk for 4 s of regret", { label: "Restore", act: `restoreProject:${p}` }); return; }
    if (kind === "createProject") { toast("Create project", "name and root directory, then it appears in the rail"); return; }
    if (kind === "newTask") { F.tasks.unshift({ id: `t${F.tasks.length + 1}`, title: "New task", state: "inbox" }); if (isDialog(hashOf())) closeDialog(); go("#/tasks", { replace: true }); toast("Task created", "edit it in place"); return; }
    if (kind === "openArrival") { const id = S.arrival.id; S.seen.add(id); S.arrival = null; return go(`#/chat/${id}`); }
    if (kind === "dismissArrival") { S.arrivalDismissed = true; return render(); }
    if (kind === "predecessor") { toast("Predecessor", "opens the previous seat's conversation"); return; }
    if (kind === "rotateSeat" || kind === "createSeat") { const d = S.rotate; F.seat.state = "live"; F.seat.engine = d.engine; F.seat.model = d.model; F.seat.effort = d.effort; F.seat.mandate = d.mandate; F.seat.mandateVersion += 1; F.seat.since = "now"; F.seat.ctx = { left: 100, window: "100k" }; F.seat.predecessor = kind === "rotateSeat"; let sc = seatConv(); if (!sc) { sc = { id: "orch", project: S.project === "all" ? "atlas" : S.project, title: `Orchestrator · ${projectName(S.project === "all" ? "atlas" : S.project)}`, engine: d.engine, model: d.model, effort: d.effort, account: "Main", state: "working", elapsed: "0:01", age: "now", seat: true, ctx: 0, feed: [] }; F.conversations.unshift(sc); } else { sc.engine = d.engine; sc.model = d.model; sc.effort = d.effort; sc.feed.push({ kind: "agent", ts: F.now, text: `Seat taken. Mandate v${F.seat.mandateVersion} loaded; predecessor context handed over.` }); } S.rotate = null; go("#/seat", { replace: true }); toast(kind === "rotateSeat" ? "Rotated the orchestrator" : "Created the orchestrator", `${d.model} · ${d.effort} · mandate v${F.seat.mandateVersion}`); return; }
    if (kind === "startAgent") { const d = S.newAgent; const nc = { id: `n${F.conversations.length}`, project: S.project === "all" ? "atlas" : S.project, title: (d.prompt || "New conversation").split("\n")[0].slice(0, 60) || "New conversation", engine: d.engine, model: d.model, effort: d.effort, account: F.accounts[d.engine].find((x) => x.id === d.account)?.label || "Main", state: "working", elapsed: "0:01", age: "now", ctx: 1, feed: d.prompt ? [{ kind: "user", ts: F.now, text: d.prompt }] : [] }; F.conversations.push(nc); S.newAgent = null; go(`#/chat/${nc.id}`, { replace: true }); toast("Conversation started", `${nc.model} · ${nc.effort} · ${nc.account}`, { label: "Kill", act: `kill:${nc.id}` }); return; }
    if (kind === "np") { if (a === "template") { const t = Number(b); const tpl = [["plan", "build", "review"], ["build", "review"], ["build", "verify"], []][t]; const roles = { plan: "architect", build: "builder", review: "reviewer", verify: "builder" }; const id = `np${F.pipelines.length}`; const stages = tpl.map((sid, i) => ({ id: sid, role: roles[sid], engine: sid === "review" || sid === "plan" ? "claude" : "codex", model: sid === "review" || sid === "plan" ? "Opus" : "gpt-5.6", effort: sid === "review" ? "xhigh" : "high", access: sid === "review" || sid === "plan" ? "read-only" : "read-write", sandbox: sid === "review" ? "restricted" : "full", outputs: [], next: tpl[i + 1] || null, onFail: sid === "review" ? { to: "build", maxRounds: 3 } : null, attempts: [], prompt: "{{task}}" })); F.pipelines.push({ id, project: S.project === "all" ? "atlas" : S.project, task: "New pipeline · name the task", state: "draft", revision: 0, started: null, branch: null, lastEdit: null, cursor: { stageId: stages[0]?.id || "", attempt: 0 }, stages, findings: [], notes: [], checkpoints: [], mutations: [], waiting: null }); go(`#/pipeline/${id}`, { replace: true }); toast("Draft pipeline created", "edit the stages, then Start"); } return; }
    if (kind === "pa") return pipelineAct(a, b, c);
    if (kind === "zoom") { const z = $app.querySelector(".map-tools .zoom"); if (z) z.textContent = a === "fit" ? "fit" : a === "+" ? "125%" : "80%"; return; }
    if (kind === "na" || kind === "ro" || kind === "ed") {
      const target = kind === "na" ? (S.newAgent || (S.newAgent = {})) : kind === "ro" ? (S.rotate || (S.rotate = {})) : (S.editorDraft || (S.editorDraft = {}));
      const key = a; let value = name.slice(kind.length + a.length + 2);
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) value = el.value;
      target[key] = value === "toggle" ? !target[key] : value;
      if (key === "engine") target.model = MODELS[value][0];
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox") return; /* typing: no re-render, keep the caret */
      return render();
    }
  }

  /* ── events ────────────────────────────────────────────────────────────── */
  $app.addEventListener("click", (e) => {
    const t = e.target.closest("[data-go], [data-act], [data-scrim]");
    if (!t) return;
    if (t.hasAttribute("data-scrim") && t === e.target) { closeDialog(); return; }
    if (t.dataset.go) {
      e.preventDefault();
      if (t.dataset.project) { S.project = t.dataset.project; S.view = "list"; }
      const goTo = t.dataset.go;
      if (goTo === "#/board" && S.project === "all") { S.project = t.dataset.project || "atlas"; }
      if (isDialog(hashOf()) && !isDialog(goTo)) history.replaceState({}, "", goTo);
      go(goTo, { trigger: goTo });
      return;
    }
    if (t.dataset.act) { e.preventDefault(); act(t.dataset.act, t); }
  });
  $app.addEventListener("input", (e) => {
    const t = e.target; if (!t.dataset) return;
    if (t.dataset.act === "filter") { S.filter = t.value; S.hl = -1; const pos = t.selectionStart; render(); const f = $app.querySelector('[data-act="filter"]'); if (f) { f.focus(); f.setSelectionRange(pos, pos); } return; }
    if (t.dataset.act === "projFilter") { S.projFilter = t.value; const pos = t.selectionStart; render(); const f = $app.querySelector('[data-act="projFilter"]'); if (f) { f.focus(); f.setSelectionRange(pos, pos); } return; }
    if (t.dataset.act === "search") { S.search = t.value; const pos = t.selectionStart; render(); const f = $app.querySelector('[data-act="search"]'); if (f) { f.focus(); f.setSelectionRange(pos, pos); } return; }
    if (t.dataset.focus === "field" || t.dataset.focus === "pin-field") { const cv = $app.querySelector(t.dataset.focus === "field" ? ".stage .chat" : ".pin .chat"); const id = cv && cv.dataset.conv; if (!id) return; const was = Boolean(S.drafts[id]); S.drafts[id] = t.value; if (was !== Boolean(t.value)) { const pos = t.selectionStart; render(); const f = $app.querySelector(`[data-focus="${t.dataset.focus}"]`); if (f) { f.focus(); f.setSelectionRange(pos, pos); } } return; }
    if (t.dataset.act && /^(na|ro|ed):/.test(t.dataset.act)) act(t.dataset.act, t);
  });
  $app.addEventListener("change", (e) => { const t = e.target; if (t.dataset && t.dataset.act && /^(na|ro|ed):/.test(t.dataset.act) && (t.tagName === "SELECT" || t.type === "checkbox")) act(t.dataset.act, t); });

  const typing = (el) => el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
  function columnRows() { return [...$app.querySelectorAll(".col-body [data-row], .col-body .seat .main")]; }
  document.addEventListener("keydown", (e) => {
    const dlg = $app.querySelector("[data-dialog]");
    if (e.key === "Escape") {
      if (dlg) { e.preventDefault(); closeDialog(); return; }
      if (typing(e.target)) { e.preventDefault(); if (e.target.dataset.act === "filter" && S.filter) { S.filter = ""; render(); } const rows = columnRows(); const cur = rows.find((r) => r.classList.contains("on")); (cur || rows[0] || $app.querySelector('[data-focus="filter"]'))?.focus(); return; }
      return;
    }
    if (dlg && e.key === "Tab") { /* focus trap */
      const f = [...dlg.querySelectorAll("button, input, textarea, select, [tabindex]")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return; const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (dlg && (e.key === "ArrowDown" || e.key === "ArrowUp") && hashOf() === "#/board/search") { e.preventDefault(); const rows = [...dlg.querySelectorAll(".search-rows .mrow")]; const i = rows.indexOf(document.activeElement); const n = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1); rows[n]?.focus(); return; }
    if (typing(e.target)) {
      if (e.target.dataset.focus === "field" || e.target.dataset.focus === "pin-field") { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const slot = $app.querySelector(`[data-focus="${e.target.dataset.focus === "field" ? "send" : "pin-send"}"]`); if (slot && !slot.classList.contains("stop")) act(slot.dataset.act, slot); } return; }
      if (e.target.dataset.act === "filter") { const rows = columnRows(); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); S.hl = e.key === "ArrowDown" ? Math.min(rows.length - 1, S.hl + 1) : Math.max(0, S.hl - 1); rows.forEach((r, i) => r.classList.toggle("on", i === S.hl)); rows[S.hl]?.scrollIntoView({ block: "nearest" }); } else if (e.key === "Enter") { e.preventDefault(); const r = rows[S.hl >= 0 ? S.hl : 0]; if (r) r.click(); } return; }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = columnRows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const i = rows.indexOf(document.activeElement); const n = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1); rows[n]?.focus(); rows[n]?.scrollIntoView({ block: "nearest" }); return; }
    if (e.key === "Enter" && rows.includes(document.activeElement)) { e.preventDefault(); document.activeElement.click(); return; }
    if (e.key === "n" || e.key === "N") { const a = S.project === "all" ? attentionAll() : attention(); if (!a.length) return; e.preventDefault(); const cur = a.findIndex((x) => x.go === hashOf()); S.cycle = cur >= 0 ? cur : S.cycle; S.cycle = ((S.cycle + (e.key === "n" ? 1 : -1)) + a.length) % a.length; const item = a[S.cycle]; if (S.project === "all" && item.project) S.project = item.project; go(item.go); return; }
    if (e.key === "/") { e.preventDefault(); go("#/board/search", { trigger: "#/board/search" }); return; }
    if (e.key === "o") { e.preventDefault(); const sc = seatConv(); go(sc ? "#/chat/orch" : "#/seat/rotate"); return; }
    if (e.key === "m") { e.preventDefault(); act(S.view === "map" ? "view:list" : "view:map"); return; }
    if (e.key === "a") { e.preventDefault(); go("#/accounts"); return; }
    if (e.key === "p") { e.preventDefault(); go("#/pipelines"); return; }
    if (e.key === "t") { e.preventDefault(); go("#/tasks"); return; }
    if (e.key === "c") { e.preventDefault(); go("#/board/create", { trigger: "#/board/create" }); return; }
    if (e.key === "[") { e.preventDefault(); act("rail"); return; }
    if (e.key === "?") { e.preventDefault(); go("#/board/keys", { trigger: "#/board/keys" }); return; }
  });

  /* ── bench and boot ────────────────────────────────────────────────────── */
  const W = { 1280: [1280, 800], 1440: [1440, 900], 1920: [1920, 1080] };
  function applyFrame() {
    const requested = params.get("w");
    const fill = !params.get("bench") && (innerWidth <= 1921 && innerHeight <= 1081);
    let w = requested && W[requested] ? Number(requested) : (fill ? (innerWidth >= 1900 ? 1920 : innerWidth >= 1400 ? 1440 : 1280) : 1440);
    if (fill) { document.body.classList.add("fill"); root.style.setProperty("--frame-w", "100vw"); root.style.setProperty("--frame-h", "100vh"); if (requested && W[requested]) w = Number(requested); }
    else { root.style.setProperty("--frame-w", `${W[w][0]}px`); root.style.setProperty("--frame-h", `${W[w][1]}px`); }
    $app.dataset.w = String(w);
    const sel = document.getElementById("bench-w"); if (sel) sel.value = String(w);
  }
  const scheme = params.get("scheme"); if (scheme === "dark" || scheme === "light") root.dataset.theme = scheme;
  const sSel = document.getElementById("bench-scheme"); if (sSel) { sSel.value = scheme || ""; sSel.onchange = () => { params.set("scheme", sSel.value); if (!sSel.value) params.delete("scheme"); location.search = params.toString(); }; }
  const wSel = document.getElementById("bench-w"); if (wSel) wSel.onchange = () => { params.set("w", wSel.value); location.search = params.toString(); };
  const scSel = document.getElementById("bench-scenario"); if (scSel) { scSel.value = scenario || ""; scSel.onchange = () => { if (scSel.value) params.set("scenario", scSel.value); else params.delete("scenario"); location.search = params.toString(); }; }
  applyFrame();
  if (!location.hash) history.replaceState({}, "", "#/board");
  render();
  window.__proto = { S, F, render, go, act, attention };
})();
