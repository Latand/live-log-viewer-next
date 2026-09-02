/* desktop-v2 prototype (issue #1453) — vanilla JS, no build step.

   One frame: rail (projects) · column (the project's triage list, the seat
   first) · stage (one primary surface: the board, a conversation, a pipeline,
   the seat, accounts, the map, the overview) · an optional pinned pane at
   ≥ 1600 px · a status bar (runtime, accounts, hosts). Dialogs and popovers
   open over the stage and never create history; stage routes push. Every
   action acts on the click and answers with a receipt that carries the
   inverse action. The keyboard map is single keys while nothing is being
   typed (the product's own convention: n, N, /), so a power user never leaves
   the home row; Escape is the bridge out of any text field back to the
   column, which is where the single keys live.

   The shapes are docs/design/desktop-v2/README.md; the vocabulary and the
   state precedence are the mobile-v2 ones (docs/design/mobile-v2/README.md).
   Rework round 1 applies docs/design/desktop-v2/critique.md: the stage graph
   (F1), the accounts rows and the per-account detail (F2), the kanban thread
   (F3), the landing stage that does work (F4), the focus model (F5), one
   derived count (F6), no id twice in the column (F7), sticky sections (F8),
   the editor's sticky footer (F9), attempt history (F10), the map as groups
   that auto-arrange and honour a pin (F11 and operator item 5), and the cheap
   ones F12–F20. */
(function () {
  "use strict";

  const F = window.FIXTURE;
  const SCREENS = window.SCREENS || [];
  const $app = document.getElementById("app");
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const scenario = params.get("scenario");
  if (scenario && window.SCENARIOS && window.SCENARIOS[scenario]) window.SCENARIOS[scenario](F);

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
    board: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/>',
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
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
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
    project: F.project, view: null, rail: null, pin: F.pin || null,
    crowned: new Set(["c1"]), killed: new Set(), closed: new Set(), seen: new Set(), collapsed: new Set(), recentAll: false,
    drafts: {}, next: {}, sound: true, toast: null, toastTimer: null, arrival: null, arrivalTimer: null, arrivalDismissed: false, ticked: false,
    hl: -1, filter: "", search: "", searchScope: "mine", answers: {}, editorDraft: null, archivedProjects: new Set(), deletedProjects: new Set(),
    pickedOption: {}, trigger: null, cycle: -1, openNodes: new Set(), openRounds: new Set(), openGroups: new Set(),
    pins: Object.assign({}, F.pins || {}), drag: null, taskStatus: {}, newRows: new Set(),
  };
  const P = (id) => F.projects.find((p) => p.id === id);
  const conv = (id) => F.conversations.find((c) => c.id === id);
  const pipe = (id) => F.pipelines.find((p) => p.id === id);
  const width = () => Number($app.dataset.w || 1440);
  const canPin = () => width() >= 1600;
  const seatConv = () => F.conversations.find((c) => c.seat && c.project === S.project);
  /* F17: under 1440 the rail starts collapsed to its 64 px icon strip, so the
     column keeps the width the crowded board needs. `[` expands it. */
  const railOpen = () => (S.rail === null ? width() >= 1440 : S.rail);

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
  const lastAttempt = (s) => s.attempts[s.attempts.length - 1] || null;
  const nowFragment = (c) => c.tool ? c.tool : (c.feed || []).slice().reverse().find((m) => m.kind === "agent")?.text.split("\n")[0].slice(0, 60) || "";
  const projectName = (id) => (P(id) || { name: id }).name;
  const arrivedYet = (c) => !c.arrivesLater || Boolean(S.arrival && S.arrival.id === c.id);
  const inScope = (c) => !S.closed.has(c.id) && !c.child && arrivedYet(c) && (S.project === "all" ? !S.deletedProjects.has(c.project) : c.project === S.project);
  const scopedPipes = () => F.pipelines.filter((p) => (S.project === "all" ? !S.deletedProjects.has(p.project) : p.project === S.project) && p.state !== "closed");
  const taskStatus = (t) => S.taskStatus[t.id] || t.status;
  const scopedTasks = () => (S.project === "all" ? F.tasks : F.tasks.filter((t) => {
    const c = t.worker ? conv(t.worker) : null; const p = t.pipeline ? pipe(t.pipeline) : null;
    return (c ? c.project : p ? p.project : "atlas") === S.project;
  }));

  /* The queue: Needs you holds both kinds, in the column's order. */
  function attention() {
    const items = [];
    for (const c of F.conversations) { if (!inScope(c) || c.seat) continue; const b = stateBits(c); if (b.edge) items.push({ kind: "conv", id: c.id, go: `#/chat/${c.id}`, title: c.title, project: c.project, sub: b.phrase, badge: b.badge, tone: b.edge }); }
    for (const p of scopedPipes()) if (p.state === "needs_decision") { const s = stageOf(p); items.push({ kind: "pipe", id: p.id, go: `#/pipeline/${p.id}`, title: p.task, project: p.project, sub: `stage ${stageIndex(p, s)}/${p.stages.length} · ${s.id} failed · ${p.findings.length} findings`, badge: "needs a decision", tone: "warn" }); }
    return items;
  }
  const inProject = (id) => { const keep = S.project; S.project = id; const out = { need: attention(), work: working(), pipes: scopedPipes().filter((p) => p.state !== "completed" && p.state !== "closed") }; S.project = keep; return out; };
  const attentionAll = () => { const keep = S.project; S.project = "all"; const a = attention(); S.project = keep; return a; };
  function working() { return F.conversations.filter((c) => inScope(c) && !c.seat && ["working", "held"].includes(stateBits(c).key)); }
  /* F6: one function, used by the rail row, the column header and the
     overview card, so the three can never print different numbers. The seat
     is not counted as working — the seat card shows itself. */
  function counts(id) { const { need, work, pipes } = inProject(id); return { needs: need.length, working: work.length, pipelines: pipes.length }; }
  /* F8: one line at every width. Under 1920 the pipelines count drops — the
     Pipelines section header carries it, and the two numbers that matter stay
     the ones the rail row and the overview card print (F6). */
  const countPhrase = (c, w) => `<b>${c.needs}</b> need you${w <= 1280 ? "" : ` · ${c.working} working`}`;

  /* ── route ─────────────────────────────────────────────────────────────── */
  const hashOf = () => (location.hash || "#/board").split("?")[0];
  const segs = () => hashOf().slice(2).split("/").filter(Boolean);
  const DIALOG_TAIL = /\/(menu|model|details|create|search|host|keys|new-agent|new-pipeline|rotate|switch|task)$/;
  const isDialog = (h) => DIALOG_TAIL.test(h) || /\/add\/\d+$/.test(h);
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
  const closeDialog = () => { const h = hashOf(); const base = h.replace(DIALOG_TAIL, "").replace(/\/add\/\d+$/, ""); history.replaceState({}, "", base || "#/board"); render(); refocusTrigger(); };
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
  const meterCls = (left) => left <= 10 ? "dng" : left <= 30 ? "warn" : "";
  const meter = (left, label) => `<span class="meter ${meterCls(left)}" title="${esc(label || "")}"><i style="width:${Math.max(2, left)}%"></i></span>`;
  const projectChip = (id) => S.project === "all" ? `<span class="pj">${esc(projectName(id))}</span>` : "";
  const VERDICT = { passed: "ok", failed: "fail", running: "run", skipped: "skip", pending: "" };
  /* Verdict pips: one per attempt, coloured by how that attempt ended. */
  const attemptPips = (s) => s.attempts.length ? `<span class="pips" aria-label="${s.attempts.length} attempt${s.attempts.length > 1 ? "s" : ""}">${s.attempts.map((a) => `<i class="${VERDICT[a.state] || ""}"></i>`).join("")}</span>` : "";
  /* Round pips: the fail-edge budget, filled for every round already spent. */
  const roundsUsed = (p, s) => s.onFail ? Math.max(0, s.attempts.filter((a) => a.state === "failed").length) : 0;
  const roundPips = (used, max) => `<span class="pips">${Array.from({ length: max }, (_, i) => `<i class="round ${i < used ? "used" : ""}"></i>`).join("")}</span>`;

  function convRow(c, opts) {
    const b = stateBits(c);
    const cur = hashOf() === `#/chat/${c.id}` || (hashOf() === "#/seat" && c.seat);
    const meta = b.key === "working"
      ? `<span class="st ok">${esc(b.phrase)}</span>${nowFragment(c) ? `<span class="rest">${esc(nowFragment(c))}</span>` : ""}`
      : `<span class="st ${b.tone === "neu" ? "" : b.tone}">${esc(b.key === "waiting" ? `waiting ${c.waitedFor}` : b.phrase)}</span>`;
    const stage = c.pipeline ? `<span>stage ${c.pipeline.k}/${c.pipeline.n}</span>` : "";
    return `<button class="row ${b.edge ? `wait ${b.edge === "dng" ? "dng" : ""}` : ""} ${cur ? "on" : ""} ${opts?.quiet ? "quiet" : ""} ${S.newRows.has(c.id) ? "new" : ""}" data-go="#/chat/${c.id}" data-row aria-current="${cur ? "true" : "false"}">
      <span class="dot ${b.dot} ${b.key === "working" && cur ? "pulse" : ""}"></span>
      <span style="min-width:0"><span class="t ${b.edge ? "two" : "trunc"}">${esc(c.title)}</span><span class="m meta">${meta}<span>${mark(c.engine)}${esc(c.model)}</span>${stage}</span></span>
      <span class="r">${projectChip(c.project)}${b.badge ? badge(b.badge, b.edge === "dng" ? "dng" : "warn") : (S.crowned.has(c.id) ? `<svg class="i crown" viewBox="0 0 24 24" aria-hidden="true">${ICONS.crown}</svg>` : I("chevR"))}</span>
    </button>`;
  }
  /* F7: a pipeline row folds its live attempt underneath as a child row, so
     the record and the conversation doing its work read as one thread here
     too — and neither is listed twice anywhere in the column. */
  function attemptChildRow(p, rendered) {
    const s = stageOf(p); const a = lastAttempt(s); const c = a && a.conv ? conv(a.conv) : null;
    if (!c || S.closed.has(c.id)) return "";
    if (rendered) { if (rendered.has(c.id)) return ""; rendered.add(c.id); }
    const b = stateBits(c); const cur = hashOf() === `#/chat/${c.id}`;
    return `<button class="row child ${cur ? "on" : ""}" data-go="#/chat/${c.id}" data-row data-child="${p.id}" aria-current="${cur ? "true" : "false"}">
      <span class="tie" aria-hidden="true"></span>
      <span style="min-width:0"><span class="t trunc">${stageIndex(p, s)}/${p.stages.length} ${esc(s.id)} · ${esc(s.role)}</span><span class="m meta"><span class="st ${b.tone === "neu" ? "" : b.tone}">${esc(b.key === "waiting" ? `a question · ${c.waitedFor}` : b.phrase)}</span><span>${mark(c.engine)}${esc(c.model)}</span></span></span>
      <span class="r">${I("chevR")}</span></button>`;
  }
  function pipeRow(p, rendered, opts) {
    const b = pipeBits(p); const s = stageOf(p); const cur = hashOf().startsWith(`#/pipeline/${p.id}`);
    const need = p.state === "needs_decision";
    const row = `<button class="row ${need ? "wait" : ""} ${cur ? "on" : ""}" data-go="#/pipeline/${p.id}" data-row aria-current="${cur ? "true" : "false"}">
      <span class="dot ${b.cls === "acc" ? "acc" : b.cls === "ok" ? "ok" : ""} ${p.state === "running" && cur ? "pulse" : ""}"></span>
      <span style="min-width:0"><span class="t ${need ? "two" : "trunc"}">${esc(p.task)}</span><span class="m meta"><span>${p.state === "draft" ? `${p.stages.length} stages · not started` : `stage ${stageIndex(p, s)}/${p.stages.length} · ${esc(s.id)}`}</span>${need ? `<span>${p.findings.length} findings</span>` : p.state === "running" ? `<span class="st acc">${esc(b.phrase)} ${esc(p.started)}</span>` : ""}${p.stages.some((x) => x.pendingEdit) ? `<span class="st acc">edit pending</span>` : ""}</span></span>
      <span class="r">${projectChip(p.project)}${need ? badge("needs a decision", "warn") : badge(b.badge, b.cls)}</span>
    </button>`;
    return row + (opts?.noChild ? "" : attemptChildRow(p, rendered));
  }

  /* ── rail ──────────────────────────────────────────────────────────────── */
  function rail() {
    const q = S.projFilter || "";
    const rows = F.projects.filter((p) => !p.archived && !S.archivedProjects.has(p.id) && !S.deletedProjects.has(p.id) && (!q || p.name.includes(q)));
    const crowned = rows.filter((p) => p.crowned); const rest = rows.filter((p) => !p.crowned);
    const archived = F.projects.filter((p) => (p.archived || S.archivedProjects.has(p.id)) && !S.deletedProjects.has(p.id));
    const prow = (p) => { const n = counts(p.id); return `<button class="prow ${S.project === p.id ? "on" : ""} ${n.needs + n.working === 0 ? "quiet" : ""}" data-go="#/board" data-project="${p.id}" title="${esc(p.name)}">
        <span class="ini">${esc(p.name.slice(0, 2))}${n.needs ? `<b>${n.needs}</b>` : ""}</span>
        <span class="dot ${n.needs ? "warn" : n.working ? "ok" : ""}"></span>
        <span class="n"><span class="trunc">${esc(p.name)}</span><small class="${S.ticked && p.id === S.project ? "tick" : ""}">${n.needs ? `<b>${n.needs} need you</b> · ` : ""}${n.working ? `${n.working} working` : `quiet · ${esc(p.age)}`}</small></span>
        <span class="cnt">${p.crowned ? `<svg class="i sm crown" viewBox="0 0 24 24" aria-hidden="true">${ICONS.crown}</svg>` : ""}${n.needs ? badge(String(n.needs), "warn") : ""}</span>
      </button>`; };
    return `<aside class="rail">
      <div class="rail-head"><span class="app">Agent Log Viewer</span><button class="iconbtn" data-act="rail" aria-label="${railOpen() ? "Collapse the project rail" : "Expand the project rail"}" title="${railOpen() ? "Collapse" : "Expand"} ([)">${I(railOpen() ? "chevL" : "chevR")}</button></div>
      <div class="rail-search"><input class="field" placeholder="Filter projects…" value="${esc(q)}" data-act="projFilter" aria-label="Filter projects"></div>
      <nav class="rail-list" aria-label="Projects">
        <button class="prow ${S.project === "all" ? "on" : ""}" data-go="#/overview"><span class="ini">All</span>${I("grid")}<span class="n">Overview<small>${attentionAll().length} need you across ${F.projects.filter((p) => !p.archived).length} projects</small></span></button>
        ${crowned.length ? `<h2>Crowned</h2>${crowned.map(prow).join("")}` : ""}
        <h2>Projects</h2>${rest.map(prow).join("")}
        ${archived.length ? `<button class="sec-h" data-act="toggle:archive" aria-expanded="${S.collapsed.has("archive") ? "false" : "true"}"><span>Archive</span><span class="c">· ${archived.length}</span>${I("chevD")}</button>${S.collapsed.has("archive") ? "" : archived.map((p) => `<button class="prow quiet" data-go="#/board" data-project="${p.id}"><span class="ini">${esc(p.name.slice(0, 2))}</span><span class="dot"></span><span class="n"><span class="trunc">${esc(p.name)}</span><small>archived · ${esc(p.age)}</small></span></button>`).join("")}` : ""}
      </nav>
      <div class="rail-foot"><button class="btn quiet" data-act="createProject" style="width:100%;justify-content:flex-start">${I("plus")}<span>Create project</span></button></div>
    </aside>`;
  }

  /* ── column ────────────────────────────────────────────────────────────── */
  function seatCard() {
    if (S.project === "all") return "";
    const c = seatConv();
    /* The filter narrows the whole column, the seat included. */
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
    const need = attention().filter((a) => match(a.title));
    const pipes = scopedPipes().filter((p) => match(p.task));
    const parked = new Set(need.filter((a) => a.kind === "pipe").map((a) => a.id));
    const active = pipes.filter((p) => p.state !== "completed" && !parked.has(p.id));
    const completed = pipes.filter((p) => p.state === "completed" && !parked.has(p.id));
    /* F7: every id renders once, in the column's order — Needs you wins, then
       the pipelines with their live attempt folded under them, then Working,
       then Recent. */
    const rendered = new Set();
    const needRows = need.map((a) => { rendered.add(a.id); return a.kind === "conv" ? convRow(conv(a.id)) : pipeRow(pipe(a.id), rendered); }).join("")
      || `<div class="quietline">Nothing needs you.</div>`;
    const activeRows = active.map((p) => { rendered.add(p.id); return pipeRow(p, rendered); }).join("");
    const completedRows = completed.map((p) => { rendered.add(p.id); return pipeRow(p, rendered, { noChild: true }); }).join("");
    const convs = F.conversations.filter((c) => inScope(c) && !c.seat && match(c.title) && !rendered.has(c.id));
    const work = convs.filter((c) => ["working", "held"].includes(stateBits(c).key));
    const recent = convs.filter((c) => ["returned", "done", "killed"].includes(stateBits(c).key));
    /* F8: on a column longer than one screen Recent starts folded, so every
       section header is reachable without scrolling past the queue. */
    if (need.length + active.length + work.length > 12 && !S.recentTouched) S.collapsed.add("recent");
    const recentRows = (S.recentAll || q ? recent : recent.slice(0, 5)).map((c) => convRow(c, { quiet: true })).join("");
    const more = !S.recentAll && !q && recent.length > 5 ? `<button class="more" data-act="recentAll">All conversations · ${recent.length} ${I("chevR", "sm")}</button>` : "";
    const title = S.project === "all" ? "All projects" : projectName(S.project);
    const n = S.project === "all" ? { needs: need.length, working: work.length, pipelines: active.length } : counts(S.project);
    const view = effectiveView();
    const seg = (id, icon, label) => `<button class="${view === id ? "on" : ""}" data-act="view:${id}" aria-pressed="${view === id}" title="${label}" aria-label="${label}">${I(icon, "sm")}</button>`;
    return `<section class="col" aria-label="Board">
      <div class="col-head"><h1><span class="trunc">${esc(title)}</span><small class="${S.ticked ? "tick" : ""}">${countPhrase(n, width())}</small></h1>
        <div class="seg" role="group" aria-label="View">${seg("kanban", "board", "Board (k)")}${seg("list", "list", "List")}${seg("map", "map", "Map (m)")}</div>
        <button class="iconbtn" data-go="#/board/create" aria-label="Create: conversation, task, pipeline" title="Create (c)">${I("plus")}</button>
        <button class="iconbtn" data-go="#/board/menu" aria-label="More" title="More">${I("more")}</button></div>
      <div class="col-filter"><input class="field" placeholder="Filter · ↑ ↓ Enter" value="${esc(S.filter)}" data-act="filter" data-focus="filter" aria-label="Filter conversations and pipelines"></div>
      <div class="col-body">
        ${seatCard()}
        ${section("needs", "Needs you", needRows, need.length)}
        ${section("pipelines", "Pipelines", activeRows, active.length, completed.length ? `<button class="more quiet" data-act="toggle:completed">${S.collapsed.has("completed") ? "Show" : "Hide"} ${completed.length} completed</button>${S.collapsed.has("completed") ? "" : completedRows}` : "")}
        ${section("working", "Working", work.map((c) => convRow(c)).join(""), work.length)}
        ${section("recent", "Recent", recentRows, recent.length, more)}
      </div>
    </section>`;
  }

  /* ── stage: banner ─────────────────────────────────────────────────────── */
  function banner() {
    if (F.runtime === "offline") return `<div class="banner info" data-banner="offline">${I("wifiOff")}<span class="txt"><b>Offline · reconnecting</b>Showing the last state received · 14:02</span></div>`;
    if (F.runtime === "degraded") return `<div class="banner info" data-banner="degraded">${I("info")}<span class="txt"><b>Runtime degraded · polling</b>Updates arrive every 10 s</span></div>`;
    /* F20: an arrival in the CURRENT project is never a banner — it is a new
       row with its edge, and one tick of the counts. */
    if (S.arrival && !S.arrivalDismissed && !S.seen.has(S.arrival.id) && conv(S.arrival.id) && conv(S.arrival.id).project !== S.project && hashOf() !== `#/chat/${S.arrival.id}`) {
      const c = conv(S.arrival.id); const b = stateBits(c);
      return `<div class="banner" data-banner="arrival">${I("alert")}<button class="open" data-act="openArrival"><b>Needs you · ${esc(b.badge || "a question")} · ${esc(projectName(c.project))}</b><span class="trunc">${esc(c.title)}</span></button><button class="iconbtn" data-act="dismissArrival" aria-label="Dismiss">${I("x")}</button></div>`;
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
      if (a) out.push(`<div class="mu"><div class="bubble">${esc(a)}</div></div><button class="qf" data-act="toggleQ:${c.id}">${I("chevR")}<span>question · answered ${esc(F.now)}</span></button>${S.pickedOption[c.id + ":open"] ? questionCard(c, true) : ""}`);
      else out.push(questionCard(c, false));
    }
    return out.join("");
  }
  /* F5: the options carry their number, because 1–9 pick them from the home
     row while the card is open. */
  function questionCard(c, quiet) {
    const q = c.question; const picked = S.answers[c.id];
    return `<div class="q ${quiet ? "quiet" : ""}" data-question="${c.id}"><div class="qh">${I("alert", "sm")}Needs you · ${esc(c.waitedFor)}</div><div class="qt">${esc(q.text)}</div>${q.options.map((o, i) => `<button class="opt ${picked === o.label ? "on" : ""}" data-act="${quiet ? "noop" : `answer:${c.id}:${i}`}" data-opt="${i}"><span class="rad"></span><span class="k kbd">${i + 1}</span><span><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ""}</span></button>`).join("")}${quiet ? "" : `<div class="own">Or type your own answer below — it is sent as the reply.</div>`}</div>`;
  }
  function composer(c, focusPrefix) {
    const b = stateBits(c); const draft = S.drafts[c.id] || ""; const nx = S.next[c.id] || { model: c.model, effort: c.effort, account: c.account };
    const fp = focusPrefix || "";
    let slot;
    if (F.runtime === "offline") slot = `<button class="send queue" data-act="queue:${c.id}" data-focus="${fp}send"><span class="cap">Queue</span></button>`;
    else if (b.key === "killed") slot = `<button class="send respawn" data-act="respawn:${c.id}" data-focus="${fp}send"><span class="cap">${I("refresh", "sm")}Respawn</span></button>`;
    else if (b.key === "working" && !draft) slot = `<button class="send stop" data-act="stop:${c.id}" data-focus="${fp}send" aria-label="Stop the agent"><span class="cap">${I("square", "sm")}Stop</span></button>`;
    else slot = `<button class="send ${draft ? "" : "off"}" data-act="send:${c.id}" data-focus="${fp}send" aria-label="Send"><span class="cap">${I("arrowUp", "sm")}</span></button>`;
    /* F15: the hint lives in the placeholder, not as a permanent row. */
    const placeholder = b.key === "killed" ? "killed · text queues until a respawn" : b.key === "held" ? "held · text you send queues" : F.runtime === "offline" ? "offline · held until reconnected" : c.question && !S.answers[c.id] ? "Your own answer… · Enter sends" : c.seat ? "Tell the orchestrator… · Enter sends" : "Message the agent… · Enter sends";
    const chipText = b.key === "limit" ? `${nx.model} · ${c.account} at limit` : `${nx.model} · ${nx.effort}`;
    return `<div class="box"><textarea data-focus="${fp}field" placeholder="${esc(placeholder)}" aria-label="Message" rows="2">${esc(draft)}</textarea>
      <div class="tools"><button class="chipbtn" data-go="#/chat/${c.id}/model" data-focus="${fp}chip" aria-label="Next message: model, reasoning, account"><span class="chip ${b.key === "limit" ? "warn" : ""}">${mark(c.engine)}${esc(chipText)}${I("chevD", "sm")}</span></button>
      <button class="iconbtn" data-act="attach" data-focus="${fp}attach" aria-label="Attach files or images">${I("clip")}</button><button class="iconbtn" data-act="dictate" data-focus="${fp}mic" aria-label="Dictate">${I("mic")}</button>
      <span class="sp"></span>${slot}</div></div>`;
  }
  function chatHead(c, pinned) {
    const b = stateBits(c);
    const p = c.pipeline ? pipe(c.pipeline.id) : null;
    const task = F.tasks.find((t) => t.worker === c.id);
    const stage = p ? `<span>stage ${c.pipeline.k}/${c.pipeline.n}</span>` : "";
    return `<div class="chat-head"><span class="dot ${b.dot} ${b.key === "working" ? "pulse" : ""}"></span><div class="tt"><div class="t trunc">${esc(c.title)}</div><div class="sub meta"><span class="st ${b.tone === "neu" ? "" : b.tone}">${esc(b.phrase)}</span><span>${mark(c.engine)}${esc(c.model)}</span><span>${esc(c.effort)}</span>${stage}${task ? `<span>task · ${esc(task.title)}</span>` : ""}${c.worktree ? `<span class="mono">${esc(c.worktree)}</span>` : ""}</div></div>
      ${pinned ? `<button class="iconbtn" data-go="#/chat/${c.id}/menu" aria-label="Conversation actions" title="More">${I("more")}</button><button class="iconbtn" data-act="unpin" aria-label="Unpin">${I("x")}</button>` : `${canPin() && !S.pin ? `<button class="iconbtn" data-act="pin:${c.id}" aria-label="Pin beside" title="Pin beside">${I("panel")}</button>` : ""}${c.seat ? `<button class="iconbtn ${hashOf() === "#/seat" ? "on" : ""}" data-go="#/seat" aria-label="Orchestrator seat" title="Seat">${I("sliders")}</button>` : ""}<button class="iconbtn" data-go="#/chat/${c.id}/menu" aria-label="Conversation actions" title="More">${I("more")}</button>`}</div>`;
  }
  function chatView(c, opts) {
    const pinned = opts?.pinned; const fp = pinned ? "pin-" : "";
    const members = c.children && c.children.length ? `<div class="members">${I("branch", "sm")}<span>${c.children.length} members ·</span>${c.children.map((k) => `<span class="badge ${k.state === "working" ? "ok" : ""}">${esc(k.title)}</span>`).join("")}</div>` : "";
    const chips = c.question && !S.answers[c.id] && !pinned ? `<div class="chips">${c.question.chips.map((t) => `<button data-act="answerText:${c.id}:${esc(t)}"><span class="chip">${esc(t)}</span></button>`).join("")}</div>` : "";
    return `<div class="chat" data-conv="${c.id}">${chatHead(c, pinned)}${opts?.seatPanel ? seatPanel() : ""}${members}<div class="feed"><div class="inner">${feedHtml(c)}</div></div>${chips}${pinned ? "" : toastHtml()}${composer(c, fp)}</div>`;
  }
  /* F13: three faded lines of the mandate with an inline Edit; Rotate is the
     secondary action beside it, never the primary button on the screen. */
  function seatPanel() {
    const s = F.seat; const c = seatConv();
    const rot = s.ctx.left <= 30 ? `<div class="warnline">${I("alert", "sm")} Rotation recommended · ${s.ctx.left}% of the window left</div>` : "";
    return `<div class="seatpanel" data-seatpanel><div class="id">${mark(s.engine, "fill")}<span class="t">${esc(s.model)} · ${esc(s.effort)}<small>${esc(s.account)} · ${esc(s.plan)} · holding the seat for ${esc(s.since)}${s.predecessor ? " · predecessor" : ""}</small></span></div>
      <div class="ctx">${meter(s.ctx.left)}<span class="tn">${s.ctx.left}% left of ${esc(s.ctx.window)}</span>${s.predecessor ? `<button class="btn link" data-act="predecessor">Predecessor · open ›</button>` : ""}</div>
      <div class="mand"><div class="mh"><span>Mandate v${s.mandateVersion}</span><button class="btn link" data-go="#/seat/rotate">Edit ›</button></div><div class="txt three">${esc(s.mandate)}</div></div>${rot}
      <div class="sbtns"><button class="btn" data-go="#/seat/rotate">${I("pencil", "sm")}Edit the mandate</button><button class="btn" data-go="#/seat/rotate" data-orchestrator-rotate>${I("rotate", "sm")}Rotate</button><span class="muted" style="font-size:var(--text-label);max-width:190px;line-height:1.35">Changing the mandate, model or account means a successor.</span></div></div>`;
  }

  /* ── stage: the pipeline graph — the one memorable element ─────────────── */
  const ROLES = ["architect", "builder", "reviewer", "auditor"]; const MODELS = { claude: ["Opus", "Sonnet", "Haiku"], codex: ["gpt-5.6", "gpt-5.5"] }; const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

  /* One stage node: role as the title, the engine mark, model · reasoning,
     access, verdict pips, and its attempts as an expandable list (F1, F10). */
  function stageNode(p, s, i, row, sel) {
    const cur = p.cursor.stageId === s.id && p.state !== "draft" && p.state !== "completed";
    const on = sel === s.id;
    const open = S.openNodes.has(`${p.id}:${s.id}`) || on;
    const last = lastAttempt(s);
    const att = last ? `${s.attempts.length} attempt${s.attempts.length > 1 ? "s" : ""} · ${last.state}` : "not started";
    const rounds = s.onFail ? `<span>${roundsUsed(p, s)} of ${s.onFail.maxRounds} rounds</span>` : "";
    const attempts = open && s.attempts.length ? `<div class="natt">${s.attempts.map((a) => `<button class="att" data-go="${a.conv ? `#/chat/${a.conv}` : `#/pipeline/${p.id}/stage/${s.id}`}" data-attempt="${s.id}:${a.n}"><span class="a">attempt ${a.n}</span><span class="meta"><span class="st ${a.state === "passed" ? "ok" : a.state === "failed" ? "dng" : a.state === "running" ? "acc" : ""}">${esc(a.state)}</span>${a.head ? `<span class="sha mono">${esc(a.head)}</span>` : ""}${a.findings && a.findings.length ? `<span>${a.findings.length} findings</span>` : ""}</span>${a.conv ? `<span class="open">open ›</span>` : badge("no conversation")}</button>`).join("")}</div>` : "";
    return `<div class="node ${cur ? "cur" : ""} ${on ? "on" : ""}" data-node="${s.id}" style="grid-row:${row}">
      <button class="nhead" data-go="#/pipeline/${p.id}/stage/${s.id}" data-stage="${s.id}" aria-expanded="${open}">
        <span class="l1"><span class="k tn">${i + 1}/${p.stages.length}</span><span class="role">${esc(s.role)}<small>${esc(s.id)}</small></span>${attemptPips(s)}${last ? badge(last.state, ({ passed: "ok", failed: "dng", running: "acc", skipped: "" })[last.state] || "") : badge("not started")}</span>
        <span class="l2 meta"><span>${mark(s.engine)}${esc(s.model)}</span><span>${esc(s.effort)}</span><span>${esc(s.access)}</span><span>${esc(att)}</span>${rounds}${s.pendingEdit ? `<span class="pend">edit pending · applies from attempt ${s.attempts.length + 1}</span>` : ""}${s.notes && s.notes.length ? `<span class="pend">${s.notes.length} note${s.notes.length > 1 ? "" : ""} for the next attempt</span>` : ""}</span>
      </button>${attempts}</div>`;
  }
  /* The spine segment beside one row: a 2 px track, and on a node row the
     station whose fill is that stage's last verdict. */
  function laneHtml(row, opts) {
    const st = opts.station ? `<span class="station ${opts.station} ${opts.cur ? "cur" : ""}"></span>` : "";
    return `<div class="lane" style="grid-row:${row}"><span class="track ${opts.track || ""}"></span>${st}</div>`;
  }
  function graph(p, sel) {
    const rows = [];
    const n = p.stages.length;
    const nodeRow = (i) => i * 2 + 1;
    const seamRow = (i) => i * 2 + 2;
    p.stages.forEach((s, i) => {
      const last = lastAttempt(s);
      const reached = s.attempts.length > 0;
      const station = last ? VERDICT[last.state] || "" : "";
      const cur = p.cursor.stageId === s.id && p.state !== "draft";
      rows.push(laneHtml(nodeRow(i), { station, cur, track: reached ? "on" : "dash" }));
      rows.push(stageNode(p, s, i, nodeRow(i), sel));
      const nextStage = s.next ? p.stages.find((x) => x.id === s.next) : null;
      const nextIndex = nextStage ? p.stages.indexOf(nextStage) : -1;
      const passLabel = !s.next ? "end of the pipeline" : nextIndex === i + 1 ? `pass → ${s.next}` : `pass → ${s.next} ${nextIndex < i ? "↑" : "↓"}`;
      rows.push(laneHtml(seamRow(i), { track: reached && nextStage && nextStage.attempts.length ? "on" : "dash" }));
      rows.push(`<div class="seam" style="grid-row:${seamRow(i)}"><span class="elabel ${reached ? "on" : ""}">${esc(passLabel)}</span><button class="iconbtn addstage" data-go="#/pipeline/${p.id}/add/${i + 1}" aria-label="Add a stage after ${esc(s.id)}" title="Add a stage here">${I("plusCircle", "sm")}</button></div>`);
    });
    /* Fail edges as real loops in the right gutter, with the round budget on
       the loop itself. `up` puts the arrowhead at the top when the target is
       above the source. */
    p.stages.forEach((s, i) => {
      if (!s.onFail) return;
      const target = p.stages.find((x) => x.id === s.onFail.to);
      if (!target) return;
      const j = p.stages.indexOf(target);
      const from = nodeRow(i); const to = nodeRow(j);
      const used = roundsUsed(p, s);
      const idle = used === 0;
      const a = Math.min(from, to); const b = Math.max(from, to);
      rows.push(`<div class="loop ${idle ? "idle" : ""} ${to < from ? "up" : ""} " style="grid-row:${a} / ${b + 1}" aria-hidden="true"><span class="ll">↺ ${esc(s.onFail.to)}${roundPips(used, s.onFail.maxRounds)}</span></div>`);
    });
    const note = `<div class="graph-note">The line is the pass path; a loop is a fail edge with its round budget.</div>`;
    return `<div class="graph" data-graph="${p.id}" style="grid-template-rows:repeat(${n * 2}, auto)">${rows.join("")}</div>${note}`;
  }
  /* At 1280 with the editor open the graph folds to a one-line ladder above
     it, so the edited stage is never off-screen (F1, F9). */
  function ladder(p, sel) {
    return `<div class="ladder" aria-label="Stages">${p.stages.map((s, i) => {
      const last = lastAttempt(s);
      return `<button class="${sel === s.id ? "on" : ""}" data-go="#/pipeline/${p.id}/stage/${s.id}"><span class="k">${i + 1}/${p.stages.length}</span>${esc(s.id)}${last ? `<span class="pips"><i class="${VERDICT[last.state] || ""}"></i></span>` : ""}</button>`;
    }).join("")}</div>`;
  }

  function segHtml(name, options, value, act) { return `<div class="seg" role="group" aria-label="${esc(name)}">${options.map((o) => `<button class="${o === value ? "on" : ""}" data-act="${act}:${esc(o)}" aria-pressed="${o === value}">${esc(o)}</button>`).join("")}</div>`; }
  const selHtml = (name, opts, value, act, allowNone) => `<select class="field" data-act="${act}" aria-label="${esc(name)}">${allowNone ? `<option value="" ${value ? "" : "selected"}>none</option>` : ""}${opts.map((o) => `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;

  /* F9: the editor is a bounded pane with its own scroller and a footer that
     is always on screen — Save, Restart and Cancel never fall below the fold,
     and the graph beside it never disappears. */
  const egrp = (key, label, inner) => {
    const open = S.openGroups.has(key);
    return `<div class="edetails"><button class="esum" data-act="egrp:${esc(key)}" aria-expanded="${open}">${esc(label)}${I("chevD", "sm")}</button>${open ? `<div class="egrp">${inner()}</div>` : ""}</div>`;
  };
  function editorShell(title, badgeHtml, closeGo, body, foot) {
    return `<div class="editor" data-editor="${esc(title.key)}"><h3>${I(title.icon, "sm")}${esc(title.text)}${badgeHtml}<button class="iconbtn" data-go="${closeGo}" aria-label="Close the editor">${I("x")}</button></h3><div class="ebody">${body}</div><div class="foot">${foot}</div></div>`;
  }
  function accountRows(engine, chosen, act) {
    return `<div class="accrows">${F.accounts[engine].map((a) => {
      const low = a.windows.length ? Math.min(...a.windows.map((w) => w.left)) : null;
      return `<button class="arow compact ${chosen === a.id ? "on" : ""}" data-act="${a.auth === "Authenticated" ? `${act}:${a.id}` : `signIn:${engine}:${a.id}`}"><span class="dot ${a.auth === "Authenticated" ? "ok" : ""}"></span><span class="t">${esc(a.label)}<small>${esc(a.plan)}${low !== null ? ` · ${low}% left` : ""}</small></span>${a.auth === "Authenticated" ? (chosen === a.id ? badge("chosen", "acc") : badge("ready", "ok")) : `<span class="signin">sign in →</span>`}</button>`;
    }).join("")}</div>`;
  }
  function stageEditor(p, s) {
    const d = S.editorDraft && S.editorDraft.stage === s.id && S.editorDraft.pipeline === p.id ? S.editorDraft : (S.editorDraft = { pipeline: p.id, stage: s.id, role: s.role, engine: s.engine, model: s.model, effort: s.effort, access: s.access, sandbox: s.sandbox, outputs: s.outputs.join(", "), account: "cl-main", prompt: s.prompt, passTo: s.next || "", failTo: s.onFail ? s.onFail.to : "", maxRounds: s.onFail ? s.onFail.maxRounds : 3, note: "", rerunFrom: "worktree", stopCurrent: false });
    const running = s.attempts.some((a) => a.state === "running" || a.state === "pending");
    const nextAttempt = s.attempts.length + 1;
    const others = p.stages.filter((x) => x.id !== s.id).map((x) => x.id);
    const closed = p.state === "closed";
    const body = `
      <div class="rowf"><label>Role ${segHtml("Role", ROLES, d.role, "ed:role")}</label><label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "ed:engine")}</label></div>
      <div class="rowf"><label>Model ${segHtml("Model", MODELS[d.engine], d.model, "ed:model")}</label><label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "ed:effort")}</label></div>
      <div class="rowf"><label>Access ${segHtml("Access", ["read-write", "read-only"], d.access, "ed:access")}</label><label>Sandbox ${segHtml("Sandbox", ["full", "restricted"], d.sandbox, "ed:sandbox")}</label></div>
      ${d.access === "read-only" ? `<label>Declared outputs <input class="field mono" value="${esc(d.outputs)}" data-act="ed:outputs" placeholder="paths this stage may write"></label>` : ""}
      <label>Account</label>${accountRows(d.engine, d.account, "ed:account")}
      <label>Prompt <textarea class="field" data-act="ed:prompt">${esc(d.prompt)}</textarea></label>
      ${egrp(`${p.id}:${s.id}:edges`, "Edges", () => `<div class="rowf"><span class="muted" style="width:44px">pass →</span>${selHtml("Pass edge", others, d.passTo, "ed:passTo", true)}</div><div class="rowf"><span class="muted" style="width:44px">fail ↺</span>${selHtml("Fail edge", others, d.failTo, "ed:failTo", true)}<input class="field num tn" type="number" min="0" max="20" value="${d.maxRounds}" data-act="ed:maxRounds" aria-label="Max rounds"></div><div class="note">Round budgets derive from activation records; lowering below the used count parks the next fail verdict. A traversed edge may still be rewired.</div><div class="btns"><button class="btn" data-act="pa:setEdge:${p.id}:${s.id}" ${closed ? "disabled" : ""}>Save edges</button></div>`)}
      ${egrp(`${p.id}:${s.id}:note`, `Note for attempt ${nextAttempt}`, () => `<textarea class="field" style="min-height:56px" data-act="ed:note" placeholder="Rendered into the prompt of attempt ${nextAttempt} as a titled block">${esc(d.note)}</textarea><div class="btns"><button class="btn" data-act="pa:note:${p.id}:${s.id}" ${closed ? "disabled" : ""}>Add note</button></div>`)}
      ${egrp(`${p.id}:${s.id}:rerun`, "Re-run this stage", () => `<div class="rowf">${segHtml("From", ["worktree", "last-passed", "checkpoint"], d.rerunFrom, "ed:rerunFrom")}</div>${d.rerunFrom === "checkpoint" ? selHtml("Checkpoint", p.checkpoints.map((c) => c.name), p.checkpoints[0]?.name, "ed:checkpoint") : ""}${running ? `<button class="check" data-act="ed:stopCurrent:toggle" aria-pressed="${d.stopCurrent ? "true" : "false"}"><span class="bx">${d.stopCurrent ? I("check", "sm") : ""}</span>Stop attempt ${s.attempts.length} first</button>` : ""}<div class="note ${running && !d.stopCurrent ? "warn" : ""}">${running && !d.stopCurrent ? `Refused while attempt ${s.attempts.length} is unsettled — tick «Stop attempt first» to re-run now.` : p.state === "completed" ? "Reopens the completed pipeline at this stage." : `Creates attempt ${nextAttempt} from the ${d.rerunFrom === "worktree" ? "current worktree, no reset" : d.rerunFrom === "last-passed" ? "last passed commit (resets the worktree)" : "named checkpoint (resets the worktree)"}.`}</div><div class="btns"><button class="btn ${running && !d.stopCurrent ? "" : "primary"}" data-act="pa:rerun:${p.id}:${s.id}" ${closed || (running && !d.stopCurrent) ? "disabled" : ""}>Re-run · attempt ${nextAttempt}</button></div>`)}
      ${egrp(`${p.id}:${s.id}:remove`, "Remove this stage", () => s.attempts.length ? `<div class="note">This stage has attempts, so it stays as history. Route around it with the edges above.</div>` : `<div class="btns"><button class="btn danger" data-act="pa:removeStage:${p.id}:${s.id}">Remove stage</button></div>`)}`;
    const note = closed ? "Archived pipelines are read-only; restore it to edit."
      : running ? `Attempt ${s.attempts.length} runs with its own copy of this definition. Save applies from attempt ${nextAttempt}; Restart stops attempt ${s.attempts.length} and starts ${nextAttempt} from the current worktree.`
      : p.state === "completed" ? "The pipeline is completed. Save the edit first, then re-run this stage to reopen it: the new attempt binds the saved definition."
      : `Applies from attempt ${nextAttempt} — the next time this stage runs.`;
    const foot = `<button class="btn primary" data-act="pa:editStage:${p.id}:${s.id}" ${closed ? "disabled" : ""}>Save · from attempt ${nextAttempt}</button>${running ? `<button class="btn danger" data-act="pa:editRestart:${p.id}:${s.id}">Restart now</button>` : ""}<button class="btn quiet" data-go="#/pipeline/${p.id}">Cancel</button><span class="note">${esc(note)}</span>`;
    return editorShell({ key: s.id, icon: "pencil", text: `Stage ${stageIndex(p, s)}/${p.stages.length} · ${s.id}` }, badge(running ? `attempt ${s.attempts.length} running` : s.attempts.length ? `${s.attempts.length} attempts` : "not started", running ? "acc" : ""), `#/pipeline/${p.id}`, body, foot);
  }
  function addStageEditor(p, index) {
    const d = S.editorDraft && S.editorDraft.add === index && S.editorDraft.pipeline === p.id ? S.editorDraft : (S.editorDraft = { pipeline: p.id, add: index, id: "", role: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", sandbox: "full", prompt: "" });
    const after = p.stages[index - 1]; const before = p.stages[index];
    const body = `
      <label>Stage id <input class="field mono" value="${esc(d.id)}" data-act="ed:id" placeholder="e.g. verify-2" data-autofocus></label>
      <div class="rowf"><label>Role ${segHtml("Role", ROLES, d.role, "ed:role")}</label><label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "ed:engine")}</label></div>
      <div class="rowf"><label>Model ${segHtml("Model", MODELS[d.engine], d.model, "ed:model")}</label></div>
      <label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "ed:effort")}</label>
      <label>Prompt <textarea class="field" data-act="ed:prompt">${esc(d.prompt)}</textarea></label>`;
    const note = after ? `Inserted at its seam: ${after.id} → new stage → ${before ? before.id : "end"}.${p.state !== "draft" && index <= p.stages.indexOf(stageOf(p)) ? " It sits before the cursor, so it is history-only until an edge or a re-run reaches it." : ""}` : "Becomes the first stage.";
    const foot = `<button class="btn primary" data-act="pa:addStage:${p.id}:${index}">Add stage</button><button class="btn quiet" data-go="#/pipeline/${p.id}">Cancel</button><span class="note">${esc(note)}</span>`;
    return editorShell({ key: "add", icon: "plusCircle", text: `Add a stage ${after ? `after ${after.id}` : "first"}` }, "", `#/pipeline/${p.id}`, body, foot);
  }

  /* ── stage: one pipeline ───────────────────────────────────────────────── */
  function pipeView(p, selStage, addIndex) {
    const b = pipeBits(p); const s = stageOf(p); const need = p.state === "needs_decision";
    const used = roundsUsed(p, s);
    /* F18: «attempt» is one run of a stage, «round» one traversal of a fail
       edge. F10: earlier rounds fold open in place. */
    const earlier = s.attempts.slice(0, -1).filter((a) => a.findings && a.findings.length);
    const findings = need ? `<div class="panel findings" data-findings><h3>${esc(s.role.charAt(0).toUpperCase() + s.role.slice(1))} · attempt ${s.attempts.length}${s.onFail ? ` · round ${used} of ${s.onFail.maxRounds}` : ""} · ${p.findings.length} findings <span class="c">· stage ${stageIndex(p, s)}/${p.stages.length} · ${esc(s.id)}</span></h3><ol>${p.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>${earlier.length ? earlier.map((a) => `<details ${S.openRounds.has(`${p.id}:${a.n}`) ? "open" : ""}><summary data-act="round:${p.id}:${a.n}">${I("chevR", "sm")}round ${a.n} · ${a.findings.length} findings ›</summary><ol>${a.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol></details>`).join("") : ""}<div class="answer"><input class="field" placeholder="Answer for the next attempt (sent as a note with the question)…" data-act="answerField" data-focus="answer" aria-label="Answer"><button class="btn primary" data-act="pa:answer:${p.id}">Answer</button></div></div>` : "";
    const waiting = p.waiting ? `<div class="panel" style="border-left:3px solid var(--color-info)"><h3>Waiting · ${esc(p.waiting.kind)} since ${esc(p.waiting.since)}</h3></div>` : "";
    const act = (id, label, icon, cls) => `<button class="btn ${cls || ""}" data-act="pa:${id}:${p.id}">${icon ? I(icon, "sm") : ""}${label}</button>`;
    let actions = "";
    if (p.state === "draft") actions = act("start", "Start pipeline", "play", "primary") + act("discard", "Discard draft", "trash", "danger");
    else if (need) actions = act("retry", "Retry stage", "refresh", "primary") + act("skip", "Skip stage", "skip") + act("pause", "Pause", "pause") + act("archive", "Archive", "archive");
    else if (p.state === "paused") actions = act("resume", "Resume", "play", "primary") + act("archive", "Archive", "archive");
    else if (p.state === "running") actions = act("pause", "Pause", "pause") + act("checkpoint", "Checkpoint", "flag") + act("archive", "Archive", "archive");
    else if (p.state === "completed") actions = act("rerunLast", "Re-run the last stage", "refresh", "primary") + act("archive", "Archive", "archive");
    else if (p.state === "closed") actions = act("restore", "Restore", "undo", "primary");
    const sub = p.state === "draft"
      ? `<span>${p.stages.length} stages</span><span>not started</span>`
      : `<span class="st ${b.cls}">${esc(b.phrase)}</span><span>stage ${stageIndex(p, s)}/${p.stages.length}</span><span>started ${esc(p.started)}</span><span class="mono">${esc(p.branch || "")}</span><span>rev ${p.revision}</span>${p.lastEdit ? `<span class="rest">last edit by ${esc(p.lastEdit.actor)} ${esc(p.lastEdit.at)} ago</span>` : ""}`;
    const editor = selStage ? stageEditor(p, selStage) : addIndex !== undefined ? addStageEditor(p, addIndex) : "";
    const log = p.mutations.length ? `<div class="panel log"><details ${selStage ? "" : "open"}><summary>${I("chevD", "sm")}Changes <span class="c">· ${p.mutations.length} · every mutation is attributed and revision-stamped</span></summary>${p.mutations.slice().reverse().map((m, i) => `<div class="mrow ${i === 0 ? "newest" : ""}"><span class="badge">rev ${m.revision}</span><span class="l"><b>${esc(m.action)}</b>${m.stage ? ` · ${esc(m.stage)}` : ""}${m.detail ? ` · ${esc(m.detail)}` : ""}<small>${esc(m.actor)} · ${esc(m.at)} · ${esc(m.effect)}</small></span></div>`).join("")}</details></div>` : "";
    /* F3: the linked task is the thread card, not a bare list row. */
    const tasks = F.tasks.filter((t) => t.pipeline === p.id);
    const threads = tasks.length ? `<div class="panel"><h3>Linked tasks <span class="c">· ${tasks.length}</span></h3><div class="thread-card">${tasks.map((t) => kanbanCard(t, { flat: true })).join("")}</div></div>` : "";
    return `<div class="chat" data-pipeline="${p.id}"><div class="shead"><span class="dot ${b.cls === "acc" ? "acc pulse" : b.cls === "ok" ? "ok" : need ? "warn" : ""}"></span><div class="tt"><div class="t display trunc">${esc(p.task)}</div><div class="sub meta">${sub}</div></div>${need ? badge("needs a decision", "warn") : badge(b.badge, b.cls)}<button class="iconbtn" data-go="#/pipelines" aria-label="All pipelines" title="Pipelines (p)">${I("layers")}</button></div>
      <div class="sbody split">${findings}${waiting}
        <div class="actions">${actions}</div>
        <div class="pipe-grid ${editor ? "" : "noed"}"><div>${ladder(p, selStage ? selStage.id : null)}${graph(p, selStage ? selStage.id : null)}${toastHtml()}${threads}${log}</div>${editor}</div>
      </div></div>`;
  }
  function pipelinesList() {
    const ps = scopedPipes().concat(F.pipelines.filter((p) => p.state === "closed" && (S.project === "all" || p.project === S.project)));
    const grp = (label, items) => items.length ? `<div class="panel"><h3>${label} <span class="c">· ${items.length}</span></h3><div class="plist">${items.map((p) => pipeRow(p, null, { noChild: true })).join("")}</div></div>` : "";
    return `<div class="chat"><div class="shead"><div class="tt"><div class="t display">Pipelines</div><div class="sub meta"><span>${ps.length} in ${S.project === "all" ? "all projects" : esc(projectName(S.project))}</span></div></div><button class="btn" data-go="#/board/new-pipeline">${I("plus", "sm")}New pipeline</button></div><div class="sbody">${grp("Needs you", ps.filter((p) => p.state === "needs_decision"))}${grp("Active", ps.filter((p) => ["running", "paused"].includes(p.state)))}${grp("Drafts", ps.filter((p) => p.state === "draft"))}${grp("Completed", ps.filter((p) => p.state === "completed"))}${grp("Archived", ps.filter((p) => p.state === "closed"))}${toastHtml()}</div></div>`;
  }

  /* ── stage: the kanban — one card is one thread ────────────────────────── */
  const KCOLS = [["now", "Now"], ["review", "In review"], ["blocked", "Blocked"], ["planned", "Planned"], ["done", "Done"]];
  function kanbanCard(t, opts) {
    const c = t.worker ? conv(t.worker) : null;
    const p = t.pipeline ? pipe(t.pipeline) : null;
    const cb = c ? stateBits(c) : null;
    const needs = Boolean((cb && cb.edge) || (p && p.state === "needs_decision"));
    const on = c ? hashOf() === `#/chat/${c.id}` : p ? hashOf() === `#/pipeline/${p.id}` : false;
    const chips = [];
    if (c) chips.push(`<button class="kchip" data-go="#/chat/${c.id}" data-worker="${c.id}">${mark(c.engine)}<span class="who">${esc(c.model)}</span><span class="st ${cb.tone === "neu" ? "" : cb.tone}">${esc(cb.key === "waiting" ? `a question · ${c.waitedFor}` : cb.phrase)}</span></button>`);
    if (t.seat) chips.push(`<button class="kchip" data-go="#/seat">${I("bot", "sm")}<span class="who">Orchestrator</span><span class="st">holds this one</span></button>`);
    if (p) {
      const s = stageOf(p);
      const mini = `<span class="mini" aria-hidden="true">${p.stages.map((x) => { const l = lastAttempt(x); return `<i class="${l ? VERDICT[l.state] || "" : ""}"></i>`; }).join("")}</span>`;
      chips.push(`<button class="kchip" data-go="#/pipeline/${p.id}" data-pipe="${p.id}">${I("layers", "sm")}<span class="who">${stageIndex(p, s)}/${p.stages.length} ${esc(s.id)}</span><span class="st ${p.state === "needs_decision" ? "warn" : "acc"}">${esc(pipeBits(p).phrase)}</span>${mini}</button>`);
    }
    if (!chips.length) chips.push(`<button class="kchip" data-go="#/board/create"><span class="assign">＋ Assign a worker or a pipeline</span></button>`);
    return `<div class="kcard ${needs ? "need" : ""} ${on ? "on" : ""}" data-task="${t.id}" data-card>
      <button class="khead" data-go="${c ? `#/chat/${c.id}` : p ? `#/pipeline/${p.id}` : "#/board/task"}" data-drag="${t.id}"><span class="t">${esc(t.title)}${t.issue ? `<small>#${t.issue}</small>` : ""}</span>${needs ? badge("needs you", "warn") : ""}</button>
      <div class="kchips">${chips.join("")}</div>${opts?.flat ? "" : ""}</div>`;
  }
  function kanban() {
    const tasks = scopedTasks();
    const cols = KCOLS.map(([id, label]) => {
      const items = tasks.filter((t) => taskStatus(t) === id);
      return `<section class="kcol ${S.drag && S.drag.over === id ? "over" : ""}" data-col="${id}" aria-label="${label}"><div class="kh"><span class="label">${label}</span><span class="c tn">· ${items.length}</span></div><div class="kl">${items.map((t) => kanbanCard(t)).join("") || `<div class="kempty">Nothing here. Drag a card in, or press c to create one.</div>`}</div></section>`;
    }).join("");
    return `<div class="chat"><div class="shead"><div class="tt"><div class="t display">Board · ${esc(projectName(S.project === "all" ? "atlas" : S.project))}</div><div class="sub meta"><span>${tasks.length} tasks</span><span>${tasks.filter((t) => t.worker).length} with a worker</span><span>${tasks.filter((t) => t.pipeline).length} in a pipeline</span><span>${tasks.filter((t) => { const c = t.worker ? conv(t.worker) : null; const p = t.pipeline ? pipe(t.pipeline) : null; return (c && stateBits(c).edge) || (p && p.state === "needs_decision"); }).length} need you</span></div></div><button class="btn" data-act="newTask">${I("plus", "sm")}New task</button></div>${toastHtml()}<div class="kanban" data-kanban>${cols}</div></div>`;
  }

  /* ── stage: the map — groups auto-arrange, a moved group is honoured ───── */
  function mapNode(p, s, i) {
    const last = lastAttempt(s);
    const c = last && last.conv ? conv(last.conv) : null;
    const cur = p.cursor.stageId === s.id && p.state !== "draft";
    const verdict = last && last.state === "failed" && last.findings ? `<span class="verdict">${last.findings.length} findings</span>` : "";
    const loop = s.onFail ? `<span class="ret">↺ ${esc(s.onFail.to)}${roundPips(roundsUsed(p, s), s.onFail.maxRounds)}</span>` : "";
    return `<button class="mnode ${cur ? "cur" : ""}" data-go="${c ? `#/chat/${c.id}` : `#/pipeline/${p.id}/stage/${s.id}`}" data-mnode="${s.id}"><span class="station ${last ? VERDICT[last.state] || "" : ""}"></span><span class="k tn">${i + 1}/${p.stages.length}</span><span class="role">${esc(s.role)}</span>${mark(s.engine)}<span>${esc(s.model)}</span>${verdict}${loop}</button>`;
  }
  function mapTile(c) {
    const b = stateBits(c);
    return `<button class="mtile ${b.edge ? `wait ${b.edge === "dng" ? "dng" : ""}` : ""} ${hashOf() === `#/chat/${c.id}` ? "on" : ""}" data-go="#/chat/${c.id}"><span class="t two">${esc(c.title)}</span><span class="m meta"><span class="st ${b.tone === "neu" ? "" : b.tone}">${esc(b.phrase)}</span><span>${mark(c.engine)}${esc(c.model)}</span></span></button>`;
  }
  function mapView() {
    const pipes = scopedPipes().filter((p) => p.state !== "completed" && p.state !== "draft");
    const inPipe = new Set(); pipes.forEach((p) => p.stages.forEach((s) => s.attempts.forEach((a) => a.conv && inPipe.add(a.conv))));
    const pinned = (id) => Boolean(S.pins[id]);
    const groups = pipes.map((p) => {
      const started = p.stages.filter((s) => s.attempts.length);
      const rest = p.stages.filter((s) => !s.attempts.length);
      const spine = started.map((s) => {
        const i = p.stages.indexOf(s);
        const reached = p.stages[i + 1] && p.stages[i + 1].attempts.length;
        return `<div class="mst ${reached ? "on" : "dash"}" data-mst="${s.id}">${mapNode(p, s, i)}</div>`;
      }).join("");
      /* F11: stages that have not started collapse into one ladder tile. */
      const folded = rest.length ? `<div class="mst dash"><button class="folded" data-go="#/pipeline/${p.id}"><span>${rest.map((s) => `${stageIndex(p, s)}/${p.stages.length} ${s.id}`).join(" · ")}</span><span class="c">· not started</span></button></div>` : "";
      const need = p.state === "needs_decision";
      return `<div class="mapitem ${pinned(p.id) ? "pinned" : ""}" data-item="${p.id}"><div class="grp ${need ? "need" : ""}" data-group="${p.id}">
        <div class="gh" data-drag="${p.id}"><button class="gt" data-go="#/pipeline/${p.id}">${I("layers", "sm")}<span class="t">${esc(p.task)}</span><span class="k">${stageIndex(p, stageOf(p))}/${p.stages.length} · ${esc(pipeBits(p).phrase)}</span></button>${need ? badge("needs a decision", "warn") : ""}${pinned(p.id) ? `<button class="iconbtn pinmark" data-act="unpinItem:${p.id}" aria-label="Release ${esc(p.task)} back to the auto layout" title="Pinned · release to auto">${I("pin")}</button>` : ""}</div>
        <div class="hspine">${spine}${folded}</div></div></div>`;
    }).join("");
    const loose = F.conversations.filter((c) => inScope(c) && !inPipe.has(c.id) && !c.seat && ["working", "waiting", "held", "stalled", "limit", "returned"].includes(stateBits(c).key));
    const band = loose.length ? `<div class="mapitem" data-item="loose"><div class="band"><div class="gh"><span class="label">Loose conversations</span><span class="c tn muted">· ${loose.length}</span></div><div class="tiles">${loose.map(mapTile).join("")}</div></div></div>` : "";
    const anyPin = Object.keys(S.pins).length;
    return `<div class="chat"><div class="shead"><div class="tt"><div class="t display">Map · ${esc(projectName(S.project === "all" ? "atlas" : S.project))}</div><div class="sub meta"><span>${pipes.length} pipelines</span><span>${loose.length} loose conversations</span><span>${anyPin ? `${anyPin} pinned · the rest flows around them` : "arranged for you · drag a group to pin it"}</span></div></div>${anyPin ? `<button class="btn" data-act="unpinAll">${I("undo", "sm")}Release all to auto</button>` : ""}</div>${toastHtml()}<div class="map" data-map><div class="world">${groups}${band}${pipes.length + loose.length ? "" : `<div class="map-empty">Nothing is running in this project.</div>`}</div></div></div>`;
  }
  /* The auto layout: full-width bands top to bottom; a pinned group keeps the
     place the operator put it and the flow opens around it. Measured after
     render because the groups size themselves to their content. */
  function layoutMap() {
    const map = $app.querySelector(".map"); if (!map) return;
    const world = map.querySelector(".world");
    const items = [...world.querySelectorAll(".mapitem")];
    const PAD = 14, GAP = 12;
    const inner = Math.max(240, map.clientWidth - PAD * 2);
    for (const el of items) {
      const pin = S.pins[el.dataset.item];
      const x = pin ? Math.max(PAD, Math.min(pin.x, PAD + inner - 260)) : PAD;
      el.style.left = `${x}px`; el.style.width = `${PAD + inner - x}px`;
      if (pin) el.style.top = `${Math.max(PAD, pin.y)}px`;
    }
    const bands = items.filter((el) => S.pins[el.dataset.item]).map((el) => ({ top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight })).sort((a, b) => a.top - b.top);
    let y = PAD;
    for (const el of items) {
      if (S.pins[el.dataset.item]) continue;
      const h = el.offsetHeight;
      let top = y;
      for (const b of bands) if (top < b.bottom + GAP && b.top < top + h + GAP) top = b.bottom + GAP;
      el.style.top = `${top}px`;
      y = top + h + GAP;
    }
    world.style.height = `${Math.max(y, ...bands.map((b) => b.bottom + GAP), map.clientHeight)}px`;
  }

  /* ── stage: accounts, and one account in detail ────────────────────────── */
  const clockOf = (s) => { const m = /(\d{1,2}):(\d{2})/.exec(s || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const hhmm = (mins) => { const m = ((Math.round(mins) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  function paceOf(w) {
    const spent = 100 - w.left;
    const rate = w.elapsed > 0 ? spent / w.elapsed : 0;
    const idealLeft = Math.max(0, 100 * (1 - w.elapsed / w.hours));
    const hoursLeft = rate > 0 ? w.left / rate : Infinity;
    const windowLeft = w.hours - w.elapsed;
    return { rate, idealLeft, ahead: w.left >= idealLeft, hoursLeft, windowLeft, lasts: hoursLeft >= windowLeft };
  }
  function chart(w) {
    const L = 34, R = 452, T = 12, B = 156;
    const x = (h) => L + (R - L) * Math.min(1, h / w.hours);
    const y = (v) => B - (B - T) * (v / 100);
    const pace = paceOf(w);
    const actual = w.series.map(([h, v]) => `${x(h)} ${y(v)}`).join(" L ");
    const lastPt = w.series[w.series.length - 1];
    const outH = pace.lasts ? w.hours : w.elapsed + pace.hoursLeft;
    const proj = `M ${x(lastPt[0])} ${y(lastPt[1])} L ${x(outH)} ${y(pace.lasts ? Math.max(0, w.left - pace.rate * pace.windowLeft) : 0)}`;
    const cls = w.left <= 30 ? "warn" : "";
    return `<svg class="chart" viewBox="0 0 460 180" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Remaining percentage across the ${esc(w.label)} window: ${w.left}% left, ${pace.ahead ? "ahead of" : "behind"} the ideal pace">
      ${[0, 50, 100].map((v) => `<line class="grid" x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("")}
      <path class="ideal" d="M ${x(0)} ${y(100)} L ${x(w.hours)} ${y(0)}"/>
      <path class="proj" d="${proj}"/>
      <path class="actual ${cls}" d="M ${actual}"/>
      <circle class="pt ${cls}" cx="${x(lastPt[0])}" cy="${y(lastPt[1])}" r="4"/>
      <text class="tip" x="${Math.min(R - 40, x(lastPt[0]) + 8)}" y="${y(lastPt[1]) - 8}">${w.left}% left</text>
      <text class="lbl" x="${L}" y="174">window opens</text>
      <text class="lbl" x="${R}" y="174" text-anchor="end">${esc(w.reset.replace("resets ", ""))}</text>
      <text x="${x(w.hours * 0.62)}" y="${y(38) + 14}" text-anchor="middle">ideal pace</text>
    </svg>`;
  }
  function accountRow(engine, a) {
    const active = a.active;
    const signedIn = a.auth === "Authenticated";
    const wins = signedIn && a.windows.length
      ? a.windows.map((w) => `<span class="tn">${esc(w.label)}</span>${meter(w.left, `${w.left}% left`)}<span class="pct tn ${meterCls(w.left)}">${w.left}% left</span>`).join("")
        + `<span class="meta" style="grid-column:1/-1">${a.windows.map((w) => `<span>${esc(w.label)} ${esc(w.reset.replace("resets ", "resets "))}</span>`).join("")}</span>`
      : `<span class="tn">5 h</span><span class="meter empty"><i></i></span><span class="pct tn">—</span><span class="tn">Week</span><span class="meter empty"><i></i></span><span class="pct tn">—</span><span class="meta" style="grid-column:1/-1"><span>no windows until this account is signed in</span></span>`;
    const cur = hashOf() === `#/accounts/${engine}/${a.id}`;
    return `<button class="arow ${cur ? "on" : ""}" data-go="#/accounts/${engine}/${a.id}" data-row data-account="${a.id}" aria-current="${cur ? "true" : "false"}">
      <span class="dot ${signedIn ? (active ? "acc" : "ok") : ""}"></span>
      <span class="t">${esc(a.label)}<small>${esc(a.plan)}${a.checked ? ` · checked ${esc(a.checked)}` : ""}</small></span>
      <span class="wins">${wins}</span>
      ${signedIn ? badge(active ? "active" : "ready", active ? "acc" : "ok") : `<span class="signin">sign in →</span>`}</button>`;
  }
  function accountsView() {
    const eng = (engine, list) => `<div class="eng"><h2>${mark(engine, "fill")}${engine === "claude" ? "Claude" : "Codex"} accounts<span class="c">${list.length} accounts · ${list.filter((a) => a.auth === "Authenticated").length} signed in</span></h2>${list.map((a) => accountRow(engine, a)).join("")}<button class="arow add" data-act="addAccount:${engine}">${I("plus", "sm")}<span>Add a ${engine === "claude" ? "Claude" : "Codex"} account</span></button></div>`;
    return `<div class="chat"><div class="shead"><div class="tt"><div class="t display">Accounts &amp; limits</div><div class="sub meta"><span>every account, both windows</span><span>meters fill with what remains</span><span>open a row for its burn rate and when it runs out</span></div></div></div><div class="acc-body">${eng("claude", F.accounts.claude)}${eng("codex", F.accounts.codex)}</div>${toastHtml()}</div>`;
  }
  function accountDetail(engine, id) {
    const a = F.accounts[engine].find((x) => x.id === id);
    if (!a) return emptyStage();
    const signedIn = a.auth === "Authenticated" && a.windows.length;
    const w = signedIn ? a.windows[0] : null;
    const pace = w ? paceOf(w) : null;
    const resetAt = w ? clockOf(w.reset) : null;
    const runsOut = pace && resetAt !== null && !pace.lasts ? hhmm(resetAt - (pace.windowLeft - pace.hoursLeft) * 60) : null;
    const big = signedIn ? `<div class="bigwin">${a.windows.map((x) => `<div class="w"><div class="n"><b class="tn ${meterCls(x.left)}">${x.left}%</b><span>left of the ${esc(x.label)} window</span></div>${meter(x.left)}<small>${esc(x.reset)}</small></div>`).join("")}</div>` : `<div class="quietline">This account is not signed in, so it reports no windows. Sign in to see its consumption.</div>`;
    const hourly = a.hourly && a.hourly.length ? `<div class="hours">${a.hourly.map(([h, v]) => `<span class="h"><b class="tn">${v}</b><i style="height:${Math.max(2, v * 5)}%"></i>${esc(h)}</span>`).join("")}</div>` : `<div class="quietline">Nothing spent today.</div>`;
    const actions = `<div class="actions">${a.active ? "" : signedIn ? `<button class="btn primary" data-act="switch:${engine}:${a.id}">${I("swap", "sm")}Switch to this account</button>` : `<button class="btn primary" data-act="signIn:${engine}:${a.id}">Sign in</button>`}${signedIn ? `<button class="btn" data-act="useReset:${engine}:${a.id}">Use one reset</button><button class="btn" data-act="refresh:${engine}">${I("refresh", "sm")}Refresh</button>` : ""}<button class="btn quiet" data-go="#/accounts">${I("chevL", "sm")}All accounts</button></div>`;
    return `<div class="chat"><div class="shead"><button class="iconbtn" data-go="#/accounts" aria-label="All accounts" title="All accounts (Esc)">${I("chevL")}</button>${mark(engine, "fill")}<div class="tt"><div class="t display">${esc(a.label)}</div><div class="sub meta"><span>${engine === "claude" ? "Claude" : "Codex"}</span><span>${esc(a.plan)}</span>${a.checked ? `<span>checked ${esc(a.checked)}</span>` : ""}</div></div>${badge(a.active ? "active" : signedIn ? "ready" : "sign in", a.active ? "acc" : signedIn ? "ok" : "warn")}</div>
      <div class="acc-detail">
        <div class="panel wide"><h3>Windows</h3>${big}</div>
        ${signedIn ? `<div class="panel"><h3>Burndown <span class="c">· ${esc(w.label)} window · ideal pace against what is left</span></h3>${chart(w)}</div>
        <div class="panel"><h3>Pace</h3><div class="pace"><span class="big ${pace.ahead ? "ok" : "warn"}">burning at ${pace.rate.toFixed(1)} % per hour</span><small>${pace.ahead ? "ahead of pace — spending slower than the window refills" : "behind pace — spending faster than the window refills"} · ideal would leave ${Math.round(pace.idealLeft)}% by now</small><span class="big ${pace.lasts ? "" : "warn"}">${pace.lasts ? "lasts to the reset" : `runs out at ${runsOut || `${pace.hoursLeft.toFixed(1)} h from now`} at this pace`}</span><small>${esc(w.reset)} · ${pace.windowLeft.toFixed(1)} h of window left</small></div></div>` : ""}
        <div class="panel wide"><h3>Today by hour <span class="c">· percentage points spent</span></h3>${hourly}</div>
        <div class="panel wide">${actions}</div>
      </div>${toastHtml()}</div>`;
  }

  /* ── stage: overview ───────────────────────────────────────────────────── */
  function overview() {
    const live = F.projects.filter((p) => !p.archived && !S.archivedProjects.has(p.id) && !S.deletedProjects.has(p.id));
    const withCounts = live.map((p) => ({ p, n: counts(p.id) }));
    const active = withCounts.filter((x) => x.n.needs + x.n.working + x.n.pipelines > 0);
    const quiet = withCounts.filter((x) => x.n.needs + x.n.working + x.n.pipelines === 0);
    const order = { stalled: 0, limit: 1, waiting: 2, held: 3, working: 4, returned: 5, killed: 6, done: 7 };
    const keep = S.project; S.project = "all";
    const cards = active.map(({ p, n }) => {
      const convs = F.conversations.filter((c) => c.project === p.id && !c.seat && !c.child && !S.closed.has(c.id) && arrivedYet(c));
      const rows = convs.slice().sort((a, b) => order[stateBits(a).key] - order[stateBits(b).key]).slice(0, 8);
      return `<div class="pc"><button class="ph" data-go="#/board" data-project="${p.id}"><span class="dot ${n.needs ? "warn" : n.working ? "ok" : ""}"></span><span class="t trunc">${esc(p.name)}</span>${p.crowned ? `<svg class="i sm crown" viewBox="0 0 24 24" aria-hidden="true">${ICONS.crown}</svg>` : ""}<span class="cnt">${n.needs ? `<b>${n.needs} need you</b>` : ""}<span>${n.working} working</span><span>${n.pipelines} pipeline${n.pipelines === 1 ? "" : "s"}</span></span>${I("chevR")}</button>${rows.map((c) => convRow(c).replace('data-go="#/chat/', `data-project="${p.id}" data-go="#/chat/`)).join("")}${convs.length > 8 ? `<div class="quietline">${convs.length - 8} more</div>` : ""}</div>`;
    }).join("");
    /* F14: quiet projects are one strip of chips, not eight tall cards. */
    const strip = quiet.length ? `<div class="quietstrip"><span class="lbl">Quiet · ${quiet.length}</span>${quiet.map(({ p }) => `<button class="qchip" data-go="#/board" data-project="${p.id}"><span class="chip">${esc(p.name)}<small>${esc(p.age)}</small></span></button>`).join("")}</div>` : "";
    S.project = keep;
    return `<div class="ov">${cards ? `<div class="ov-grid">${cards}</div>` : `<div class="quietline">No project has anything running.</div>`}${strip}${toastHtml()}</div>`;
  }

  /* ── stage: the landing surface ────────────────────────────────────────── */
  const projectTasks = () => scopedTasks();
  function effectiveView() {
    if (S.view) return S.view;
    return projectTasks().length ? "kanban" : "list";
  }
  /* F4: the landing stage does work — the kanban when the project has tasks,
     else the first thing that needs the operator, else the seat. */
  function landing() {
    if (S.project === "all") return overview();
    if (effectiveView() === "map") return mapView();
    if (effectiveView() === "kanban" && projectTasks().length) return kanban();
    const a = attention();
    if (a.length) { const it = a[0]; return it.kind === "conv" ? chatView(conv(it.id)) : pipeView(pipe(it.id)); }
    const sc = seatConv();
    if (sc) return chatView(sc);
    const any = F.conversations.find((c) => inScope(c) && !c.seat);
    if (any) return chatView(any);
    return emptyStage();
  }
  function emptyStage() {
    return `<div class="emptystage"><h2>Nothing here yet</h2><p>Create a conversation, a task or a pipeline with ＋, or pick a project on the left.</p><button class="btn primary" data-go="#/board/create">${I("plus", "sm")}Create</button>${toastHtml()}</div>`;
  }

  /* ── dialogs ───────────────────────────────────────────────────────────── */
  const mrow = (icon, label, go, opts) => `<button class="mrow ${opts?.cls || ""}" ${go.startsWith("#") ? `data-go="${go}"` : `data-act="${go}"`} ${opts?.checked !== undefined ? `role="menuitemcheckbox" aria-checked="${opts.checked}"` : ""}>${I(icon)}<span class="l">${esc(label)}${opts?.sub ? `<small>${esc(opts.sub)}</small>` : ""}</span>${opts?.right ? `<span class="r">${opts.right}</span>` : ""}${opts?.kbd ? `<span class="kbd">${esc(opts.kbd)}</span>` : ""}</button>`;
  function dialogShell(title, body, opts) {
    return `<div class="scrim ${opts?.clear ? "clear" : ""}" data-scrim><div class="dialog ${opts?.wide ? "wide" : ""} ${opts?.cls || ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-dialog><div class="dh"><h2>${esc(title)}${opts?.sub ? `<small>${esc(opts.sub)}</small>` : ""}</h2>${opts?.head || ""}<button class="iconbtn" data-act="close" aria-label="Close">${I("x")}</button></div>${body}${opts?.foot ? `<div class="df">${S.toast ? toastHtml() : ""}${opts.foot}</div>` : ""}</div></div>`;
  }
  function popShell(body, style, label) { return `<div class="scrim clear" data-scrim><div class="pop" role="dialog" aria-label="${esc(label || "Menu")}" style="${style}" data-dialog>${body}</div></div>`; }
  function dialogs() {
    const h = hashOf(); const s = segs();
    const c = s[0] === "chat" ? conv(s[1]) : null;
    if (h === "#/board/create") return popShell(`${mrow("plus", "New conversation", "#/board/new-agent", { sub: "engine, model, reasoning, account, prompt", kbd: "c" })}${mrow("flag", "New task", "newTask")}${mrow("layers", "New pipeline", "#/board/new-pipeline", { sub: "from a template or a blank graph" })}${F.seat.state === "none" ? mrow("bot", "Create an orchestrator", "#/seat/rotate") : ""}`, `top:52px;left:calc(var(--rail) + var(--col) - 96px)`, "Create");
    if (h === "#/board/menu") return popShell(`${mrow("board", "Board", "#/kanban", { kbd: "k" })}${mrow("layers", "Pipelines", "#/pipelines", { kbd: "p" })}${mrow("map", "Map", "#/map", { kbd: "m" })}${mrow("list", "All conversations", "recentAll", { sub: `${F.conversations.filter(inScope).length} in this project` })}${mrow("person", "Accounts & limits", "#/accounts", { kbd: "a" })}${mrow("terminal", "Host details", "#/board/host", { right: F.runtime !== "connected" ? badge(F.runtime, F.runtime === "offline" ? "dng" : "info") : "", sub: `${F.hosts.length} background tasks` })}${mrow("keyboard", "Keyboard shortcuts", "#/board/keys", { kbd: "?" })}${mrow("bell", "Sound", "sound", { checked: S.sound })}<div class="msep"></div>${mrow("archive", "Archive project", "archiveProject", { sub: "moves it to the rail's Archive · Restore in the receipt" })}${mrow("trash", "Delete project", "deleteProject", { cls: "dng", sub: "acts now · Restore in the receipt for 4 s" })}`, `top:52px;left:calc(var(--rail) + var(--col) - 48px)`, "Board menu");
    if (h === "#/board/host") return dialogShell("Host details", `<div class="db"><div class="mrow" style="min-height:40px"><span class="dot ${F.runtime === "connected" ? "ok" : F.runtime === "degraded" ? "warn" : "dng"}"></span><span class="l">Runtime · ${F.runtime === "connected" ? "connected · updates stream" : F.runtime === "degraded" ? "degraded · polling every 10 s" : "offline · reconnecting"}</span></div><div class="mgrp">Background tasks · ${F.hosts.length}</div>${F.hosts.map((x) => `<div class="hostrow"><span class="n">${esc(x.name)}<small>pid <span class="mono">${x.pid}</span> · ${esc(x.mem)} · ${esc(x.since)}</small></span><button class="btn danger" data-act="killHost:${x.pid}">Kill</button></div>`).join("")}<div class="mgrp">Hidden · ${S.closed.size} closed conversations</div>${S.closed.size ? [...S.closed].map((id) => `<div class="hostrow"><span class="n">${esc(conv(id)?.title || id)}</span><button class="btn" data-act="reopen:${id}">Reopen</button></div>`).join("") : ""}</div>`, { sub: "the runtime, background tasks, hidden conversations", foot: `<button class="btn" data-act="close">Close</button>` });
    if (h === "#/board/keys") return dialogShell("Keyboard shortcuts", `<div class="keys-grid">${[["n", "next decision"], ["N", "previous decision"], ["o", "orchestrator"], ["/", "find my messages"], ["k", "board"], ["m", "map ⇄ list"], ["a", "accounts & limits"], ["p", "pipelines"], ["c", "create"], ["i", "type to the agent"], ["[", "collapse the rail"], ["↑ ↓", "move in the column"], ["Enter", "open the highlighted row or stage"], ["1 – 9", "pick a question option"], ["Esc", "leave the field · back to the column"], ["?", "this list"], ["Enter", "send (in the composer)"], ["Shift+Enter", "newline (in the composer)"]].map(([k, l]) => `<div class="kr"><span class="kbd">${esc(k)}</span><span>${esc(l)}</span></div>`).join("")}</div>`, { sub: "single keys while nothing is being typed", foot: `<button class="btn" data-act="close">Close</button>` });
    if (h === "#/board/task") return dialogShell("New task", `<div class="db form"><label>Title <input class="field" data-act="nt:title" data-autofocus placeholder="What has to be done?"></label><label>Status ${segHtml("Status", KCOLS.map((k) => k[0]), "planned", "nt:status")}</label><div class="hint">A task becomes a thread when you give it a worker or a pipeline; both chips appear on its card.</div></div>`, { foot: `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="newTask">Create task</button>` });
    if (h === "#/board/search") {
      const q = S.search.trim().toLowerCase();
      const hits = []; for (const cv of F.conversations) for (const m of cv.feed || []) { if (S.searchScope === "mine" && m.kind !== "user") continue; if (m.kind !== "user" && m.kind !== "agent") continue; if (q && !m.text.toLowerCase().includes(q)) continue; hits.push({ cv, m }); }
      const hl = (t) => q ? esc(t).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (x) => `<mark>${x}</mark>`) : esc(t);
      /* F12: two lines — title with its meta right-aligned, then the snippet
         truncated on its own line, so nothing paints over the meta column. */
      return dialogShell("Find my messages", `<div class="db form" style="padding-bottom:0"><div class="rowf" style="display:flex;gap:6px"><input class="field" style="flex:1" value="${esc(S.search)}" data-act="search" data-autofocus placeholder="Search everything you've sent…" aria-label="Search"><div class="seg"><button class="${S.searchScope === "mine" ? "on" : ""}" data-act="scope:mine" aria-pressed="${S.searchScope === "mine"}">My messages</button><button class="${S.searchScope === "all" ? "on" : ""}" data-act="scope:all" aria-pressed="${S.searchScope === "all"}">Everything</button></div></div><div class="hint">${q ? `${hits.length} results · ranked in memory · ↑ ↓ to move · Enter opens the conversation at the message` : "Every project, engine and account. Results open in the conversation with the composer."}</div></div><div class="db search-rows">${hits.slice(0, 8).map(({ cv, m }) => `<button class="srow" data-go="#/chat/${cv.id}" data-project="${cv.project}"><span class="st">${esc(cv.title)}</span><span class="sm"><span class="pj">${esc(projectName(cv.project))}</span>${mark(cv.engine)}<span class="tn">${esc(m.ts || "")}</span></span><span class="snip">${hl(m.text.split("\n")[0])}</span></button>`).join("")}${q && !hits.length ? `<div class="hint" style="padding:12px">Nothing found for «${esc(S.search)}»</div>` : ""}</div>`, { wide: true });
    }
    if (h === "#/board/new-agent") {
      const d = S.newAgent || (S.newAgent = { engine: "claude", model: "Opus", effort: "high", account: "cl-main", cwd: "~/Projects/atlas", prompt: "" });
      return dialogShell("New conversation", `<div class="db form"><div class="rowf"><label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "na:engine")}</label><label>Model ${segHtml("Model", MODELS[d.engine], d.model, "na:model")}</label></div><label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "na:effort")}</label><label>Account</label>${accountRows(d.engine, d.account, "na:account")}<label>Directory <input class="field mono" value="${esc(d.cwd)}" data-act="na:cwd"></label><label>First message <textarea class="field" data-act="na:prompt" data-autofocus placeholder="What should the agent do?">${esc(d.prompt)}</textarea></label></div>`, { sub: `in ${projectName(S.project === "all" ? "atlas" : S.project)}`, foot: `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="startAgent">Start conversation</button>` });
    }
    if (h === "#/board/new-pipeline") return dialogShell("New pipeline", `<div class="db form"><label>Repository <input class="field mono" value="~/Projects/${esc(S.project === "all" ? "atlas" : S.project)}" data-act="np:repo"></label><div class="hint">Repository ready · the pipeline gets its own worktree and branch.</div><div class="tpl">${[["Plan → Build → Review", ["architect", "builder", "reviewer ↺"]], ["Build → Review", ["builder", "reviewer ↺"]], ["Build → Verify", ["builder", "verifier"]], ["Blank graph", []]].map(([t, roles], i) => `<button data-act="np:template:${i}" ${i === 0 ? "data-autofocus" : ""}><b>${esc(t)}</b>${roles.length ? `<span class="flow">${roles.map((r) => badge(r, r.includes("↺") ? "acc" : "")).join(I("arrowR", "sm"))}</span>` : `<span class="hint">Start empty and assemble the stages by hand.</span>`}</button>`).join("")}</div></div>`, { sub: "a draft lands on the board; edit stages before or after start" });
    if (h === "#/seat/rotate") {
      const create = F.seat.state === "none"; const d = S.rotate || (S.rotate = { engine: F.seat.engine, model: F.seat.model, effort: F.seat.effort, account: "cl-main", mandate: F.seat.mandate });
      return dialogShell(create ? "Create an orchestrator" : "Rotate the orchestrator", `<div class="db form"><div class="hint">${create ? "The orchestrator runs this board and talks to you here. It starts with the mandate below." : "A successor takes the seat with the mandate below; the current orchestrator hands over its context and stops."}</div><div class="rowf"><label>Engine ${segHtml("Engine", ["claude", "codex"], d.engine, "ro:engine")}</label><label>Model ${segHtml("Model", MODELS[d.engine], d.model, "ro:model")}</label></div><label>Reasoning ${segHtml("Reasoning", EFFORTS, d.effort, "ro:effort")}</label><label>Account</label>${accountRows(d.engine, d.account, "ro:account")}<label>Mandate <textarea class="field" data-act="ro:mandate" data-autofocus data-orchestrator-mandate>${esc(d.mandate)}</textarea></label></div>`, { foot: `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="${create ? "createSeat" : "rotateSeat"}" data-orchestrator-primary>${create ? "Create orchestrator" : "Rotate orchestrator"}</button>` });
    }
    if (c && h.endsWith("/menu")) {
      const b = stateBits(c); const p = c.pipeline ? pipe(c.pipeline.id) : null; const task = F.tasks.find((t) => t.worker === c.id);
      const first = (c.seat ? mrow("bot", "Orchestrator seat", "#/seat", { sub: "status · context · mandate · rotate" }) : "")
        + (p ? mrow("layers", `Pipeline · ${p.task}`, `#/pipeline/${p.id}`, { sub: `stage ${c.pipeline.k}/${c.pipeline.n} · ${c.pipeline.stage} · ${pipeBits(p).phrase}` }) : "")
        + (task ? mrow("flag", `Task · ${task.title}`, "#/kanban", { sub: `${KCOLS.find((k) => k[0] === taskStatus(task))[1]} on the board` }) : "");
      return popShell(`${first}${first ? '<div class="msep"></div>' : ""}${canPin() ? mrow("panel", S.pin === c.id ? "Unpin" : "Pin beside", S.pin === c.id ? "unpin" : `pin:${c.id}`) : ""}${mrow("pencil", "Rename", `rename:${c.id}`)}${mrow("crown", S.crowned.has(c.id) ? "Remove crown" : "Crown", `crown:${c.id}`)}${mrow("swap", "Hand off", `handoff:${c.id}`, { sub: "start a successor with this context" })}${mrow("compress", "Compact context", `compact:${c.id}`, { right: `${100 - (c.ctx || 0)}% left` })}${mrow("info", "Details & host", `#/chat/${c.id}/details`)}${mrow("terminal", "Open in terminal", `terminal:${c.id}`)}<div class="msep"></div>${mrow("x", "Close card", `close:${c.id}`, { sub: "Reopen in the receipt" })}${mrow("square", "Kill agent", `kill:${c.id}`, { cls: "dng", sub: b.key === "working" ? "running now" : b.key === "stalled" ? "stalled" : "not running" })}`, `top:52px;right:8px`, "Conversation actions");
    }
    if (c && h.endsWith("/model")) {
      const nx = S.next[c.id] || { model: c.model, effort: c.effort, account: c.account }; const b = stateBits(c);
      const acct = `<div class="mgrp">Account</div>${F.accounts[c.engine].map((a) => {
        const low = a.windows.length ? Math.min(...a.windows.map((w) => w.left)) : null;
        if (a.active && b.key === "limit") return `<div class="mrow"><span class="dot warn"></span><span class="l">${esc(a.label)}<small>limit · resets ${esc(c.limitReset || "16:40")}</small></span>${badge("limit", "warn")}</div>`;
        return `<button class="arow compact" data-act="${a.auth === "Authenticated" ? `md:${c.id}:account:${a.id}` : `signIn:${c.engine}:${a.id}`}"><span class="dot ${a.auth === "Authenticated" ? "ok" : ""}"></span><span class="t">${esc(a.label)}<small>${esc(a.plan)}</small></span>${a.auth === "Authenticated" ? (low !== null ? `<span class="pct tn ${meterCls(low)}">${low}% left</span>` : badge("ready", "ok")) : `<span class="signin">sign in →</span>`}</button>`;
      }).join("")}<div class="msep"></div>`;
      return popShell(`<div class="mgrp">Applies to your next message · ${esc(nx.model)} · ${esc(nx.effort)}</div>${acct}<div class="mgrp">Model</div>${MODELS[c.engine].map((m) => `<button class="mrow ${nx.model === m ? "on" : ""}" data-act="md:${c.id}:model:${m}">${mark(c.engine)}<span class="l">${esc(m)}</span>${nx.model === m ? I("check") : ""}</button>`).join("")}<div class="mgrp">Reasoning</div>${EFFORTS.map((e) => `<button class="mrow ${nx.effort === e ? "on" : ""}" data-act="md:${c.id}:effort:${e}">${I("zap")}<span class="l">${esc(e)}</span>${nx.effort === e ? I("check") : ""}</button>`).join("")}`, `bottom:70px;left:calc(var(--rail) + var(--col) + 24px)`, "Next message");
    }
    if (c && h.endsWith("/details")) {
      const p = c.pipeline ? pipe(c.pipeline.id) : null;
      return dialogShell("Details & host", `<div class="db"><div class="mgrp">This conversation</div><dl class="details-grid"><dt>Account</dt><dd>${esc(c.account)} · ${esc(c.engine === "claude" ? "Claude" : "Codex")}</dd><dt>Context</dt><dd style="display:flex;align-items:center;gap:8px">${meter(100 - (c.ctx || 0))}<span class="tn">${100 - (c.ctx || 0)}% left</span></dd><dt>Worktree</dt><dd class="mono">${esc(c.worktree || "—")}</dd><dt>Pipeline</dt><dd>${p ? `${esc(p.task)} · stage ${c.pipeline.k}/${c.pipeline.n}` : "—"}</dd><dt>Members</dt><dd>${c.children ? c.children.map((k) => `${esc(k.title)} · ${esc(k.state)}`).join("<br>") : "—"}</dd></dl><div class="mgrp">Host</div><div class="mrow" style="min-height:40px"><span class="dot ${F.runtime === "connected" ? "ok" : "warn"}"></span><span class="l">Runtime · ${esc(F.runtime)}</span></div>${F.hosts.map((x) => `<div class="hostrow"><span class="n">${esc(x.name)}<small>pid <span class="mono">${x.pid}</span> · ${esc(x.mem)}</small></span><button class="btn danger" data-act="killHost:${x.pid}">Kill</button></div>`).join("")}</div>`, { sub: c.title, foot: `<button class="btn" data-act="close">Close</button>` });
    }
    return "";
  }

  /* ── stage router ──────────────────────────────────────────────────────── */
  function stage() {
    const s = segs();
    if (s[0] === "overview") return overview();
    if (s[0] === "kanban" || s[0] === "tasks") return kanban();
    if (s[0] === "map") return mapView();
    if (s[0] === "chat") { const c = conv(s[1]); return c ? chatView(c) : landing(); }
    if (s[0] === "seat") { const c = seatConv(); return c ? chatView(c, { seatPanel: true }) : landing(); }
    if (s[0] === "pipelines") return pipelinesList();
    if (s[0] === "pipeline") { const p = pipe(s[1]); if (!p) return landing(); return pipeView(p, s[2] === "stage" ? p.stages.find((x) => x.id === s[3]) : null, s[2] === "add" ? Number(s[3]) : undefined); }
    if (s[0] === "accounts") return s[1] && s[2] ? accountDetail(s[1], s[2]) : accountsView();
    return landing();
  }
  function statusBar() {
    const rt = F.runtime; const cl = F.accounts.claude.find((a) => a.active); const cx = F.accounts.codex.find((a) => a.active);
    const low = (a) => a && a.windows.length ? Math.min(...a.windows.map((w) => w.left)) : null;
    const acc = (engine, a) => { const l = low(a); return `<button class="sbtn" data-go="${a ? `#/accounts/${engine}/${a.id}` : "#/accounts"}" aria-label="${engine} account ${a ? a.label : ""}"><span class="sb ${l !== null && l <= 10 ? "dng" : l !== null && l <= 30 ? "warn" : ""}">${mark(engine)}${a ? `${esc(a.label)} · <span class="tn">${l}% left</span>` : "no account"}</span></button>`; };
    return `<div class="statusbar"><button class="sbtn" data-go="#/board/host" aria-label="Runtime ${rt}"><span class="sb ${rt === "offline" ? "dng" : rt === "degraded" ? "warn" : ""}"><span class="dot ${rt === "connected" ? "ok" : rt === "degraded" ? "warn" : "dng"}"></span>${rt === "connected" ? "connected" : rt === "degraded" ? "degraded · polling" : "offline · reconnecting"}</span></button><button class="sbtn" data-go="#/board/host" aria-label="Background tasks"><span class="sb">${I("terminal", "sm")}${F.hosts.length} background tasks</span></button><span class="sp"></span>${acc("claude", cl)}${acc("codex", cx)}<button class="sbtn" data-go="#/board/keys" aria-label="Keyboard shortcuts"><span class="sb"><span class="kbd">?</span> shortcuts</span></button></div>`;
  }

  /* ── render, and the focus model (F5) ──────────────────────────────────── */
  const sel = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
  function focusKey(el) {
    if (!el || el === document.body || !$app.contains(el)) return null;
    if (el.dataset.focus) return `[data-focus=${sel(el.dataset.focus)}]`;
    if (el.dataset.act) return `[data-act=${sel(el.dataset.act)}]`;
    if (el.dataset.go) return `[data-go=${sel(el.dataset.go)}]`;
    return null;
  }
  /* Opening a stage moves focus to the one thing the operator came to do. */
  function stageFocus() {
    const st = $app.querySelector(".stage"); if (!st) return null;
    const q = st.querySelector(".q:not(.quiet) .opt");
    if (q) return q;
    const answer = st.querySelector('[data-focus="answer"]');
    if (answer) return answer;
    const editor = st.querySelector(".editor");
    if (editor) return editor.querySelector("[data-autofocus]") || editor.querySelector(".ebody button, .ebody input, .ebody textarea, .ebody select");
    const field = st.querySelector('[data-focus="field"]');
    if (field) return field;
    return st.querySelector(".node .nhead, .kcard .khead, .arow, [data-row], .grp .gt, .mtile, .ph, .emptystage .btn, .btn");
  }
  function columnRows() { return [...$app.querySelectorAll(".col-body [data-row], .col-body .seat .main")]; }
  function escapeToColumn() {
    const rows = columnRows();
    const cur = rows.find((r) => r.classList.contains("on")) || rows[0] || $app.querySelector('[data-focus="filter"]');
    if (cur) { cur.focus(); cur.scrollIntoView({ block: "nearest" }); }
  }
  let lastHash = "";
  function render() {
    const was = document.activeElement;
    const wasKey = focusKey(was);
    const wasSel = was && (was.tagName === "INPUT" || was.tagName === "TEXTAREA") ? [was.selectionStart, was.selectionEnd] : null;
    const h = hashOf(); const s = segs();
    if (s[0] === "overview") S.project = "all";
    else if (S.project === "all" && s[0] !== "overview") { const c = s[0] === "chat" ? conv(s[1]) : null; const p = s[0] === "pipeline" ? pipe(s[1]) : null; if (c && !c.seat) S.project = c.project; else if (p) S.project = p.project; }
    if (s[0] === "map") S.view = "map";
    if (s[0] === "kanban" || s[0] === "tasks") S.view = "kanban";
    if (s[0] === "chat" && conv(s[1])) S.seen.add(s[1]);
    if (s[0] !== "pipeline") S.editorDraft = null;
    $app.dataset.rail = railOpen() ? "1" : "0";
    $app.dataset.pin = S.pin && canPin() ? "1" : "0";
    const pinConv = S.pin && canPin() ? conv(S.pin) : null;
    $app.innerHTML = `${rail()}${column()}<main class="stage" aria-label="Stage">${banner()}${stage()}</main>${pinConv ? `<aside class="pin" aria-label="Pinned conversation">${chatView(pinConv, { pinned: true })}</aside>` : ""}${statusBar()}${dialogs()}`;
    const screen = SCREENS.find((x) => x.hash === location.hash || x.hash.split("?")[0] === h);
    $app.dataset.screen = screen ? screen.id : h;
    $app.dataset.view = effectiveView();
    $app.dataset.ready = "1";
    layoutMap();
    const dlg = $app.querySelector("[data-dialog]");
    if (h !== lastHash) {
      lastHash = h;
      const feed = $app.querySelector(".stage .feed"); if (feed) feed.scrollTop = feed.scrollHeight;
      if (dlg) { const first = dlg.querySelector("[data-autofocus]") || dlg.querySelector("button, input, textarea, select"); if (first) first.focus(); }
      else { const t = stageFocus(); if (t) t.focus(); }
    } else {
      /* Every re-render restores the element the operator was on, by identity
         rather than by position, so acting never drops focus to the body. */
      const back = wasKey && $app.querySelector(wasKey);
      if (back) { back.focus(); if (wasSel && "setSelectionRange" in back) try { back.setSelectionRange(wasSel[0], wasSel[1]); } catch { /* not a text field any more */ } }
      else if (dlg) { const first = dlg.querySelector("[data-autofocus]") || dlg.querySelector("button, input, textarea, select"); if (first && !dlg.contains(document.activeElement)) first.focus(); }
      else if (document.activeElement === document.body) { const t = stageFocus(); if (t) t.focus(); }
    }
    const bench = document.getElementById("bench-screens"); if (bench && !bench.childElementCount) bench.innerHTML = SCREENS.map((x) => `<a href="?${x.scenario ? `scenario=${x.scenario}&` : ""}w=${width()}${params.get("scheme") ? `&scheme=${params.get("scheme")}` : ""}${x.hash}" ${x.id === $app.dataset.screen ? 'class="on"' : ""}>${esc(x.id)}</a>`).join("");
    if (S.arrival === null && F.arrival && !S.arrivalTimer) {
      S.arrivalTimer = setTimeout(() => {
        S.arrival = { id: F.arrival.id };
        const c = conv(F.arrival.id);
        /* F20: in the current project the arrival is a new row with its edge
           and one tick of the counts — never a banner, never a toast. */
        if (c && c.project === S.project) { S.newRows.add(c.id); S.ticked = true; setTimeout(() => { S.ticked = false; S.newRows.delete(c.id); render(); }, 1200); }
        render();
        setTimeout(() => { S.arrivalDismissed = true; render(); }, 6000);
      }, F.arrival.after || 400);
    }
  }

  /* ── acts ──────────────────────────────────────────────────────────────── */
  function attempt(p, s, state) { const n = s.attempts.length + 1; s.attempts.push({ n, state, conv: null, head: "worktree" }); return n; }
  function mutate(p, action, stageId, effect, detail) { p.revision += 1; p.mutations.push({ seq: p.mutations.length + 1, at: F.now, actor: "operator", action, stage: stageId, effect, revision: p.revision, detail }); p.lastEdit = { actor: "operator", at: "now", action: `${action}${stageId ? ` · ${stageId}` : ""}` }; }
  function pipelineAct(kind, pid, sid) {
    const p = pipe(pid); if (!p) return; const s = sid ? p.stages.find((x) => x.id === sid) : null; const d = S.editorDraft || {};
    /* F19: the receipt names the revision the record moved to; the request
       payload that carried it is the API contract, not product copy. */
    const rev = () => `rev ${p.revision}`;
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
    if (kind === "close" && !a) return closeDialog();
    if (kind === "undo") { const u = S.toast && S.toast.undo; S.toast = null; if (u) return act(u.act, el); return render(); }
    if (kind === "rail") { S.rail = !railOpen(); return render(); }
    if (kind === "view") { S.view = a; if (a === "map") return go("#/map"); if (a === "kanban") return go("#/kanban"); return go("#/board", { replace: /^#\/(map|kanban|tasks)/.test(hashOf()) }); }
    if (kind === "toggle") { if (a === "recent") S.recentTouched = true; if (S.collapsed.has(a)) S.collapsed.delete(a); else S.collapsed.add(a); return render(); }
    if (kind === "recentAll") { S.recentAll = true; if (isDialog(hashOf())) return closeDialog(); return render(); }
    if (kind === "sound") { S.sound = !S.sound; return render(); }
    if (kind === "egrp") { const k = name.slice(5); if (S.openGroups.has(k)) S.openGroups.delete(k); else S.openGroups.add(k); return render(); }
    if (kind === "round") { const k = `${a}:${b}`; if (S.openRounds.has(k)) S.openRounds.delete(k); else S.openRounds.add(k); return render(); }
    if (kind === "node") { const k = `${a}:${b}`; if (S.openNodes.has(k)) S.openNodes.delete(k); else S.openNodes.add(k); return render(); }
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
    if (kind === "rename") { closeDialog(); toast("Rename", "the title cell becomes editable in place"); return; }
    if (kind === "handoff") { closeDialog(); const cv = conv(a); const nc = { id: `h-${a}`, project: cv.project, title: `${cv.title} · handoff`, engine: cv.engine, model: cv.model, effort: cv.effort, account: cv.account, state: "working", elapsed: "0:02", age: "now", ctx: 4, feed: [{ kind: "user", ts: F.now, text: `Continue from the handoff of «${cv.title}».` }] }; F.conversations.push(nc); toast("Handed off", "a successor started with this context", { label: "Open successor", act: `open:${nc.id}` }); return; }
    if (kind === "open") return go(`#/chat/${a}`);
    if (kind === "compact") { closeDialog(); const cv = conv(a); cv.ctx = Math.max(2, Math.round((cv.ctx || 0) / 3)); toast("Compacted the context", `${100 - cv.ctx}% left`); return; }
    if (kind === "terminal") { closeDialog(); toast("Opened in the terminal", "attach command copied"); return; }
    if (kind === "pin") { S.pin = a; closeDialog(); toast("Pinned beside", "the pane stays while you move around", { label: "Unpin", act: "unpin" }); return; }
    if (kind === "unpin") { S.pin = null; if (isDialog(hashOf())) closeDialog(); return render(); }
    /* Operator item 5: a moved group is honoured; releasing it returns to the
       arrangement the system makes. */
    if (kind === "unpinItem") { delete S.pins[a]; toast("Released to the auto layout", "the map arranges it again"); return; }
    if (kind === "unpinAll") { S.pins = {}; toast("Everything released", "the map arranges all of it"); return; }
    if (kind === "answer") { const cv = conv(a); const o = cv.question.options[Number(b)]; S.answers[a] = o.label; cv.state = "working"; cv.elapsed = "0:02"; toast("Answered", `${o.label} · ${F.now}`); return; }
    if (kind === "answerText") { const cv = conv(a); const t = name.slice(name.indexOf(":", name.indexOf(":") + 1) + 1); S.answers[a] = t; cv.state = "working"; cv.elapsed = "0:02"; toast("Answered", `${t} · ${F.now}`); return; }
    if (kind === "toggleQ") { const k = a + ":open"; S.pickedOption[k] = !S.pickedOption[k]; return render(); }
    if (kind === "md") { const nx = S.next[a] || (S.next[a] = { model: conv(a).model, effort: conv(a).effort, account: conv(a).account }); if (b === "account") { const acc = F.accounts[conv(a).engine].find((x) => x.id === c); nx.account = acc.label; conv(a).state = "working"; conv(a).account = acc.label; closeDialog(); toast(`Next message launches on ${acc.label}`, "the limit on Main stays until it resets", { label: "Switch back", act: `md:${a}:back:0` }); return; } if (b === "back") { conv(a).state = "limit"; return render(); } nx[b] = b === "speed" ? Number(c) : c; closeDialog(); return; }
    if (kind === "switch") { const list = F.accounts[a]; const prev = list.find((x) => x.active); list.forEach((x) => { x.active = x.id === b; }); toast(`Future launches use ${list.find((x) => x.active).label}`, "running conversations keep their account", { label: "Switch back", act: `switch:${a}:${prev.id}` }); return; }
    if (kind === "signIn") { toast("Device sign-in opened", "the account becomes active only after it returns"); return; }
    if (kind === "refresh") { toast("Refreshed", `checked ${F.now}`); return; }
    if (kind === "useReset") { const acc = b ? F.accounts[a].find((x) => x.id === b) : F.accounts[a].find((x) => x.active); if (!acc || !acc.windows.length) return; const w = acc.windows[0]; w.left = 100; w.elapsed = 0; w.series = [[0, 100]]; toast("Used one reset", `the ${w.label} window is full again`); return; }
    if (kind === "addAccount") { toast("Add an account", "opens the device sign-in"); return; }
    if (kind === "killHost") { const i = F.hosts.findIndex((x) => x.pid === Number(a)); const h = F.hosts[i]; if (i >= 0) F.hosts.splice(i, 1); toast(`Killed ${h ? h.name : a}`, `pid ${a}`); return; }
    if (kind === "archiveProject") { closeDialog(); const p = S.project; S.archivedProjects.add(p); go("#/overview", { replace: true }); toast(`Archived ${projectName(p)}`, "it stays in the rail's Archive", { label: "Restore", act: `restoreProject:${p}` }); return; }
    if (kind === "restoreProject") { S.archivedProjects.delete(a); S.deletedProjects.delete(a); toast(`Restored ${projectName(a)}`); return; }
    if (kind === "deleteProject") { closeDialog(); const p = S.project; S.deletedProjects.add(p); go("#/overview", { replace: true }); toast(`Deleted ${projectName(p)}`, "conversations stay on disk for 4 s of regret", { label: "Restore", act: `restoreProject:${p}` }); return; }
    if (kind === "createProject") { toast("Create project", "name and root directory, then it appears in the rail"); return; }
    if (kind === "newTask") { const d = S.newTask || {}; const t = { id: `t${F.tasks.length + 1}`, title: (d.title || "New task").trim() || "New task", status: d.status || "planned" }; F.tasks.unshift(t); S.newTask = null; if (isDialog(hashOf())) closeDialog(); S.view = "kanban"; go("#/kanban", { replace: true }); toast("Task created", "give it a worker or a pipeline and the card becomes a thread"); return; }
    if (kind === "moveTask") { const t = F.tasks.find((x) => x.id === a); if (!t) return; const from = taskStatus(t); if (from === b) return render(); S.taskStatus[t.id] = b; toast(`Moved to ${KCOLS.find((k) => k[0] === b)[1]}`, `${t.title}`, { label: "Undo", act: `moveTask:${a}:${from}` }); return; }
    if (kind === "openArrival") { const id = S.arrival.id; S.seen.add(id); S.arrival = null; return go(`#/chat/${id}`); }
    if (kind === "dismissArrival") { S.arrivalDismissed = true; return render(); }
    if (kind === "predecessor") { toast("Predecessor", "opens the previous seat's conversation"); return; }
    if (kind === "rotateSeat" || kind === "createSeat") { const d = S.rotate; F.seat.state = "live"; F.seat.engine = d.engine; F.seat.model = d.model; F.seat.effort = d.effort; F.seat.mandate = d.mandate; F.seat.mandateVersion += 1; F.seat.since = "now"; F.seat.ctx = { left: 100, window: "100k" }; F.seat.predecessor = kind === "rotateSeat"; let sc = seatConv(); if (!sc) { sc = { id: "orch", project: S.project === "all" ? "atlas" : S.project, title: `Orchestrator · ${projectName(S.project === "all" ? "atlas" : S.project)}`, engine: d.engine, model: d.model, effort: d.effort, account: "Main", state: "working", elapsed: "0:01", age: "now", seat: true, ctx: 0, feed: [] }; F.conversations.unshift(sc); } else { sc.engine = d.engine; sc.model = d.model; sc.effort = d.effort; sc.feed.push({ kind: "agent", ts: F.now, text: `Seat taken. Mandate v${F.seat.mandateVersion} loaded; predecessor context handed over.` }); } S.rotate = null; go("#/seat", { replace: true }); toast(kind === "rotateSeat" ? "Rotated the orchestrator" : "Created the orchestrator", `${d.model} · ${d.effort} · mandate v${F.seat.mandateVersion}`); return; }
    if (kind === "startAgent") { const d = S.newAgent; const nc = { id: `n${F.conversations.length}`, project: S.project === "all" ? "atlas" : S.project, title: (d.prompt || "New conversation").split("\n")[0].slice(0, 60) || "New conversation", engine: d.engine, model: d.model, effort: d.effort, account: F.accounts[d.engine].find((x) => x.id === d.account)?.label || "Main", state: "working", elapsed: "0:01", age: "now", ctx: 1, feed: d.prompt ? [{ kind: "user", ts: F.now, text: d.prompt }] : [] }; F.conversations.push(nc); S.newAgent = null; go(`#/chat/${nc.id}`, { replace: true }); toast("Conversation started", `${nc.model} · ${nc.effort} · ${nc.account}`, { label: "Kill", act: `kill:${nc.id}` }); return; }
    if (kind === "np") { if (a === "template") { const t = Number(b); const tpl = [["plan", "build", "review"], ["build", "review"], ["build", "verify"], []][t]; const roles = { plan: "architect", build: "builder", review: "reviewer", verify: "builder" }; const id = `np${F.pipelines.length}`; const stages = tpl.map((sid, i) => ({ id: sid, role: roles[sid], engine: sid === "review" || sid === "plan" ? "claude" : "codex", model: sid === "review" || sid === "plan" ? "Opus" : "gpt-5.6", effort: sid === "review" ? "xhigh" : "high", access: sid === "review" || sid === "plan" ? "read-only" : "read-write", sandbox: sid === "review" ? "restricted" : "full", outputs: [], next: tpl[i + 1] || null, onFail: sid === "review" ? { to: "build", maxRounds: 3 } : null, attempts: [], prompt: "{{task}}" })); F.pipelines.push({ id, project: S.project === "all" ? "atlas" : S.project, task: "New pipeline · name the task", state: "draft", revision: 0, started: null, branch: null, lastEdit: null, cursor: { stageId: stages[0]?.id || "", attempt: 0 }, stages, findings: [], notes: [], checkpoints: [], mutations: [], waiting: null }); go(`#/pipeline/${id}`, { replace: true }); toast("Draft pipeline created", "edit the stages, then Start"); } return; }
    if (kind === "pa") return pipelineAct(a, b, c);
    if (kind === "na" || kind === "ro" || kind === "ed" || kind === "nt") {
      const target = kind === "na" ? (S.newAgent || (S.newAgent = {})) : kind === "ro" ? (S.rotate || (S.rotate = {})) : kind === "nt" ? (S.newTask || (S.newTask = {})) : (S.editorDraft || (S.editorDraft = {}));
      const key = a; let value = name.slice(kind.length + a.length + 2);
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) value = el.value;
      target[key] = value === "toggle" ? !target[key] : value;
      if (key === "engine") { target.model = MODELS[value][0]; target.account = F.accounts[value].find((x) => x.auth === "Authenticated").id; }
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox") return;
      return render();
    }
  }

  /* ── events ────────────────────────────────────────────────────────────── */
  $app.addEventListener("click", (e) => {
    /* The click that ends a drag is not a click on the thing dragged. */
    if (S.dragMoved) { e.preventDefault(); return; }
    const t = e.target.closest("[data-go], [data-act], [data-scrim]");
    if (!t) return;
    if (t.hasAttribute("data-scrim") && t === e.target) { closeDialog(); return; }
    if (t.dataset.go) {
      e.preventDefault();
      if (t.dataset.project) { S.project = t.dataset.project; S.view = null; }
      const goTo = t.dataset.go;
      if (goTo === "#/board" && S.project === "all") { S.project = t.dataset.project || "atlas"; }
      if (isDialog(hashOf()) && !isDialog(goTo)) history.replaceState({}, "", goTo);
      go(goTo, { trigger: goTo });
      return;
    }
    if (t.dataset.act) { e.preventDefault(); act(t.dataset.act, t); }
  });
  /* Dragging: a kanban card between columns, a map group to a place of its
     own. Mouse events, not the HTML5 drag API, so the same gesture works for
     the operator and for the headless run that proves it. */
  document.addEventListener("mousedown", (e) => {
    const handle = e.target.closest("[data-drag]"); if (!handle || e.button !== 0) return;
    const card = handle.closest("[data-card]"); const item = handle.closest(".mapitem");
    if (!card && !item) return;
    const box = (item || card).getBoundingClientRect();
    S.drag = { id: handle.dataset.drag, kind: card ? "task" : "map", el: item || card, dx: e.clientX - box.left, dy: e.clientY - box.top, over: null, moved: false };
    if (item) item.classList.add("dragging");
  });
  document.addEventListener("mousemove", (e) => {
    const d = S.drag; if (!d) return;
    if (!d.moved) { if (Math.abs(e.movementX) + Math.abs(e.movementY) === 0) return; d.moved = true; }
    if (d.kind === "map") {
      const world = $app.querySelector(".world"); if (!world) return;
      const wr = world.getBoundingClientRect();
      d.el.style.left = `${Math.max(0, e.clientX - wr.left - d.dx)}px`;
      d.el.style.top = `${Math.max(0, e.clientY - wr.top - d.dy)}px`;
    } else {
      const col = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-col]");
      const next = col ? col.dataset.col : null;
      if (next !== d.over) { d.over = next; for (const k of $app.querySelectorAll("[data-col]")) k.classList.toggle("over", k.dataset.col === next); }
    }
  });
  document.addEventListener("mouseup", () => {
    const d = S.drag; if (!d) return; S.drag = null;
    if (!d.moved) { d.el.classList.remove("dragging"); return; }
    S.dragMoved = true;
    setTimeout(() => { S.dragMoved = false; }, 0);
    if (d.kind === "map") {
      const world = $app.querySelector(".world"); const wr = world.getBoundingClientRect(); const er = d.el.getBoundingClientRect();
      S.pins[d.id] = { x: Math.round(er.left - wr.left), y: Math.round(er.top - wr.top) };
      d.el.classList.remove("dragging");
      const p = pipe(d.id);
      toast("Pinned where you put it", `${p ? p.task : d.id} · the rest flows around it`, { label: "Release", act: `unpinItem:${d.id}` });
    } else if (d.over) act(`moveTask:${d.id}:${d.over}`);
    else render();
  });
  $app.addEventListener("input", (e) => {
    const t = e.target; if (!t.dataset) return;
    if (t.dataset.act === "filter") { S.filter = t.value; S.hl = -1; return render(); }
    if (t.dataset.act === "projFilter") { S.projFilter = t.value; return render(); }
    if (t.dataset.act === "search") { S.search = t.value; return render(); }
    if (t.dataset.focus === "field" || t.dataset.focus === "pin-field") { const cv = $app.querySelector(t.dataset.focus === "field" ? ".stage .chat" : ".pin .chat"); const id = cv && cv.dataset.conv; if (!id) return; const was = Boolean(S.drafts[id]); S.drafts[id] = t.value; if (was !== Boolean(t.value)) render(); return; }
    if (t.dataset.act && /^(na|ro|ed|nt):/.test(t.dataset.act)) act(t.dataset.act, t);
  });
  $app.addEventListener("change", (e) => { const t = e.target; if (t.dataset && t.dataset.act && /^(na|ro|ed|nt):/.test(t.dataset.act) && (t.tagName === "SELECT" || t.type === "checkbox")) act(t.dataset.act, t); });

  const typing = (el) => el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
  document.addEventListener("keydown", (e) => {
    root.classList.add("kb");
    const dlg = $app.querySelector("[data-dialog]");
    const s = segs();
    if (e.key === "Escape") {
      if (dlg) { e.preventDefault(); closeDialog(); return; }
      /* Escape from an account detail returns to the accounts stage with the
         focus on the row that opened it. */
      if (s[0] === "accounts" && s[1] && s[2]) { e.preventDefault(); const back = `#/accounts/${s[1]}/${s[2]}`; go("#/accounts", { replace: true }); const row = $app.querySelector(`[data-go="${back}"]`); if (row) { row.focus(); row.scrollIntoView({ block: "nearest" }); } return; }
      if (typing(e.target) && e.target.dataset.act === "filter" && S.filter) { e.preventDefault(); S.filter = ""; render(); escapeToColumn(); return; }
      /* Escape is the bridge: from any field or control inside the stage back
         to the column's current row, where the single keys live. */
      if (typing(e.target) || e.target.closest(".stage, .pin")) { e.preventDefault(); escapeToColumn(); return; }
      return;
    }
    if (dlg && e.key === "Tab") {
      const f = [...dlg.querySelectorAll("button, input, textarea, select, [tabindex]")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return; const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (dlg && (e.key === "ArrowDown" || e.key === "ArrowUp") && hashOf() === "#/board/search") { e.preventDefault(); const rows = [...dlg.querySelectorAll(".search-rows .srow")]; const i = rows.indexOf(document.activeElement); const n = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1); rows[n]?.focus(); return; }
    if (typing(e.target)) {
      if (e.target.dataset.focus === "field" || e.target.dataset.focus === "pin-field") { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const slot = $app.querySelector(`[data-focus="${e.target.dataset.focus === "field" ? "send" : "pin-send"}"]`); if (slot && !slot.classList.contains("stop")) act(slot.dataset.act, slot); } return; }
      if (e.target.dataset.act === "filter") { const rows = columnRows(); if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); S.hl = e.key === "ArrowDown" ? Math.min(rows.length - 1, S.hl + 1) : Math.max(0, S.hl - 1); rows.forEach((r, i) => r.classList.toggle("on", i === S.hl)); rows[S.hl]?.scrollIntoView({ block: "nearest" }); } else if (e.key === "Enter") { e.preventDefault(); const r = rows[S.hl >= 0 ? S.hl : 0]; if (r) r.click(); } return; }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    /* 1–9 pick a question option while its card is open. */
    if (/^[1-9]$/.test(e.key)) { const opt = $app.querySelector(`.stage .q:not(.quiet) .opt[data-opt="${Number(e.key) - 1}"]`); if (opt) { e.preventDefault(); opt.click(); return; } }
    const rows = columnRows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const i = rows.indexOf(document.activeElement); const n = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1); rows[n]?.focus(); rows[n]?.scrollIntoView({ block: "nearest" }); return; }
    if (e.key === "Enter" && rows.includes(document.activeElement)) { e.preventDefault(); document.activeElement.click(); return; }
    if (e.key === "n" || e.key === "N") { const a = S.project === "all" ? attentionAll() : attention(); if (!a.length) return; e.preventDefault(); const cur = a.findIndex((x) => x.go === hashOf()); S.cycle = cur >= 0 ? cur : S.cycle; S.cycle = ((S.cycle + (e.key === "n" ? 1 : -1)) + a.length) % a.length; const item = a[S.cycle]; if (S.project === "all" && item.project) S.project = item.project; go(item.go); return; }
    if (e.key === "/") { e.preventDefault(); go("#/board/search", { trigger: "#/board/search" }); return; }
    if (e.key === "o") { e.preventDefault(); const sc = seatConv(); go(sc ? "#/chat/orch" : "#/seat/rotate"); return; }
    if (e.key === "i") { const f = $app.querySelector('.stage [data-focus="field"]'); if (f) { e.preventDefault(); f.focus(); } return; }
    if (e.key === "k") { e.preventDefault(); act("view:kanban"); return; }
    if (e.key === "m") { e.preventDefault(); act(effectiveView() === "map" ? "view:list" : "view:map"); return; }
    if (e.key === "a") { e.preventDefault(); go("#/accounts"); return; }
    if (e.key === "p") { e.preventDefault(); go("#/pipelines"); return; }
    if (e.key === "t") { e.preventDefault(); act("view:kanban"); return; }
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
    const sel2 = document.getElementById("bench-w"); if (sel2) sel2.value = String(w);
  }
  const scheme = params.get("scheme"); if (scheme === "dark" || scheme === "light") root.dataset.theme = scheme;
  const sSel = document.getElementById("bench-scheme"); if (sSel) { sSel.value = scheme || ""; sSel.onchange = () => { params.set("scheme", sSel.value); if (!sSel.value) params.delete("scheme"); location.search = params.toString(); }; }
  const wSel = document.getElementById("bench-w"); if (wSel) wSel.onchange = () => { params.set("w", wSel.value); location.search = params.toString(); };
  const scSel = document.getElementById("bench-scenario"); if (scSel) { scSel.value = scenario || ""; scSel.onchange = () => { if (scSel.value) params.set("scenario", scSel.value); else params.delete("scenario"); location.search = params.toString(); }; }
  applyFrame();
  if (params.get("rail") === "0") S.rail = false;
  if (params.get("rail") === "1") S.rail = true;
  if (!location.hash) history.replaceState({}, "", "#/board");
  render();
  addEventListener("resize", () => { applyFrame(); layoutMap(); });
  window.__proto = { S, F, render, go, act, attention, counts, layoutMap };
})();
