/* desktop-v2 prototype (issue #1453, rewrite) — the yard.
   No framework. One state object, one render, a camera that never re-renders.
   Read docs/design/desktop-v2/README.md for what each surface is. */
(function () {
  "use strict";
  const F0 = window.FIXTURE;
  const $app = document.getElementById("app");
  const $bench = document.getElementById("bench");
  const $frame = document.getElementById("frame");

  /* ── query, scheme, scenario ─────────────────────────────────────────── */
  const Q = new URLSearchParams(location.search);
  const scheme = Q.get("scheme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = scheme;
  const FRAME_W = Number(Q.get("w") || 1440);
  const FRAME_H = { 1280: 800, 1440: 900, 1920: 1080 }[FRAME_W] || 900;
  const scenario = Q.get("scenario") || "";
  const F = JSON.parse(JSON.stringify(F0));
  if (scenario && F0.scenarios[scenario]) F0.scenarios[scenario](F);

  /* ── state ────────────────────────────────────────────────────────────── */
  const S = {
    project: F.project,
    rail: Q.get("rail") === "1" ? 1 : 0,
    pins: Object.assign({}, F.pins || {}),
    selected: Q.get("select") || null,
    lift: Q.get("lift") || null,
    tray: Q.get("tray") === "1",
    killed: new Set(F.killed || []),
    answered: {},
    seen: new Set(),
    dismissed: false,
    receipt: null,
    drafts: {},
    settings: {},
    editing: null,
    cams: {},
    focusKey: null,
    trigger: null,
    arrival: F.arrival || null,
  };
  const NEEDS = new Set(["waiting", "stalled", "limit", "held", "killed"]);

  /* ── helpers ──────────────────────────────────────────────────────────── */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const conv = (id) => F.conversations.find((c) => c.id === id);
  const pipe = (id) => F.pipelines.find((p) => p.id === id);
  const task = (id) => F.tasks.find((t) => t.id === id);
  const project = (id) => F.projects.find((p) => p.id === id);
  const projectName = (id) => (project(id) || { name: id }).name;
  const hueOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return (h * 7 + 20) % 360; };
  const hhmm = (mins) => { const m = ((Math.round(mins) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

  const ICONS = {
    chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    check: '<path d="m5 12 5 5L20 7"/>', crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>', grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    sparkle: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/>',
    command: '<path d="M15 6a3 3 0 1 1 3 3h-3V6zM9 6a3 3 0 1 0-3 3h3V6zM15 18a3 3 0 1 0 3-3h-3v3zM9 18a3 3 0 1 1-3-3h3v3z"/><path d="M9 9h6v6H9z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>', pin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 14v7"/>',
    pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="M7 4v16l13-8L7 4z"/>', skip: '<path d="M5 5v14l9-7-9-7z"/><path d="M19 5v14"/>',
    bot: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M12 9V5"/><path d="M9 14h.01M15 14h.01"/><path d="M2 14h2M20 14h2"/>',
    tool: '<path d="M14.5 4.5a5 5 0 0 0-6 6.3L3 16.3V21h4.7l5.5-5.5a5 5 0 0 0 6.3-6l-3 3-3-1-1-3 3-3z"/>',
    open: '<path d="M14 5h5v5"/><path d="M19 5l-9 9"/><path d="M19 13v6H5V5h6"/>', undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6l2-8z"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>', refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 17h7"/>', compress: '<path d="M4 14h5v5M20 10h-5V5M9 14l-5 5M15 10l5-5"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>', key: '<path d="M7 14a4 4 0 1 1 4-4l9-9"/><path d="m17 4 3 3"/><path d="m14 7 3 3"/>',
  };
  const I = (name, cls) => `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const mark = (engine, cls) => `<span class="mark ${engine} ${cls || ""}">${I(engine === "codex" ? "command" : "sparkle")}</span>`;
  const badge = (text, tone) => `<span class="badge ${tone || ""}">${esc(text)}</span>`;
  const meter = (left, extra) => `<span class="meter ${left <= 10 ? "low" : left <= 30 ? "warn" : ""} ${extra || ""}"><i style="width:${clamp(left, 0, 100)}%"></i></span>`;
  const keycap = (n) => (n ? `<kbd class="keycap">${n}</kbd>` : "");

  /* One state function, the mobile-v2 one: one word per conversation, one
     precedence: killed > stalled > limit > held > waiting > working > returned > done. */
  function stateBits(c) {
    if (S.killed.has(c.id)) return { key: "killed", dot: "stall", phrase: "killed · messages queue", badge: "killed", tone: "b-danger", edge: "stall" };
    if (c.stalled) return { key: "stalled", dot: "stall", phrase: `stalled · ${c.stalled}`, badge: "stalled", tone: "b-danger", edge: "stall" };
    if (c.limit) return { key: "limit", dot: "wait", phrase: `limit · ${c.limit.account} resets ${c.limit.resets}`, badge: "limit", tone: "b-warning", edge: "wait" };
    if (c.held) return { key: "held", dot: "wait", phrase: `held · ${c.held} messages queue`, badge: "held", tone: "b-warning", edge: "wait" };
    if (c.state === "waiting" && !S.answered[c.id]) return { key: "waiting", dot: "wait", phrase: `${c.decision} · ${c.since}`, badge: c.decision, tone: "b-warning", edge: "wait" };
    if (c.state === "working" || S.answered[c.id]) return { key: "working", dot: "live", phrase: `working ${c.elapsed || "0:12"}`, tone: "b-success" };
    if (c.state === "returned") return { key: "returned", dot: "acc", phrase: `finished the turn · ${c.age}`, tone: "" };
    return { key: "done", dot: "", phrase: `done · ${c.age || ""}`.replace(/ · $/, ""), tone: "" };
  }
  const shortTool = (name) => name.split(" ").map((w) => (w.includes("/") ? w.split("/").pop() : w)).join(" ").replace(/^viewer · /, "");
  function nowFragment(c) {
    if (c.tool && stateBits(c).key === "working") return shortTool(c.tool);
    const last = [...(c.feed || [])].reverse().find((i) => i.kind === "agent");
    return last ? last.text.split("\n")[0].slice(0, 70) : "";
  }
  const pipeBits = (p) => ({
    running: { phrase: "running", tone: "b-accent" }, needs_decision: { phrase: "needs a decision", tone: "b-warning" }, draft: { phrase: "draft", tone: "" },
    completed: { phrase: "completed", tone: "b-success" }, paused: { phrase: "paused", tone: "" }, provisioning: { phrase: "starting", tone: "b-accent" },
  })[p.state] || { phrase: p.state, tone: "" };
  const stageIndex = (p, id) => p.stages.findIndex((s) => s.id === id) + 1;
  const lastAttempt = (s) => s.attempts[s.attempts.length - 1] || null;
  const roundsUsed = (p, s) => p.stages.filter((x) => x.onFail && x.onFail.to === s.id).reduce((n, x) => n + x.attempts.filter((a) => a.state === "failed").length, 0);

  /* ── routing ──────────────────────────────────────────────────────────── */
  const DIALOGS = ["search", "create", "menu", "host", "rotate", "keys", "settings"];
  const hashOf = () => location.hash || "#/board";
  function route() {
    const parts = hashOf().replace(/^#\//, "").split("/");
    const last = parts[parts.length - 1];
    const dialog = DIALOGS.includes(last) && parts.length > 1 ? last : null;
    if (dialog) parts.pop();
    const [screen, a, b] = parts;
    if (screen === "chat") return { screen: "chat", id: a, dialog, base: `#/chat/${a}` };
    if (screen === "accounts") return { screen: "accounts", engine: a, id: b, dialog, base: a ? `#/accounts/${a}/${b}` : "#/accounts" };
    if (screen === "overview") return { screen: "field", dialog, base: "#/overview" };
    return { screen: "board", dialog, base: "#/board" };
  }
  function go(hash, replace) {
    if (replace) { history.replaceState(null, "", hash); render(); }
    else location.hash = hash;
  }
  function closeDialog() {
    const r = route();
    S.focusKey = S.trigger; S.trigger = null;
    go(r.base, true);
  }

  /* ── clusters ─────────────────────────────────────────────────────────── */
  const NW = 200, NH = 88, GAP = 22, HEAD = 44, PAD = 14, MINH = 152, GX = 36, GY = 36;
  const MIN_Z = 0.3, MAX_Z = 2;

  function clustersOf(projectId) {
    const convs = F.conversations.filter((c) => c.project === projectId);
    const byId = new Map(convs.map((c) => [c.id, c]));
    const kids = (id) => convs.filter((c) => c.parent === id);
    const descendants = (id) => { const out = []; const walk = (x) => { for (const k of kids(x)) { out.push(k); walk(k.id); } }; walk(id); return out; };
    const claimed = new Set();
    const list = [];
    const nodeOf = (c) => ({ id: c.id, conv: c });
    const seat = F.seats[projectId];
    if (seat) {
      const c = byId.get(seat.conv);
      if (c) { claimed.add(c.id); list.push({ id: "seat", kind: "seat", title: "Orchestrator", seat, nodes: [nodeOf(c)], root: c }); }
    }
    for (const p of F.pipelines.filter((p) => p.project === projectId)) {
      for (const s of p.stages) for (const a of s.attempts) if (a.conv) { claimed.add(a.conv); for (const d of descendants(a.conv)) claimed.add(d.id); }
      const nodes = p.stages.map((s, i) => { const a = lastAttempt(s); const c = a && a.conv ? byId.get(a.conv) : null; return { id: `${p.id}:${s.id}`, stage: s, index: i, attempt: a, conv: c || null }; });
      list.push({ id: p.id, kind: "pipeline", pipe: p, task: p.taskId ? task(p.taskId) : null, title: p.task, nodes });
    }
    for (const t of F.tasks.filter((t) => t.project === projectId && t.worker && !t.pipeline)) {
      const c = byId.get(t.worker);
      if (!c || claimed.has(c.id)) continue;
      const ds = descendants(c.id);
      [c, ...ds].forEach((x) => claimed.add(x.id));
      list.push({ id: `t:${t.id}`, kind: "thread", task: t, title: c.title, root: c, nodes: [nodeOf(c), ...ds.map(nodeOf)] });
    }
    for (const c of convs) {
      if (claimed.has(c.id) || (c.parent && byId.has(c.parent))) continue;
      const ds = descendants(c.id);
      [c, ...ds].forEach((x) => claimed.add(x.id));
      list.push({ id: `c:${c.id}`, kind: "tree", title: c.title, root: c, nodes: [nodeOf(c), ...ds.map(nodeOf)] });
    }
    for (const cl of list) decorate(cl);
    list.sort((a, b) => (a.kind === "seat" ? -1 : b.kind === "seat" ? 1 : a.rank - b.rank));
    let n = 0;
    for (const cl of list) if (cl.kind !== "seat" && n < 9) cl.key = ++n;
    return list;
  }
  function decorate(cl) {
    const convs = cl.nodes.map((n) => n.conv).filter(Boolean);
    const bits = convs.map(stateBits);
    cl.needs = bits.some((b) => NEEDS.has(b.key)) || (cl.kind === "pipeline" && cl.pipe.state === "needs_decision");
    cl.running = bits.some((b) => b.key === "working") || (cl.kind === "pipeline" && (cl.pipe.state === "running" || cl.pipe.state === "provisioning"));
    cl.returned = bits.some((b) => b.key === "returned");
    cl.hue = cl.kind === "seat" ? 248 : hueOf(cl.id);
    if (cl.kind === "pipeline") {
      const p = cl.pipe; const pb = pipeBits(p);
      cl.quiet = ["draft", "completed", "closed", "paused"].includes(p.state);
      cl.phrase = cl.quiet ? pb.phrase : `${stageIndex(p, p.stage)}/${p.stages.length} ${p.stage} · ${pb.phrase}`;
      cl.badge = cl.needs ? { text: "needs a decision", tone: "b-warning" } : cl.quiet ? { text: pb.phrase, tone: pb.tone } : { text: `${stageIndex(p, p.stage)}/${p.stages.length} ${p.stage}`, tone: "b-accent" };
    } else {
      const rb = stateBits(cl.root);
      cl.quiet = !cl.needs && !cl.running && !cl.returned;
      cl.phrase = rb.phrase;
      const needy = bits.find((b) => NEEDS.has(b.key));
      cl.badge = needy ? { text: needy.badge, tone: needy.tone } : cl.running ? { text: "working", tone: "b-success" } : cl.returned ? { text: "finished the turn", tone: "b-accent" } : { text: "done", tone: "" };
    }
    cl.rank = cl.needs ? 0 : cl.running ? 1 : cl.returned ? 2 : 3;
    const sz = sizeOf(cl); cl.w = sz.w; cl.h = sz.h; cl.compact = Boolean(sz.compact);
  }
  function sizeOf(cl) {
    if (cl.kind === "seat") return { w: 352, h: HEAD + PAD * 2 + NH };
    if (cl.kind === "pipeline") {
      if (cl.quiet) return { w: 320, h: MINH, compact: true };
      const n = cl.nodes.length; const loops = cl.pipe.stages.filter((s) => s.onFail).length;
      return { w: PAD * 2 + n * NW + (n - 1) * GAP, h: HEAD + PAD + NH + (loops ? 14 + loops * 18 : 0) + PAD };
    }
    const k = cl.nodes.length - 1;
    return { w: PAD * 2 + Math.max(NW, k * NW + Math.max(0, k - 1) * GAP), h: HEAD + PAD + NH + (k ? GAP + NH : 0) + PAD };
  }
  /* The auto layout: a shelf packer over clusters in priority order, the world
     shaped to the viewport's aspect; a pinned cluster keeps the place the
     operator put it and the flow opens around it. Deterministic, no physics. */
  function pack(clusters, pins, aspect) {
    const area = clusters.reduce((s, c) => s + (c.w + GX) * (c.h + GY), 0);
    const maxW = clamp(Math.sqrt(area * aspect) * 1.12, 1500, 6000);
    const pinned = clusters.filter((c) => pins[c.id]).map((c) => ({ x: pins[c.id].x, y: pins[c.id].y, w: c.w, h: c.h }));
    const hits = (r) => pinned.find((p) => r.x < p.x + p.w + GX && p.x < r.x + r.w + GX && r.y < p.y + p.h + GY && p.y < r.y + r.h + GY);
    let x = 0, y = 0, rowH = 0;
    for (const c of clusters) {
      if (pins[c.id]) { c.x = pins[c.id].x; c.y = pins[c.id].y; c.pinned = true; continue; }
      c.pinned = false;
      for (let guard = 0; guard < 60; guard++) {
        if (x > 0 && x + c.w > maxW) { x = 0; y += (rowH || MINH) + GY; rowH = 0; }
        const hit = hits({ x, y, w: c.w, h: c.h });
        if (!hit) break;
        x = hit.x + hit.w + GX;
      }
      c.x = x; c.y = y; x += c.w + GX; rowH = Math.max(rowH, c.h);
    }
    return maxW;
  }
  function bbox(rects) {
    if (!rects.length) return { x: 0, y: 0, w: 800, h: 500 };
    const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /* Current board model (rebuilt on every render that shows a board). */
  let M = { clusters: [], world: { x: 0, y: 0, w: 1, h: 1 }, backlog: [], regions: null };
  function buildModel(screen) {
    const aspect = boardAspect();
    if (screen === "field") {
      const regions = F.projects.filter((p) => !p.archived).map((p) => {
        const clusters = clustersOf(p.id);
        pack(clusters, {}, 1.4);
        const b = bbox(clusters);
        return { id: p.id, project: p, clusters, w: Math.max(420, b.w + 2 * PAD), h: b.h + HEAD + 2 * PAD, needs: clusters.filter((c) => c.needs).length, working: counts(p.id).working };
      });
      regions.sort((a, b) => (b.needs - a.needs) || (b.working - a.working));
      pack(regions, {}, aspect);
      const world = bbox(regions);
      for (const r of regions) for (const c of r.clusters) c.key = null;
      M = { clusters: regions.flatMap((r) => r.clusters.map((c) => ({ ...c, x: c.x + r.x + PAD, y: c.y + r.y + HEAD + PAD, region: r.id }))), regions, world: { x: world.x - 80, y: world.y - 80, w: world.w + 160, h: world.h + 160 }, backlog: [] };
      return;
    }
    const clusters = clustersOf(S.project);
    pack(clusters, S.pins, aspect);
    const world = bbox(clusters);
    const backlog = F.tasks.filter((t) => t.project === S.project && !t.worker && !t.pipeline && t.status !== "done");
    M = { clusters, world: { x: world.x - 80, y: world.y - 80, w: world.w + 160, h: world.h + 160 }, backlog, regions: null };
  }
  const clusterById = (id) => M.clusters.find((c) => c.id === id);
  const clusterOfConv = (id) => M.clusters.find((c) => c.nodes.some((n) => n.conv && n.conv.id === id));
  function counts(projectId) {
    const convs = F.conversations.filter((c) => c.project === projectId && !c.seat);
    const bits = convs.map(stateBits);
    const pipes = F.pipelines.filter((p) => p.project === projectId);
    return {
      needs: bits.filter((b) => NEEDS.has(b.key)).length + pipes.filter((p) => p.state === "needs_decision").length,
      working: bits.filter((b) => b.key === "working").length,
      pipelines: pipes.filter((p) => ["running", "needs_decision", "provisioning", "paused"].includes(p.state)).length,
    };
  }
  /* Everything that needs the operator, in yard order: what n / N walk. */
  function needsQueue(projectId) {
    const out = [];
    for (const cl of clustersOf(projectId)) {
      if (!cl.needs) continue;
      if (cl.kind === "pipeline" && cl.pipe.state === "needs_decision") out.push({ cluster: cl.id, kind: "pipeline" });
      for (const n of cl.nodes) if (n.conv && NEEDS.has(stateBits(n.conv).key)) out.push({ cluster: cl.id, kind: "conv", conv: n.conv.id });
    }
    return out;
  }

  /* ── camera ───────────────────────────────────────────────────────────── */
  const cam = { x: 0, y: 0, z: 0.5 };
  let altitude = "yard";
  function boardEl() { return $app.querySelector("[data-board]"); }
  function boardSize() { const b = boardEl(); return b ? { w: b.clientWidth, h: b.clientHeight } : { w: FRAME_W - 56, h: FRAME_H - 88 }; }
  /* The packer's aspect is the frame's, never the live board's: a receipt row
     or an open inspector must not re-pack the yard under the operator. */
  function boardAspect() { const side = FRAME_W >= 1400 ? 372 : 312; const rail = S.rail ? 224 : 56; return (FRAME_W - rail - side) / Math.max(1, FRAME_H - 48 - 44); }
  function fitRect(r, pad, zmax, animate) {
    const { w, h } = boardSize();
    const z = clamp(Math.min((w - pad * 2) / r.w, (h - pad * 2) / r.h), MIN_Z, zmax);
    setCam((w - r.w * z) / 2 - r.x * z, (h - r.h * z) / 2 - r.y * z, z, animate);
  }
  function fitAll(animate) { fitRect(M.world, 8, 1, animate); }
  function fitNeeds(animate) { const rs = M.clusters.filter((c) => c.needs); if (!rs.length) return fitAll(animate); fitRect(bbox(rs), 60, 0.9, animate); }
  function fitCluster(id, animate) { const c = clusterById(id); if (!c) return; fitRect({ x: c.x - 40, y: c.y - 40, w: c.w + 80, h: c.h + 80 }, 40, 1.1, animate); }
  function centerOn(wx, wy, z, animate) { const { w, h } = boardSize(); setCam(w / 2 - wx * z, h / 2 - wy * z, z, animate); }
  function setCam(x, y, z, animate) {
    cam.x = x; cam.y = y; cam.z = clamp(z, MIN_Z, MAX_Z);
    const world = $app.querySelector(".world");
    if (world) world.style.transition = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "transform 360ms cubic-bezier(.2,0,0,1)" : "none";
    applyCamera();
  }
  /* The camera writes exactly four things and never re-renders: the world's
     transform, the grid's tile, the altitude attribute and the corner map. */
  function applyCamera() {
    const board = boardEl(); if (!board) return;
    const world = board.querySelector(".world");
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    world.style.setProperty("--inv", String(clamp(1 / cam.z, 1, 3.4)));
    let tile = 24 * cam.z; while (tile < 18) tile *= 2;
    const grid = board.querySelector(".grid");
    grid.style.backgroundSize = `${tile}px ${tile}px`;
    grid.style.backgroundPosition = `${((cam.x % tile) + tile) % tile}px ${((cam.y % tile) + tile) % tile}px`;
    const next = altitude === "yard" ? (cam.z > 0.9 ? "block" : "yard") : (cam.z < 0.8 ? "yard" : "block");
    if (next !== altitude) { altitude = next; board.dataset.altitude = altitude; }
    const label = $app.querySelector("[data-altitude-label]");
    if (label) label.textContent = `${route().screen === "field" ? "Field" : altitude === "yard" ? "Yard" : "Block"} · ${Math.round(cam.z * 100)}%`;
    drawMinimapViewport();
    drawBeacons();
    if (route().screen === "board") S.cams[S.project] = { ...cam };
  }
  function worldToScreen(x, y) { return { x: x * cam.z + cam.x, y: y * cam.z + cam.y }; }
  function screenToWorld(x, y) { return { x: (x - cam.x) / cam.z, y: (y - cam.y) / cam.z }; }

  /* ── board interaction ────────────────────────────────────────────────── */
  let suppressClick = false;
  function mountBoard() {
    const board = boardEl(); if (!board) return;
    board.dataset.altitude = altitude;
    let drag = null;
    board.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const head = e.target.closest(".cl-head, .tile");
      const clEl = e.target.closest(".cluster");
      if (head && clEl && route().screen === "board") {
        const c = clusterById(clEl.dataset.cluster); if (!c) return;
        drag = { kind: "cluster", id: c.id, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, el: clEl, moved: false };
        board.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
      if (e.target.closest(".node, .lifted, [data-act], [data-go]")) return;
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: cam.x, oy: cam.y, moved: false };
      board.setPointerCapture(e.pointerId);
    });
    board.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.kind === "pan") { setCam(drag.ox + dx, drag.oy + dy, cam.z, false); board.classList.add("panning"); }
      else { const nx = drag.ox + dx / cam.z, ny = drag.oy + dy / cam.z; drag.el.style.left = `${nx}px`; drag.el.style.top = `${ny}px`; drag.nx = nx; drag.ny = ny; }
    });
    const end = (e) => {
      if (!drag) return;
      board.classList.remove("panning");
      const d = drag; drag = null;
      if (d.kind === "cluster" && d.moved) {
        suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
        S.pins[d.id] = { x: Math.round(d.nx), y: Math.round(d.ny) };
        const c = clusterById(d.id);
        receipt(`${c.title} pinned where you put it`, "Release", () => { delete S.pins[d.id]; render(); });
        render();
      }
      void e;
    };
    board.addEventListener("pointerup", end);
    board.addEventListener("pointercancel", end);
    board.addEventListener("wheel", (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = board.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * k * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else setCam(cam.x - e.deltaX * k, cam.y - e.deltaY * k, cam.z, false);
    }, { passive: false });
    board.addEventListener("dblclick", (e) => {
      const node = e.target.closest(".node[data-conv]");
      const clEl = e.target.closest(".cluster");
      if (node) { lift(node.dataset.conv); return; }
      if (clEl) { fitCluster(clEl.dataset.cluster, true); return; }
      if (!e.target.closest(".minimap, .zoomctl, .tray, .beacon")) fitAll(true);
    });
    const mm = $app.querySelector(".minimap");
    if (mm) {
      const jump = (e) => { const r = mm.getBoundingClientRect(); const vb = mm.viewBox.baseVal; const wx = vb.x + ((e.clientX - r.left) / r.width) * vb.width; const wy = vb.y + ((e.clientY - r.top) / r.height) * vb.height; centerOn(wx, wy, cam.z, true); };
      mm.addEventListener("pointerdown", (e) => { e.stopPropagation(); jump(e); });
      mm.addEventListener("keydown", (e) => { if (e.key === "Enter") fitAll(true); });
    }
  }
  function zoomAt(factor, sx, sy) {
    const z = clamp(cam.z * factor, MIN_Z, MAX_Z);
    const w = screenToWorld(sx, sy);
    setCam(sx - w.x * z, sy - w.y * z, z, false);
  }
  function zoomCenter(factor) { const { w, h } = boardSize(); zoomAt(factor, w / 2, h / 2); }

  /* ── minimap and beacons ──────────────────────────────────────────────── */
  function minimapHtml() {
    const W = M.world;
    const rects = M.clusters.map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${18}" style="fill:hsl(${c.hue} 55% 55% / ${c.needs ? 0.95 : c.quiet ? 0.35 : 0.7})" />`).join("");
    const regions = (M.regions || []).map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="24" class="mm-region" />`).join("");
    return `<svg class="minimap" role="button" tabindex="0" aria-label="Map of the yard · click to jump, Enter to fit everything" viewBox="${W.x} ${W.y} ${W.w} ${W.h}" preserveAspectRatio="xMidYMid meet" data-minimap><rect class="mm-bg" x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" rx="40"/>${regions}${rects}<rect class="mm-view" data-mm-view x="0" y="0" width="10" height="10" rx="12"/></svg>`;
  }
  function drawMinimapViewport() {
    const v = $app.querySelector("[data-mm-view]"); if (!v) return;
    const { w, h } = boardSize(); const tl = screenToWorld(0, 0);
    v.setAttribute("x", tl.x); v.setAttribute("y", tl.y); v.setAttribute("width", w / cam.z); v.setAttribute("height", h / cam.z);
  }
  /* Edge beacons: every cluster that needs the operator and is off the
     viewport gets a 44 px tab on the edge it lies beyond. */
  /* Beacons: every cluster that needs the operator and is off the viewport
     gets a tab in the bar with the direction it lies in. The bar, not the
     canvas, so a beacon never covers a node. */
  function drawBeacons() {
    const host = $app.querySelector(".beacons"); if (!host) return;
    const { w, h } = boardSize();
    const items = [];
    for (const c of M.clusters) {
      if (!c.needs) continue;
      const a = worldToScreen(c.x, c.y), b = worldToScreen(c.x + c.w, c.y + c.h);
      if (b.x > 0 && a.x < w && b.y > 0 && a.y < h) continue;
      const cx = (a.x + b.x) / 2 - w / 2, cy = (a.y + b.y) / 2 - h / 2;
      const ang = Math.atan2(cy, cx);
      const glyph = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
      items.push({ c, glyph, d: Math.hypot(cx, cy) });
    }
    items.sort((p, q) => (p.c.key || 99) - (q.c.key || 99));
    const max = w >= 1800 ? 3 : 2;
    const shown = items.slice(0, max), more = items.length - shown.length;
    host.innerHTML = shown.map((it) => `<button class="beacon" data-act="jump:${it.c.id}" aria-label="${esc(it.c.title)} needs you, off screen ${it.glyph}"><span class="g">${it.glyph}</span>${keycap(it.c.key)}<span>${esc(it.c.title)}</span></button>`).join("") + (more ? `<button class="beacon more" data-act="fitNeeds" aria-label="${more} more off screen · fit what needs you">+${more}</button>` : "");
  }

  /* ── rendering: the frame ─────────────────────────────────────────────── */
  function render() {
    const r = route();
    document.body.dataset.scheme = scheme;
    if (r.screen === "board" || r.screen === "field") buildModel(r.screen);
    const stage = r.screen === "chat" ? chatStage(r) : r.screen === "accounts" ? accountsStage(r) : boardStage(r);
    $app.dataset.rail = String(S.rail);
    $app.dataset.screen = r.screen;
    $app.innerHTML = `${rail(r)}<div class="main">${bar(r)}${banner(r)}${S.receipt ? receiptHtml() : ""}<div class="stagewrap">${stage}</div>${statusBar()}</div>${dialogHtml(r)}`;
    $app.dataset.dialog = r.dialog || "";
    if (r.screen === "board" || r.screen === "field") {
      mountBoard();
      const saved = S.cams[S.project];
      const zoomTo = Q.get("zoom");
      if (r.screen === "field") fitAll(false);
      else if (S.lift && !S.liftPlaced) { const c = conv(S.lift); const cl = clusterOfConv(S.lift); const n = cl && nodeRect(cl, cl.nodes.find((x) => x.conv && x.conv.id === S.lift)); if (n) { S.liftPlaced = true; centerOn(n.x + 320, n.y + 250, Math.max(1, cam.z), false); } else fitAll(false); void c; }
      else if (zoomTo && !S.zoomApplied) { S.zoomApplied = true; fitCluster(zoomTo.replace(/^block:/, ""), false); }
      else if (S.pendingFit) { const id = S.pendingFit; S.pendingFit = null; fitCluster(id, false); }
      else if (saved && !S.lift) { cam.x = saved.x; cam.y = saved.y; cam.z = saved.z; applyCamera(); }
      else fitAll(false);
      mountInspector();
    }
    mountChat(r);
    restoreFocus(r);
    $app.dataset.ready = "1";
  }

  function rail(r) {
    const rows = F.projects.filter((p) => !p.archived).map((p) => {
      const n = counts(p.id);
      const on = r.screen !== "field" && p.id === S.project;
      const initials = p.name.split(/[-\s]/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
      return `<button class="prow ${on ? "on" : ""}" data-project="${p.id}" data-act="project:${p.id}" aria-current="${on ? "page" : "false"}" aria-label="${esc(p.name)} · ${n.needs} need you · ${n.working} working">
        <span class="ini">${esc(initials)}${n.needs ? `<b>${n.needs}</b>` : ""}</span>
        <span class="pname"><span class="t">${esc(p.name)}${p.crowned ? I("crown", "crownmark") : ""}</span><span class="m">${n.needs ? `${n.needs} need you` : n.working ? `${n.working} working` : "quiet"}</span></span>
      </button>`;
    }).join("");
    const total = F.projects.filter((p) => !p.archived).reduce((s, p) => s + counts(p.id).needs, 0);
    return `<aside class="rail">
      <button class="prow home ${r.screen === "field" ? "on" : ""}" data-go="#/overview" aria-label="Overview · ${total} need you across every project"><span class="ini">${I("grid")}${total ? `<b>${total}</b>` : ""}</span><span class="pname"><span class="t">Overview</span><span class="m">${total} need you</span></span></button>
      <div class="rail-list">${rows}</div>
      <button class="prow add" data-go="${r.base}/create" aria-label="Create"><span class="ini">${I("plus")}</span><span class="pname"><span class="t">Create</span></span></button>
      <button class="prow tog" data-act="rail" aria-label="${S.rail ? "Collapse the rail ([)" : "Expand the rail ([)"}"><span class="ini">${I("sidebar")}</span><span class="pname"><span class="t">Collapse</span></span></button>
    </aside>`;
  }

  function bar(r) {
    if (r.screen === "chat") return "";
    if (r.screen === "accounts") return `<header class="bar"><div class="bar-title"><span class="t display">Accounts &amp; limits</span><span class="meta"><span>every account, both windows</span><span>open a row for its burn rate and when it runs out</span></span></div><div class="bar-actions">${barActions(r)}</div></header>`;
    const field = r.screen === "field";
    const n = field ? F.projects.filter((p) => !p.archived).reduce((s, p) => { const c = counts(p.id); s.needs += c.needs; s.working += c.working; s.pipelines += c.pipelines; return s; }, { needs: 0, working: 0, pipelines: 0 }) : counts(S.project);
    return `<header class="bar">
      <div class="bar-title"><span class="t display">${field ? "Every project" : esc(projectName(S.project))}</span><span class="meta"><span class="${n.needs ? "warn" : ""}">${n.needs} need you</span><span>${n.working} working</span><span>${n.pipelines} pipelines</span>${Object.keys(S.pins).length && !field ? `<span>${Object.keys(S.pins).length} pinned</span>` : ""}</span></div>
      <div class="zoomctl" role="group" aria-label="Camera">
        <button class="ib" data-act="zoomOut" aria-label="Zoom out (−)">${I("minus")}</button>
        <button class="alt" data-act="fitAll" data-altitude-label aria-label="Altitude and zoom · click to fit everything (f)">Yard · 50%</button>
        <button class="ib" data-act="zoomIn" aria-label="Zoom in (+)">${I("plus")}</button>
        <button class="ib" data-act="fitNeeds" aria-label="Fit what needs you (0)">${I("target")}</button>
      </div>
      <div class="beacons" aria-label="Off screen and needs you"></div>
      <div class="bar-actions">${Object.keys(S.pins).length && !field ? `<button class="btn quiet" data-act="unpinAll">${I("undo")}Release all</button>` : ""}${barActions(r)}</div>
    </header>`;
  }
  const barActions = (r) => `<button class="ib" data-go="${r.base}/search" aria-label="Find my messages (/)">${I("search")}</button><button class="ib" data-go="${r.base}/create" aria-label="Create (c)">${I("plus")}</button><button class="ib" data-go="${r.base}/menu" aria-label="Board menu">${I("more")}</button>`;

  function banner(r) {
    if (F.runtime === "offline") return `<div class="banner info"><b>Offline · reconnecting</b><span>Showing the last state received · ${esc(F.host.lastSeen)}</span></div>`;
    if (F.runtime === "degraded") return `<div class="banner info"><b>Runtime degraded · polling</b><span>Updates arrive every 10 s</span></div>`;
    if (!S.arrival || S.dismissed) return "";
    const c = conv(S.arrival.conv); if (!c || c.project === S.project && r.screen === "board") return "";
    const st = stateBits(c);
    return `<div class="banner"><button class="open" data-act="arrive:${c.id}"><b>Needs you · ${esc(st.badge)} · ${esc(projectName(c.project))}</b><span>${esc(c.title)}</span></button><button class="ib" data-act="dismissBanner" aria-label="Dismiss">${I("x")}</button></div>`;
  }
  function receipt(text, inverseLabel, inverse) {
    S.receipt = { text, inverseLabel, inverse };
    clearTimeout(S.receiptTimer);
    S.receiptTimer = setTimeout(() => { S.receipt = null; render(); }, 4000);
  }
  const receiptHtml = () => `<div class="receipt" role="status"><span>${esc(S.receipt.text)}</span>${S.receipt.inverseLabel ? `<button class="link" data-act="receiptInverse">${esc(S.receipt.inverseLabel)}</button>` : ""}</div>`;

  function statusBar() {
    const rt = F.runtime;
    const acc = (engine) => { const a = F.accounts[engine].find((x) => x.active); const w = a && a.windows.length ? a.windows.reduce((m, x) => (x.left < m.left ? x : m)) : null; return `<button class="schip" data-go="#/accounts/${engine}/${a.id}" aria-label="${engine === "claude" ? "Claude" : "Codex"} · ${esc(a.label)} · ${w ? `${w.left}% left of the ${w.label} window` : "no windows"}">${mark(engine)}<span>${esc(a.label)}</span>${w ? `${meter(w.left, "mini")}<span class="tn ${w.left <= 30 ? "warn" : ""}">${w.left}%</span>` : ""}</button>`; };
    return `<footer class="status">
      <button class="schip" data-go="${route().base}/host" aria-label="Runtime ${rt} · ${F.host.tasks.length} background tasks · Host details"><span class="dot ${rt === "connected" ? "live" : rt === "degraded" ? "wait" : "stall"}"></span><span>${rt}</span><span class="sep">·</span><span>${F.host.tasks.length} tasks</span></button>
      <span class="grow"></span>
      ${acc("claude")}${acc("codex")}
      <button class="schip" data-go="${route().base}/keys" aria-label="Keyboard map (?)"><kbd class="keycap">?</kbd><span>keys</span></button>
    </footer>`;
  }

  /* ── the board ────────────────────────────────────────────────────────── */
  function boardStage(r) {
    const field = r.screen === "field";
    const worldHtml = field ? M.regions.map(regionHtml).join("") : M.clusters.map((c) => clusterHtml(c)).join("");
    const insp = !field && S.selected && clusterById(S.selected) ? inspectorHtml(clusterById(S.selected)) : "";
    return `<div class="boardrow">
      <div class="board ${S.lift ? "has-lift" : ""}" data-board tabindex="0" aria-label="${field ? "The field: every project" : `The yard: ${esc(projectName(S.project))}`}" data-altitude="${altitude}">
        <div class="grid" aria-hidden="true"></div>
        <div class="world ${S.lift ? "receded" : ""}">${worldHtml}${M.clusters.length ? "" : `<div class="yard-empty">Nothing is running in this project.</div>`}</div>
      </div>
      <aside class="side">
        <div class="mapbox">${minimapHtml()}</div>
        ${insp ? `<div class="inspector" data-inspector>${insp}</div>` : `<div class="apron">${field ? fieldApron() : trayHtml()}</div>`}
      </aside>
    </div>`;
  }
  function regionHtml(rg) {
    const n = counts(rg.id);
    return `<div class="region" style="left:${rg.x}px;top:${rg.y}px;width:${rg.w}px;height:${rg.h}px">
      <div class="rg-head"><span class="t">${esc(rg.project.name)}</span><span class="m ${n.needs ? "warn" : ""}">${n.needs ? `${n.needs} need you` : `${n.working} working`}</span></div>
      ${rg.clusters.map((c) => clusterHtml(c, true)).join("")}
    </div>`;
  }
  function nodeRect(cl, n) {
    if (cl.kind === "pipeline") return { x: cl.x + PAD + n.index * (NW + GAP), y: cl.y + HEAD + PAD, w: NW, h: NH };
    const i = cl.nodes.indexOf(n);
    if (i === 0) return { x: cl.x + PAD, y: cl.y + HEAD + PAD, w: NW, h: NH };
    return { x: cl.x + PAD + (i - 1) * (NW + GAP), y: cl.y + HEAD + PAD + NH + GAP, w: NW, h: NH };
  }
  function clusterHtml(cl, tileOnly) {
    const sel = S.selected === cl.id;
    const head = `<div class="cl-head" title="drag to pin">${keycap(cl.key)}<span class="t">${cl.kind === "pipeline" && cl.pipe.issue ? `<em>#${cl.pipe.issue}</em> ` : ""}${esc(cl.title)}</span>${badge(cl.badge.text, cl.badge.tone)}${cl.pinned ? `<span class="pinmark" title="pinned">${I("pin")}pinned</span>` : ""}</div>`;
    const tile = `<button class="tile" data-act="inspect:${cl.id}" aria-label="${esc(cl.title)} · ${esc(cl.phrase)}"><span class="trow">${keycap(cl.key)}${microHtml(cl)}</span><span class="tt">${esc(cl.title)}</span><span class="tm">${esc(cl.phrase)}</span>${cl.kind === "pipeline" && cl.w > 700 ? `<span class="tstages">${cl.pipe.stages.map((st) => `<span class="${st.id === cl.pipe.stage && !cl.quiet ? "cur" : ""}">${esc(st.id)}</span>`).join("")}</span>` : ""}</button>`;
    let body = "";
    if (!tileOnly && !cl.compact) {
      if (cl.kind === "pipeline") body = pipelineBody(cl);
      else body = treeBody(cl);
    } else if (!tileOnly) body = `<div class="cl-body compact"><span class="meta"><span>${esc(cl.phrase)}</span>${cl.kind === "pipeline" ? `<span>${cl.pipe.stages.length} stages</span>` : ""}</span></div>`;
    return `<div class="cluster k-${cl.kind} ${cl.w < 400 ? "sm" : ""} ${cl.needs ? "needs" : ""} ${sel ? "selected" : ""} ${cl.pinned ? "pinned" : ""} ${cl.compact ? "compact" : ""} ${S.lift && cl.nodes.some((n) => n.conv && n.conv.id === S.lift) ? "has-lift" : ""}" data-cluster="${cl.id}" style="--hue:${cl.hue};left:${tileOnly ? cl.x + PAD : cl.x}px;top:${tileOnly ? cl.y + HEAD + PAD : cl.y}px;width:${cl.w}px;height:${cl.h}px">${head}${body}${tile}</div>`;
  }
  function microHtml(cl) {
    if (cl.kind === "pipeline") {
      const p = cl.pipe;
      const pips = p.stages.map((s, i) => { const a = lastAttempt(s); const k = a ? a.state : "none"; const cur = s.id === p.stage && !cl.quiet; return `<i class="st ${k} ${cur ? "cur" : ""}" title="${esc(s.id)}"></i>${i < p.stages.length - 1 ? `<b class="ln ${a && a.state === "passed" ? "on" : ""}"></b>` : ""}`; }).join("");
      const loop = p.stages.find((s) => s.onFail && s.attempts.some((a) => a.state === "failed"));
      return `<span class="micro">${pips}${loop ? `<span class="loop">↺ ${roundsUsed(p, p.stages.find((x) => x.id === loop.onFail.to))}/${loop.onFail.maxRounds}</span>` : ""}</span>`;
    }
    return `<span class="micro">${cl.nodes.map((n) => `<i class="nd ${stateBits(n.conv).dot}"></i>`).join("")}${cl.task ? `<span class="tag">${cl.task.issue ? `#${cl.task.issue}` : "task"}</span>` : ""}</span>`;
  }
  function pipelineBody(cl) {
    const p = cl.pipe;
    const nodes = cl.nodes.map((n, i) => {
      const s = n.stage; const a = n.attempt; const c = n.conv;
      const st = c ? stateBits(c) : null;
      const cur = s.id === p.stage;
      const ring = a ? a.state : "none";
      const phrase = c ? st.phrase : a ? a.state : "not started";
      const pips = s.attempts.map((x) => `<i class="pip ${x.state}"></i>`).join("");
      const lifted = Boolean(c) && S.lift === c.id;
      const act = lifted ? `data-conv="${c.id}"` : c ? `data-act="open:${c.id}" data-conv="${c.id}"` : `data-act="inspect:${cl.id}"`;
      const edge = i < cl.nodes.length - 1 ? `<span class="edge ${a && a.state === "passed" ? "on" : ""}" style="left:${PAD + (i + 1) * NW + i * GAP}px"></span>` : "";
      const tag = lifted ? "div" : "button";
      return `<${tag} class="node station ${cur ? "cur" : ""} ${st ? st.edge || "" : ""} ${lifted ? "lifted" : ""}" ${act} style="left:${PAD + i * (NW + GAP)}px;top:${HEAD + PAD}px" aria-label="${esc(s.role)} · ${esc(s.id)} · ${esc(phrase)}">
        <span class="row1"><i class="ring ${ring}"></i><span class="role">${esc(s.role)}</span><span class="sid">${esc(s.id)}</span>${pips ? `<span class="pips">${pips}</span>` : ""}</span>
        <span class="row2">${mark(s.engine)}<span class="tn">${esc(s.model)} · ${esc(s.effort)}</span><span class="sep">·</span><span class="${st ? "" : "muted"}">${esc(s.access)}</span></span>
        <span class="row3 ${st && st.tone ? st.tone.replace("b-", "t-") : ""}">${esc(c ? (st.key === "working" ? `working ${c.elapsed} · ${nowFragment(c)}` : st.phrase) : phrase)}</span>
        ${lifted ? liftPane(c) : ""}
      </${tag}>${edge}`;
    }).join("");
    let k = 0;
    const loops = p.stages.map((s, i) => {
      if (!s.onFail) return "";
      const j = p.stages.findIndex((x) => x.id === s.onFail.to);
      const used = s.attempts.filter((a) => a.state === "failed").length;
      const lane = k++;
      const x1 = PAD + i * (NW + GAP) + NW / 2 + lane * 10, x2 = PAD + j * (NW + GAP) + NW / 2 - lane * 10, y0 = HEAD + PAD + NH, y1 = y0 + 14 + lane * 18;
      return `<g class="loop ${used ? "used" : ""}"><path d="M ${x1} ${y0} v ${y1 - y0 - 8} q 0 8 -8 8 H ${x2 + 8} q -8 0 -8 -8 v -${y1 - y0 - 12}"/><path class="head" d="M ${x2 - 5} ${y0 + 10} L ${x2} ${y0 + 3} L ${x2 + 5} ${y0 + 10} z"/><text x="${x1 - 10}" y="${y1 - 4}" text-anchor="end">↺ ${esc(s.onFail.to)} · ${"●".repeat(used)}${"○".repeat(Math.max(0, s.onFail.maxRounds - used))} · ${used} of ${s.onFail.maxRounds} rounds</text></g>`;
    }).join("");
    const tag = cl.task && cl.task.title !== p.task ? `<span class="tasktag" style="left:${PAD}px;top:${HEAD - 12}px">${cl.task.issue ? `#${cl.task.issue}` : "task"} · ${esc(cl.task.title)}</span>` : "";
    return `<div class="cl-body"><svg class="spine" width="${cl.w}" height="${cl.h}" aria-hidden="true">${loops}</svg>${nodes}${tag}</div>`;
  }
  function treeBody(cl) {
    const nodes = cl.nodes.map((n, i) => {
      const c = n.conv; const st = stateBits(c);
      const r = nodeRect(cl, n);
      const lifted = S.lift === c.id; const tag = lifted ? "div" : "button";
      return `<${tag} class="node ${st.edge || ""} ${i === 0 ? "root" : "child"} ${lifted ? "lifted" : ""}" ${lifted ? "" : `data-act="open:${c.id}"`} data-conv="${c.id}" style="left:${r.x - cl.x}px;top:${r.y - cl.y}px" aria-label="${esc(c.title)} · ${esc(st.phrase)}">
        <span class="row1"><i class="dot ${st.dot}"></i><span class="title">${esc(c.title)}</span></span>
        <span class="row2">${mark(c.engine)}<span class="tn">${esc(c.model)} · ${esc(c.effort)}</span></span>
        <span class="row3 ${st.tone ? st.tone.replace("b-", "t-") : ""}">${esc(st.key === "working" ? `working ${c.elapsed} · ${nowFragment(c)}` : st.phrase)}</span>
        ${lifted ? liftPane(c) : ""}
      </${tag}>`;
    }).join("");
    const edges = cl.nodes.slice(1).map((n) => { const r = nodeRect(cl, n); const x1 = PAD + NW / 2, y1 = HEAD + PAD + NH, x2 = r.x - cl.x + NW / 2, y2 = r.y - cl.y; return `<path d="M ${x1} ${y1} C ${x1} ${y1 + 12}, ${x2} ${y2 - 12}, ${x2} ${y2}"/>`; }).join("");
    const extra = cl.kind === "seat" ? `<div class="seatside" style="left:${PAD + NW + GAP}px;top:${HEAD + PAD}px"><span class="tn">context</span>${meter(cl.seat.ctx.left)}<span class="tn">${cl.seat.ctx.left}% left</span><span class="tn muted">${esc(cl.seat.account)} · ${esc(cl.seat.model)} · ${esc(cl.seat.effort)}</span></div>` : "";
    const tag = cl.task ? `<span class="tasktag" style="left:${PAD}px;top:${HEAD - 12}px">${cl.task.issue ? `#${cl.task.issue}` : "task"} · ${esc(cl.task.title)}</span>` : "";
    return `<div class="cl-body"><svg class="spine" width="${cl.w}" height="${cl.h}" aria-hidden="true">${edges}</svg>${nodes}${extra}${tag}</div>`;
  }
  /* The lift: the node's live pane, in place, with the feed's tail and the
     same composer the chat stage has. */
  function liftPane(c) {
    const st = stateBits(c);
    const feed = (c.feed || []).slice(-5).map(feedItem).join("");
    const q = c.question && st.key === "waiting" ? questionCard(c) : "";
    return `<div class="lift" data-lift="${c.id}" data-lift-scope data-focus="lift" tabindex="0" aria-label="${esc(c.title)} · lifted · Enter opens, Esc lowers, i types">
      <div class="lhead"><i class="dot ${st.dot}"></i>${st.badge ? badge(st.badge, st.tone) : ""}<span class="t">${esc(c.title)}</span><span class="meta"><span>${mark(c.engine)}${esc(c.model)} · ${esc(c.effort)}</span></span><button class="ib" data-go="#/chat/${c.id}" aria-label="Open the conversation (Enter)">${I("open")}</button><button class="ib" data-act="unlift" aria-label="Lower (Esc)">${I("x")}</button></div>
      <div class="lfeed">${feed}${q}</div>
      ${composer(c, false)}
    </div>`;
  }
  /* The apron under the map: the backlog (tasks with no worker), folded to
     its count until opened; each row has Assign. */
  function trayHtml() {
    const n = M.backlog.length;
    const q = needsQueue(S.project);
    const needs = q.length ? `<h3>Needs you <span class="c">· ${q.length} · n walks them</span></h3><div class="qlist">${q.map((it) => { const cl = clusterById(it.cluster); const c = it.kind === "conv" ? conv(it.conv) : null; const st = c ? stateBits(c) : null; return `<button class="irow ${st ? st.edge || "" : "wait"}" data-act="${it.kind === "conv" ? `open:${it.conv}` : `inspect:${it.cluster}`}"><i class="dot ${st ? st.dot : "wait"}"></i><span class="main"><span class="t">${esc(c ? c.title : cl.title)}</span><span class="m"><span class="${st ? st.tone.replace("b-", "t-") : "t-warning"}">${esc(st ? st.phrase : cl.phrase)}</span></span></span>${keycap(cl && cl.key)}</button>`; }).join("")}</div>` : "";
    if (!n) return needs;
    const head = `<button class="tray-head" data-act="tray" aria-expanded="${S.tray}" aria-label="${S.tray ? "Fold" : "Open"} the backlog · ${n} tasks without a worker">${I("inbox")}<span>Backlog · ${n} without a worker</span>${I("chevD", S.tray ? "up" : "")}</button>`;
    const rows = S.tray ? `<div class="tray-rows">${M.backlog.map((t) => `<div class="tchip"><span class="t">${t.issue ? `<em>#${t.issue}</em> ` : ""}${esc(t.title)}</span><button class="btn small" data-act="assign:${t.id}">${I("plus", "sm")}Assign</button></div>`).join("")}</div>` : "";
    return `${needs}<div class="tray">${head}${rows}</div>`;
  }
  function fieldApron() {
    const rows = F.projects.filter((p) => !p.archived).map((p) => { const n = counts(p.id); return `<button class="irow" data-act="project:${p.id}"><span class="main"><span class="t">${esc(p.name)}${p.crowned ? I("crown", "crownmark") : ""}</span><span class="m"><span class="${n.needs ? "t-warning" : ""}">${n.needs} need you</span><span class="sep">·</span><span>${n.working} working</span></span></span>${I("chevR", "chev")}</button>`; }).join("");
    return `<h3>Projects <span class="c">· ${F.projects.filter((p) => !p.archived).length}</span></h3><div class="qlist">${rows}</div>`;
  }

  /* ── the inspector ────────────────────────────────────────────────────── */
  function inspectorHtml(cl) {
    const close = `<button class="ib" data-act="deselect" aria-label="Close the inspector (Esc)">${I("x")}</button>`;
    if (cl.kind === "pipeline") return pipelineInspector(cl, close);
    if (cl.kind === "seat") {
      const s = cl.seat; const c = cl.root; const st = stateBits(c);
      return `<div class="insp-head">${keycap(cl.key)}<span class="t">Orchestrator</span>${badge(st.key === "working" ? `working ${c.elapsed}` : st.phrase, st.tone)}${close}</div>
      <div class="insp-body">
        <div class="idrow">${mark(s.engine, "fill")}<span><b>${esc(s.model)} · ${esc(s.effort)}</b><small>${esc(s.account)} · ${esc(s.plan)} · holding the seat for ${esc(s.since)}${s.predecessor ? " · predecessor" : ""}</small></span></div>
        <div class="mrow"><span class="tn">context</span>${meter(s.ctx.left)}<span class="tn">${s.ctx.left}% left of ${esc(s.ctx.window)}</span></div>
        <p class="mandate">${esc(s.mandate)}</p>
        <div class="actions"><button class="btn primary" data-go="#/chat/${c.id}">${I("open", "sm")}Open the conversation</button><button class="btn" data-go="#/board/rotate">${I("rotate", "sm")}Rotate</button></div>
      </div>`;
    }
    const rows = cl.nodes.map((n) => { const c = n.conv; const st = stateBits(c); return `<button class="irow ${st.edge || ""}" data-go="#/chat/${c.id}"><i class="dot ${st.dot}"></i><span class="main"><span class="t">${esc(c.title)}</span><span class="m"><span class="${st.tone ? st.tone.replace("b-", "t-") : ""}">${esc(st.phrase)}</span><span class="sep">·</span>${mark(c.engine)}<span>${esc(c.model)} · ${esc(c.effort)}</span></span></span>${I("chevR", "chev")}</button>`; }).join("");
    const root = cl.root; const st = stateBits(root);
    return `<div class="insp-head">${keycap(cl.key)}<span class="t">${esc(cl.title)}</span>${badge(cl.badge.text, cl.badge.tone)}${close}</div>
    <div class="insp-body">
      ${cl.task ? `<div class="tagrow"><span class="tasktag inline">${cl.task.issue ? `#${cl.task.issue}` : "task"} · ${esc(cl.task.title)}</span><span class="tn muted">task · ${esc(cl.task.status)}</span></div>` : ""}
      <h3>Conversations <span class="c">· ${cl.nodes.length}</span></h3>${rows}
      <div class="actions"><button class="btn primary" data-go="#/chat/${root.id}">${I("open", "sm")}Open</button><button class="btn" data-act="lift:${root.id}">Lift here</button>${st.key === "killed" ? `<button class="btn" data-act="respawn:${root.id}">Respawn</button>` : `<button class="btn quiet" data-act="kill:${root.id}">Kill</button>`}${cl.pinned ? `<button class="btn quiet" data-act="unpin:${cl.id}">${I("undo", "sm")}Release</button>` : ""}</div>
    </div>`;
  }
  function pipelineInspector(cl, close) {
    const p = cl.pipe; const pb = pipeBits(p);
    const stations = p.stages.map((s, i) => {
      const a = lastAttempt(s); const cur = s.id === p.stage && !cl.quiet;
      const loopIn = p.stages.filter((x) => x.onFail && x.onFail.to === s.id);
      const attempts = s.attempts.map((x) => `<span class="att"><i class="pip ${x.state}"></i>attempt ${x.n} · ${esc(x.state)}${x.sha ? ` · <code>${esc(x.sha)}</code>` : ""}${x.findings ? ` · ${x.findings.length} findings` : ""}${x.conv ? `<button class="link" data-go="#/chat/${x.conv}">open ›</button>` : ""}</span>`).join("");
      const editing = S.editing === `${p.id}:${s.id}`;
      return `<div class="stn ${cur ? "cur" : ""} ${a ? a.state : "none"}" data-stage="${s.id}">
        <i class="ring ${a ? a.state : "none"}"></i>
        <div class="stn-main">
          <div class="l1"><b class="role">${esc(s.role)}</b><span class="sid">${esc(s.id)}</span>${cur ? badge("current", "b-accent") : ""}${loopIn.map((x) => `<span class="loopin">↺ from ${esc(x.id)} · ${"●".repeat(x.attempts.filter((y) => y.state === "failed").length)}${"○".repeat(Math.max(0, x.onFail.maxRounds - x.attempts.filter((y) => y.state === "failed").length))} · ${x.attempts.filter((y) => y.state === "failed").length} of ${x.onFail.maxRounds} rounds</span>`).join("")}</div>
          <div class="l2 meta"><span>${mark(s.engine)}${esc(s.model)} · ${esc(s.effort)}</span><span>${esc(s.access)}</span>${s.onFail ? `<span class="warn">on fail ↺ ${esc(s.onFail.to)} · ${s.onFail.maxRounds} rounds</span>` : ""}</div>
          ${attempts ? `<div class="atts">${attempts}</div>` : `<div class="atts muted">not started</div>`}
          ${editing ? stageEditor(p, s) : `<button class="link" data-act="edit:${p.id}:${s.id}">edit stage ›</button>`}
        </div>
      </div>${i < p.stages.length - 1 ? `<div class="stn-link ${a && a.state === "passed" ? "on" : ""}"></div>` : ""}`;
    }).join("");
    const cur = p.stages.find((s) => s.id === p.stage);
    const failed = cur && [...cur.attempts].reverse().find((a) => a.state === "failed" && a.findings);
    const findings = p.state === "needs_decision" && failed ? `<div class="findings"><h3>${esc(cur.role)} · attempt ${failed.n}${cur.onFail ? ` · round ${cur.attempts.filter((a) => a.state === "failed").length} of ${cur.onFail.maxRounds}` : ""} · ${failed.findings.length} findings</h3><ol>${failed.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>
      <textarea class="field" data-focus="answer" rows="2" placeholder="Answer the reviewer, then retry the stage…" aria-label="Your answer"></textarea>
      <div class="actions"><button class="btn primary" data-act="answer:${p.id}">Answer and retry</button><button class="btn" data-act="skip:${p.id}">Skip stage</button></div></div>` : "";
    const actions = p.state === "draft" ? `<button class="btn primary" data-act="start:${p.id}">${I("play", "sm")}Start</button>` : p.state === "completed" ? `<button class="btn" data-act="rerun:${p.id}">${I("rotate", "sm")}Re-run</button>` : `${p.state === "paused" ? `<button class="btn" data-act="resume:${p.id}">${I("play", "sm")}Resume</button>` : `<button class="btn" data-act="pause:${p.id}">${I("pause", "sm")}Pause</button>`}<button class="btn quiet" data-act="archive:${p.id}">${I("archive", "sm")}Archive</button>`;
    return `<div class="insp-head">${keycap(cl.key)}<span class="t">${p.issue ? `<em>#${p.issue}</em> ` : ""}${esc(p.task)}</span>${badge(pb.phrase, pb.tone)}${close}</div>
    <div class="insp-body">
      <div class="meta wrap"><span>${esc(pb.phrase)} · since ${esc(p.since)}</span><span>rev ${p.revision}</span><span><code>${esc(p.branch)}</code></span>${cl.task ? `<span class="tasktag inline">${cl.task.issue ? `#${cl.task.issue}` : "task"} · ${esc(cl.task.status)}</span>` : ""}</div>
      ${findings}
      <h3>Stages <span class="c">· ${p.stages.length}</span></h3>
      <div class="graph">${stations}</div>
      <div class="actions">${actions}${cl.pinned ? `<button class="btn quiet" data-act="unpin:${cl.id}">${I("undo", "sm")}Release</button>` : ""}</div>
      ${p.log.length ? `<h3>Changes</h3><div class="log">${p.log.map((l) => `<div class="lrow"><b>${esc(l[0])}</b><span>${esc(l[1])}</span><span>${esc(l[2])}</span><span class="muted">${esc(l[3])}</span><span class="rest">${esc(l[4])}</span></div>`).join("")}</div>` : ""}
    </div>`;
  }
  const seg = (name, options, value, act) => `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${options.map((o) => `<button role="radio" aria-checked="${o === value}" class="${o === value ? "on" : ""}" data-act="${act}:${o}">${esc(o)}</button>`).join("")}</div>`;
  function stageEditor(p, s) {
    const key = `${p.id}:${s.id}`; const d = S.editDraft || { ...s };
    return `<div class="editor" data-editor>
      <label>Role</label>${seg("Role", ["Architect", "Builder", "Verifier", "Reviewer", "Deployer"], d.role, `ed:role`)}
      <label>Engine</label>${seg("Engine", ["claude", "codex"], d.engine, `ed:engine`)}
      <label>Model</label>${seg("Model", d.engine === "codex" ? ["gpt-5.6", "gpt-5.5"] : ["Opus", "Sonnet", "Haiku"], d.model, `ed:model`)}
      <label>Reasoning</label>${seg("Reasoning", ["low", "medium", "high", "xhigh", "max"], d.effort, `ed:effort`)}
      <label>Access</label>${seg("Access", ["read-only", "read-write"], d.access, `ed:access`)}
      <label>Prompt</label><textarea class="field" rows="3" data-focus="prompt" aria-label="Stage prompt">{{prev.output}}\n\nPinned task: ${esc(p.task)}</textarea>
      <div class="actions"><button class="btn primary" data-act="save:${key}">Save · applies from the next attempt</button>${s.attempts.some((a) => a.state === "running") ? `<button class="btn" data-act="restart:${key}">Restart the stage now</button>` : ""}<button class="btn quiet" data-act="cancelEdit">Cancel</button></div>
    </div>`;
  }
  function mountInspector() { /* nothing to bind: delegation handles it */ }

  /* ── the chat stage ───────────────────────────────────────────────────── */
  function chatStage(r) {
    const c = conv(r.id);
    if (!c) return `<div class="chat"><div class="yard-empty">No such conversation.</div></div>`;
    const st = stateBits(c);
    const cl = clustersOf(c.project).find((x) => x.nodes.some((n) => n.conv && n.conv.id === c.id));
    const pos = cl && c.pipeline ? `${stageIndex(pipe(c.pipeline.id), c.pipeline.stage)}/${pipe(c.pipeline.id).stages.length} ${c.pipeline.stage}` : "";
    const siblings = cl ? cl.nodes.map((n) => n.conv).filter(Boolean) : [c];
    const i = siblings.findIndex((x) => x.id === c.id);
    const prev = siblings[i - 1], next = siblings[i + 1];
    const seat = c.seat ? F.seats[c.project] : null;
    return `<div class="chat" data-conversation="${c.id}">
      <header class="chead">
        <button class="ib" data-act="backToYard:${c.id}" aria-label="Back to the yard (Esc)">${I("chevL")}</button>
        <i class="dot ${st.dot}"></i>${st.badge ? badge(st.badge, st.tone) : ""}
        <span class="t" title="${esc(c.title)}">${esc(c.title)}</span>
        <span class="meta"><span>${mark(c.engine)}${esc(c.model)} · ${esc(c.effort)}</span><span class="${st.tone ? st.tone.replace("b-", "t-") : ""}">${esc(st.key === "working" ? `working ${c.elapsed}` : st.phrase)}</span>${pos ? `<span>stage ${esc(pos)}</span>` : ""}${cl && cl.kind !== "tree" && cl.kind !== "seat" ? `<span>${esc(cl.kind === "pipeline" ? `#${cl.pipe.issue} ${cl.title}` : cl.title)}</span>` : ""}</span>
        <span class="sib"><button class="ib" data-go="${prev ? `#/chat/${prev.id}` : ""}" ${prev ? "" : "disabled"} aria-label="Previous in this cluster">${I("chevL")}</button><span class="tn">${i + 1}/${siblings.length}</span><button class="ib" data-go="${next ? `#/chat/${next.id}` : ""}" ${next ? "" : "disabled"} aria-label="Next in this cluster">${I("chevR")}</button></span>
        <button class="ib" data-go="#/chat/${c.id}/menu" aria-label="Conversation menu">${I("more")}</button>
      </header>
      ${seat ? `<div class="seatpanel">${mark(seat.engine, "fill")}<span class="main"><b>${esc(seat.model)} · ${esc(seat.effort)} · ${esc(seat.account)}</b><small>holding the seat for ${esc(seat.since)} · context ${seat.ctx.left}% left of ${esc(seat.ctx.window)}</small></span>${meter(seat.ctx.left, "mini")}<button class="btn quiet" data-go="#/board/rotate">${I("rotate", "sm")}Rotate</button></div>` : ""}
      <div class="feed" data-feed>${(c.feed || []).map(feedItem).join("")}${c.question && st.key === "waiting" ? questionCard(c) : ""}${st.key === "working" ? `<div class="working"><i class="dot live"></i>working · ${esc(c.elapsed)}${c.tool ? ` · ${esc(shortTool(c.tool))}` : ""}</div>` : st.key === "returned" ? `<div class="working muted">finished the turn · ${esc(c.age)}</div>` : ""}</div>
      ${S.receipt && r.screen === "chat" ? "" : ""}
      ${composer(c, false)}
    </div>`;
  }
  function feedItem(it) {
    if (it.kind === "user") return `<div class="msg user"><div class="bubble">${esc(it.text)}</div><span class="at tn">${esc(it.at)}</span></div>`;
    if (it.kind === "tool") return `<div class="toolline ${it.status}">${I("tool", "sm")}<span class="tn">${esc(it.tool)}</span>${it.out ? `<span class="muted">· ${esc(it.out)}</span>` : ""}<span class="grow"></span><span class="tn muted">${it.status === "running" ? "running…" : "done"} · ${esc(it.at)}</span></div>`;
    return `<div class="msg agent"><span class="avatar">${I("sparkle")}</span><div class="body"><span class="at tn">${esc(it.at)}</span><p>${esc(it.text).replace(/\n/g, "<br>")}</p></div></div>`;
  }
  function questionCard(c) {
    const q = c.question;
    return `<div class="qcard"><div class="qh">${badge(c.decision || "a question", "b-warning")}<b>${esc(q.title)}</b></div>
      ${q.options.map((o, i) => `<button class="opt" data-act="answer-conv:${c.id}:${i}" data-focus="opt${i}"><kbd class="keycap">${i + 1}</kbd><span><b>${esc(o[0])}</b><small>${esc(o[1])}</small></span></button>`).join("")}
      <div class="own"><input class="field" data-focus="own" placeholder="Your own answer…" aria-label="Your own answer" /><button class="btn primary" data-act="answer-conv:${c.id}:own">Send</button></div></div>`;
  }
  /* One box: the field on top, the tools row inside it, the send slot that is
     Stop while working, Queue offline, Respawn when killed. */
  function composer(c, inLift) {
    const st = stateBits(c);
    const set = S.settings[c.id] || { model: c.model, effort: c.effort, fast: false };
    const slot = st.key === "killed" ? { act: `respawn:${c.id}`, label: "Respawn", icon: "rotate", cls: "resp" } : F.runtime === "offline" ? { act: `send:${c.id}`, label: "Queue", icon: "arrowUp", cls: "queue" } : st.key === "working" && !(S.drafts[c.id] || "").trim() ? { act: `stop:${c.id}`, label: "Stop", icon: "square", cls: "stop" } : { act: `send:${c.id}`, label: "Send", icon: "arrowUp", cls: "send" };
    const limit = st.key === "limit";
    const tag = "div";
    return `<${tag} class="composer ${inLift ? "in-lift" : ""}"><${tag} class="box">
      <textarea class="ta" data-focus="field" data-conv="${c.id}" rows="1" placeholder="${limit ? "This account is at its limit · pick another in the chip" : "Message the agent · Enter sends, Shift+Enter breaks"}" aria-label="Message the agent">${esc(S.drafts[c.id] || "")}</textarea>
      <${tag} class="tools">
        <button class="chip ${limit ? "warn" : ""}" data-go="#/chat/${c.id}/settings" data-focus="chip" aria-haspopup="dialog" aria-label="Next message settings · ${esc(set.model)} · ${esc(set.effort)}">${I("zap", "sm")}<span>${esc(set.model)} · ${esc(set.effort)}${set.fast ? " · fast" : ""}${limit ? ` · ${esc(c.limit.account)} at limit` : ""}</span>${I("chevD", "sm")}</button>
        <button class="ib" data-focus="attach" data-act="attach" aria-label="Attach an image">${I("clip")}</button>
        <button class="ib" data-focus="mic" data-act="mic" aria-label="Dictate">${I("mic")}</button>
        <span class="grow"></span>
        <button class="slot ${slot.cls}" data-focus="send" data-act="${slot.act}" aria-label="${slot.label}">${I(slot.icon)}<span>${slot.label}</span></button>
      </${tag}>
    </${tag}></${tag}>`;
  }
  function settingsSheet(c) {
    const set = S.settings[c.id] || (S.settings[c.id] = { model: c.model, effort: c.effort, fast: false, account: F.accounts[c.engine].find((a) => a.active).id });
    const models = c.engine === "codex" ? ["gpt-5.6", "gpt-5.5"] : ["Opus", "Sonnet", "Haiku"];
    const efforts = c.engine === "codex" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"];
    const accounts = F.accounts[c.engine].map((a) => { const w = a.windows.length ? a.windows.reduce((m, x) => (x.left < m.left ? x : m)) : null; const on = set.account === a.id; const signedIn = a.auth === "Authenticated"; return `<button class="arow compact ${on ? "on" : ""}" role="radio" aria-checked="${on}" data-act="${signedIn ? `set:${c.id}:account:${a.id}` : `signin:${c.engine}:${a.id}`}"><span class="t">${esc(a.label)}<small>${esc(a.plan)}</small></span>${signedIn && w ? `${meter(w.left)}<span class="pct tn ${w.left <= 30 ? "warn" : ""}">${w.left}% left · ${esc(w.label)}</span>` : `<span class="meter empty"><i></i></span><span class="signin">sign in ›</span>`}${on ? I("check", "sm") : ""}</button>`; }).join("");
    return `<div class="settings" data-dialog role="dialog" aria-label="Next message settings">
      <div class="srow"><label>Model</label>${seg("Model", models, set.model, `set:${c.id}:model`)}</div>
      <div class="srow"><label>Reasoning</label>${seg("Reasoning", efforts, set.effort, `set:${c.id}:effort`)}</div>
      ${c.engine === "codex" ? `<div class="srow"><label>Speed</label>${seg("Speed", ["standard", "fast"], set.fast ? "fast" : "standard", `set:${c.id}:speed`)}</div>` : ""}
      <div class="srow col"><label>Account</label><div class="alist" role="radiogroup" aria-label="Account">${accounts}</div></div>
      <div class="srow"><label>Session</label><div class="sess"><button class="btn quiet" data-act="compact:${c.id}">${I("compress", "sm")}Compact context</button><button class="btn quiet" data-act="copyResume:${c.id}">${I("terminal", "sm")}Copy resume command</button><button class="btn quiet" data-act="recheck">${I("refresh", "sm")}Re-check host</button></div></div>
      <div class="shint tn muted">Applies to the next message · Esc closes</div>
    </div>`;
  }
  function mountChat(r) {
    if (r.screen !== "chat" && !S.lift) return;
    const feed = $app.querySelector("[data-feed], .lfeed");
    if (feed) feed.scrollTop = feed.scrollHeight;
    for (const ta of $app.querySelectorAll("textarea.ta")) {
      const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(160, ta.scrollHeight)}px`; };
      grow();
      ta.addEventListener("input", () => { S.drafts[ta.dataset.conv] = ta.value; grow(); const slot = ta.closest(".box").querySelector(".slot"); const c = conv(ta.dataset.conv); if (slot && stateBits(c).key === "working" && F.runtime !== "offline") { const typing = ta.value.trim().length > 0; slot.className = `slot ${typing ? "send" : "stop"}`; slot.dataset.act = typing ? `send:${c.id}` : `stop:${c.id}`; slot.setAttribute("aria-label", typing ? "Send" : "Stop"); slot.innerHTML = `${I(typing ? "arrowUp" : "square")}<span>${typing ? "Send" : "Stop"}</span>`; } });
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); act(`send:${ta.dataset.conv}`); } });
    }
  }

  /* ── the accounts stage ───────────────────────────────────────────────── */
  const clockOf = (s) => { const m = /(\d{1,2}):(\d{2})/.exec(s || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  function paceOf(w) {
    const spent = 100 - w.left; const rate = w.elapsed > 0 ? spent / w.elapsed : 0;
    const idealLeft = Math.max(0, 100 * (1 - w.elapsed / w.hours));
    const hoursLeft = rate > 0 ? w.left / rate : Infinity; const windowLeft = w.hours - w.elapsed;
    return { rate, idealLeft, ahead: w.left >= idealLeft, hoursLeft, windowLeft, lasts: hoursLeft >= windowLeft, runsOut: rate > 0 && hoursLeft < windowLeft ? hhmm(F.nowMinutes + hoursLeft * 60) : null };
  }
  function chart(w) {
    const L = 36, R = 456, T = 14, B = 150;
    const x = (h) => L + (R - L) * Math.min(1, h / w.hours); const y = (v) => B - (B - T) * (v / 100);
    const pace = paceOf(w);
    const actual = w.series.map(([h, v]) => `${x(h).toFixed(1)} ${y(v).toFixed(1)}`).join(" L ");
    const last = w.series[w.series.length - 1];
    const outH = pace.lasts ? w.hours : w.elapsed + pace.hoursLeft;
    const outV = pace.lasts ? Math.max(0, w.left - pace.rate * pace.windowLeft) : 0;
    const cls = w.left <= 10 ? "low" : w.left <= 30 ? "warn" : "";
    return `<svg class="chart" viewBox="0 0 470 176" role="img" aria-label="${w.left}% left of the ${esc(w.label)} window, ${pace.ahead ? "ahead of" : "behind"} the ideal pace">
      ${[0, 50, 100].map((v) => `<line class="gl" x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("")}
      <rect class="burn" x="${x(outH)}" y="${T}" width="${Math.max(0, R - x(outH))}" height="${B - T}"/>
      <path class="ideal" d="M ${x(0)} ${y(100)} L ${x(w.hours)} ${y(0)}"/>
      <path class="proj ${cls}" d="M ${x(last[0])} ${y(last[1])} L ${x(outH)} ${y(outV)}"/>
      <path class="actual ${cls}" d="M ${actual}"/>
      <circle class="pt ${cls}" cx="${x(last[0])}" cy="${y(last[1])}" r="4"/>
      <line class="now" x1="${x(w.elapsed)}" y1="${T}" x2="${x(w.elapsed)}" y2="${B}"/>
      <text class="lbl" x="${x(w.elapsed) + 4}" y="${T + 10}">now</text>
      <text class="lbl" x="${L}" y="170">window opened</text><text class="lbl" x="${R}" y="170" text-anchor="end">${esc(w.reset)}</text>
      ${pace.runsOut ? `<text class="lbl warn" x="${Math.max(L + 60, x(outH) - 6)}" y="${T + 24}" text-anchor="end">runs out ${esc(pace.runsOut)}</text>` : ""}
    </svg>`;
  }
  function accountRow(engine, a, cur) {
    const signedIn = a.auth === "Authenticated";
    const wins = signedIn && a.windows.length
      ? a.windows.map((w) => `<span class="win"><span class="tn wl">${esc(w.label)}</span>${meter(w.left)}<span class="pct tn ${w.left <= 30 ? "warn" : ""}">${w.left}% left</span><span class="tn muted">${esc(w.reset)}</span></span>`).join("")
      : `<span class="win"><span class="tn wl">5 h</span><span class="meter empty"><i></i></span><span class="pct tn">—</span><span class="tn muted">sign in to read this window</span></span><span class="win"><span class="tn wl">Week</span><span class="meter empty"><i></i></span><span class="pct tn">—</span><span class="tn muted"></span></span>`;
    return `<button class="arow ${cur ? "on" : ""} ${a.active ? "active" : ""}" data-go="#/accounts/${engine}/${a.id}" data-account="${a.id}" aria-current="${cur ? "true" : "false"}">
      ${mark(engine, "fill")}<span class="t">${esc(a.label)}<small>${esc(a.plan)}${a.checked ? ` · checked ${esc(a.checked)}` : ""}</small></span>
      <span class="wins">${wins}</span>
      ${signedIn ? badge(a.active ? "active" : "ready", a.active ? "b-accent" : "b-success") : `<span class="signin">sign in ›</span>`}</button>`;
  }
  function accountsStage(r) {
    const engine = r.engine || "claude";
    const id = r.id || F.accounts[engine].find((a) => a.active).id;
    const eng = (e, list) => {
      const signed = list.filter((a) => a.auth === "Authenticated" && a.windows.length);
      const best = signed.length ? signed.reduce((m, a) => (a.windows[0].left > m.windows[0].left ? a : m)) : null;
      const nextReset = signed.map((a) => a.windows[0]).sort((p, q) => (clockOf(p.reset) || 9e9) - (clockOf(q.reset) || 9e9))[0];
      return `<section class="eng"><h2>${mark(e, "fill")}${e === "claude" ? "Claude" : "Codex"}<span class="c">${list.length} accounts · ${signed.length} signed in</span>${best ? `<span class="best">best now · <b>${esc(best.label)}</b> ${best.windows[0].left}% left${nextReset ? ` · next reset ${esc(nextReset.reset.replace("resets ", ""))}` : ""}</span>` : ""}</h2>${list.map((a) => accountRow(e, a, r.engine === e && r.id === a.id)).join("")}<button class="arow add" data-act="addAccount:${e}">${I("plus", "sm")}<span>Add a ${e === "claude" ? "Claude" : "Codex"} account</span></button></section>`;
    };
    return `<div class="accounts"><div class="acc-list">${eng("claude", F.accounts.claude)}${eng("codex", F.accounts.codex)}</div><div class="acc-detail">${accountDetail(engine, id)}</div></div>`;
  }
  function accountDetail(engine, id) {
    const a = F.accounts[engine].find((x) => x.id === id); if (!a) return "";
    const signedIn = a.auth === "Authenticated" && a.windows.length;
    const w = signedIn ? a.windows[0] : null; const pace = w ? paceOf(w) : null;
    const big = signedIn ? `<div class="bigwin">${a.windows.map((x) => { const p = paceOf(x); return `<div class="w"><div class="n"><b class="tn ${x.left <= 10 ? "low" : x.left <= 30 ? "warn" : ""}">${x.left}%</b><span>left of the ${esc(x.label)} window</span></div>${meter(x.left)}<small class="meta"><span>${esc(x.reset)}</span><span>${p.windowLeft.toFixed(1)} h of window left</span></small></div>`; }).join("")}</div>` : `<div class="quietline">This account is signed out, so it reports no windows. Sign in to read its consumption.</div>`;
    const hourly = a.hourly && a.hourly.length ? `<div class="hours">${a.hourly.map(([h, v]) => `<span class="h"><b class="tn">${v}</b><i style="height:${Math.max(3, v * 4)}%"></i><span class="tn muted">${esc(h)}</span></span>`).join("")}</div>` : `<div class="quietline">Nothing spent today.</div>`;
    const actions = `<div class="actions">${a.active ? "" : signedIn ? `<button class="btn primary" data-act="switch:${engine}:${a.id}">${I("swap", "sm")}Switch to this account</button>` : `<button class="btn primary" data-act="signin:${engine}:${a.id}">${I("key", "sm")}Sign in</button>`}${signedIn ? `${engine === "codex" ? `<button class="btn" data-act="useReset:${engine}:${a.id}" ${a.resets && a.resets.available ? "" : "disabled"}>${I("zap", "sm")}Use one reset${a.resets && a.resets.available ? ` · ${a.resets.available} left` : " · none"}</button>` : ""}<button class="btn" data-act="refresh:${engine}">${I("refresh", "sm")}Refresh</button>` : ""}</div>`;
    return `<div class="dhead">${mark(engine, "fill")}<div class="tt"><div class="t display">${esc(a.label)}</div><div class="meta"><span>${engine === "claude" ? "Claude" : "Codex"}</span><span>${esc(a.plan)}</span>${a.checked ? `<span>checked ${esc(a.checked)}</span>` : ""}</div></div>${badge(a.active ? "active" : signedIn ? "ready" : "signed out", a.active ? "b-accent" : signedIn ? "b-success" : "b-warning")}</div>
      ${big}
      ${signedIn ? `<div class="two">
        <div class="panel"><h3>Burndown <span class="c">· ${esc(w.label)} window · ideal pace against what is left</span></h3>${chart(w)}</div>
        <div class="panel"><h3>Pace</h3><div class="pace"><span class="big ${pace.ahead ? "ok" : "warn"}">burning ${pace.rate.toFixed(1)}% an hour</span><small>${pace.ahead ? "ahead of pace · spending slower than the window refills" : "behind pace · spending faster than the window refills"} · even pace would leave ${Math.round(pace.idealLeft)}% by now</small><span class="big ${pace.lasts ? "" : "warn"}">${pace.lasts ? "lasts to the reset" : `runs out at ${esc(pace.runsOut)} · ${(pace.windowLeft - pace.hoursLeft).toFixed(1)} h before the reset`}</span><small>${esc(w.reset)} · ${pace.windowLeft.toFixed(1)} h of window left</small></div></div>
      </div><div class="panel"><h3>Today by hour <span class="c">· percentage points spent</span></h3>${hourly}</div>` : ""}
      ${actions}`;
  }

  /* ── dialogs ──────────────────────────────────────────────────────────── */
  function dialogHtml(r) {
    if (!r.dialog) return "";
    const d = r.dialog;
    if (d === "settings" && r.screen === "chat") return `<div class="scrim" data-act="closeDialog"></div>${settingsSheet(conv(r.id))}`;
    const wrap = (title, body, cls) => `<div class="scrim" data-act="closeDialog"></div><div class="dialog ${cls || ""}" data-dialog role="dialog" aria-label="${esc(title)}"><div class="dhd"><span class="t display">${esc(title)}</span><button class="ib" data-act="closeDialog" aria-label="Close (Esc)">${I("x")}</button></div><div class="dbd">${body}</div></div>`;
    if (d === "search") {
      const q = (S.search || "").toLowerCase();
      const hits = F.conversations.flatMap((c) => (c.feed || []).filter((it) => it.kind !== "tool" && (!q || it.text.toLowerCase().includes(q))).map((it) => ({ c, it }))).slice(0, 8);
      return wrap("Find my messages", `<input class="field big" data-focus="search" placeholder="Search every message…" aria-label="Search" value="${esc(S.search || "")}" data-search /><div class="seg small" role="radiogroup" aria-label="Scope"><button role="radio" aria-checked="true" class="on">Everything</button><button role="radio" aria-checked="false">My messages</button><button role="radio" aria-checked="false">This project</button></div><div class="results">${hits.map(({ c, it }) => `<button class="mrow" data-go="#/chat/${c.id}"><span class="l1"><span class="t">${esc(c.title)}</span><span class="meta"><span>${esc(projectName(c.project))}</span><span>${esc(it.at)}</span></span></span><span class="snip">${esc(it.text.split("\n")[0])}</span></button>`).join("")}</div>`, "wide");
    }
    if (d === "create") return wrap("Create", `<div class="rows"><button class="drow" data-act="createConv"><span class="ico">${I("bot")}</span><span><b>Conversation</b><small>Spawn an agent in ${esc(projectName(S.project))}</small></span></button><button class="drow" data-act="createTask"><span class="ico">${I("inbox")}</span><span><b>Task</b><small>A card in the backlog until a worker takes it</small></span></button><button class="drow" data-act="createPipeline"><span class="ico">${I("layers")}</span><span><b>Pipeline</b><small>From a template: build → verify → review</small></span></button>${F.seats[S.project] ? "" : `<button class="drow" data-go="#/board/rotate"><span class="ico">${I("person")}</span><span><b>Orchestrator</b><small>Seat one for this project</small></span></button>`}</div>`);
    if (d === "menu") return wrap(r.screen === "chat" ? "Conversation" : "Board", r.screen === "chat" ? `<div class="rows">${conv(r.id).pipeline ? `<button class="drow" data-act="inspectFromChat:${conv(r.id).pipeline.id}"><span class="ico">${I("layers")}</span><span><b>Pipeline · ${esc(pipe(conv(r.id).pipeline.id).task)}</b><small>stage ${esc(conv(r.id).pipeline.stage)}</small></span></button>` : ""}<button class="drow" data-act="lift:${r.id}"><span class="ico">${I("target")}</span><span><b>Show on the yard</b><small>Lift this node in its cluster</small></span></button><button class="drow" data-act="rename:${r.id}"><span class="ico">${I("tool")}</span><span><b>Rename</b></span></button><button class="drow" data-act="handoff:${r.id}"><span class="ico">${I("swap")}</span><span><b>Hand off</b><small>Continue in a fresh conversation</small></span></button><button class="drow" data-act="kill:${r.id}"><span class="ico">${I("x")}</span><span><b>Kill the agent</b><small>Respawn stays in the receipt</small></span></button></div>` : `<div class="rows"><button class="drow" data-act="tray"><span class="ico">${I("inbox")}</span><span><b>Backlog</b><small>${M.backlog.length} tasks without a worker</small></span></button><button class="drow" data-go="#/accounts"><span class="ico">${I("person")}</span><span><b>Accounts &amp; limits</b></span></button><button class="drow" data-go="${r.base}/host"><span class="ico">${I("terminal")}</span><span><b>Host details</b><small>${F.runtime} · ${F.host.tasks.length} background tasks</small></span></button><button class="drow" data-act="unpinAll"><span class="ico">${I("undo")}</span><span><b>Release all to auto</b><small>${Object.keys(S.pins).length} pinned</small></span></button><button class="drow" data-act="archiveProject"><span class="ico">${I("archive")}</span><span><b>Archive project</b></span></button></div>`);
    if (d === "host") return wrap("Host details", `<div class="hrow"><span class="dot ${F.runtime === "connected" ? "live" : "wait"}"></span><b>${esc(F.runtime)}</b><span class="muted">· ${F.runtime === "connected" ? "updates stream" : "polling every 10 s"} · last seen ${esc(F.host.lastSeen)}</span></div><h3>Background tasks</h3>${F.host.tasks.map((t) => `<div class="hrow"><span class="t">${esc(t.name)}</span><code>${t.pid}</code><span class="muted">${esc(t.mem)} · ${esc(t.age)}</span><span class="grow"></span><button class="btn quiet" data-act="killTask:${t.pid}">Kill</button></div>`).join("")}<h3>Hidden conversations</h3>${F.host.hidden.map((h) => `<div class="hrow"><span class="t">${esc(h.title)}</span><span class="grow"></span><button class="btn quiet" data-act="reopen:${h.id}">Reopen</button></div>`).join("")}`);
    if (d === "rotate") { const s = F.seats[S.project] || { engine: "claude", model: "Opus", effort: "high", account: "Main", mandate: "" }; const d2 = S.rotate || (S.rotate = { engine: s.engine, model: s.model, effort: s.effort, account: s.account }); return wrap(F.seats[S.project] ? "Rotate the orchestrator" : "Create an orchestrator", `<div class="srow"><label>Engine</label>${seg("Engine", ["claude", "codex"], d2.engine, "rot:engine")}</div><div class="srow"><label>Model</label>${seg("Model", d2.engine === "codex" ? ["gpt-5.6", "gpt-5.5"] : ["Opus", "Sonnet"], d2.model, "rot:model")}</div><div class="srow"><label>Reasoning</label>${seg("Reasoning", ["low", "medium", "high", "xhigh", "max"], d2.effort, "rot:effort")}</div><div class="srow col"><label>Account</label><div class="alist">${F.accounts[d2.engine].map((a) => { const w = a.windows[0]; const on = d2.account === a.label; return `<button class="arow compact ${on ? "on" : ""}" role="radio" aria-checked="${on}" data-act="rot:account:${a.label}"><span class="t">${esc(a.label)}<small>${esc(a.plan)}</small></span>${w ? `${meter(w.left)}<span class="pct tn">${w.left}% left</span>` : `<span class="meter empty"><i></i></span><span class="signin">sign in ›</span>`}</button>`; }).join("")}</div></div><label class="lbl">Mandate</label><textarea class="field" rows="4" data-focus="mandate" aria-label="Mandate">${esc(s.mandate || "You are the orchestrator of this project.")}</textarea><p class="muted small">A new mandate, model or account means a successor: the current seat hands over its context and retires.</p><div class="actions"><button class="btn primary" data-act="rotateNow">${I("rotate", "sm")}${F.seats[S.project] ? "Rotate now" : "Create the orchestrator"}</button><button class="btn quiet" data-act="closeDialog">Cancel</button></div>`); }
    if (d === "keys") return wrap("Keyboard", `<table class="keys">${[["n · N", "next · previous thing that needs you (the camera follows)"], ["1 – 9", "jump to the cluster with that keycap"], ["f", "fit everything"], ["0", "fit what needs you"], ["+ · −", "zoom (Ctrl+wheel or pinch on the canvas)"], ["↑ ↓ ← →", "move the selection between clusters"], ["Enter", "lift the selected cluster's live node · again opens the conversation"], ["Esc", "lower the lift · close the inspector · close a dialog"], ["t", "backlog tray"], ["o", "the orchestrator's conversation"], ["a", "accounts & limits"], ["/", "find my messages"], ["[", "expand · collapse the rail"], ["c", "create"], ["?", "this list"]].map(([k, v]) => `<tr><td><kbd class="keycap">${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table>`);
    return "";
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  function act(spec, el) {
    const [name, ...rest] = spec.split(":");
    const arg = rest.join(":");
    const projectOf = (c) => c.project;
    switch (name) {
      case "rail": S.rail = S.rail ? 0 : 1; S.focusKey = "act:rail"; render(); break;
      case "project": S.project = arg; S.selected = null; S.lift = null; S.liftPlaced = false; go("#/board"); if (hashOf() === "#/board") render(); break;
      case "zoomIn": zoomCenter(1.25); break;
      case "zoomOut": zoomCenter(0.8); break;
      case "fitAll": fitAll(true); break;
      case "fitNeeds": fitNeeds(true); break;
      case "inspect": {
        if (route().screen === "field") { const reg = (M.regions || []).find((r) => r.clusters.some((c) => c.id === arg)); if (reg) { S.project = reg.id; S.selected = arg; S.lift = null; S.pendingFit = arg; go("#/board"); } break; }
        S.selected = arg; S.focusKey = `cluster:${arg}`; render(); fitCluster(arg, true); break;
      }
      case "jump": S.selected = arg; render(); fitCluster(arg, true); break;
      case "deselect": S.selected = null; S.editing = null; S.focusKey = "board"; render(); break;
      case "open": { const c = conv(arg); if (S.lift === arg) { go(`#/chat/${arg}`); break; } S.lift = arg; S.liftPlaced = false; S.selected = (clusterOfConv(arg) || {}).id || S.selected; render(); break; }
      case "lift": { S.lift = arg; S.liftPlaced = false; const cl = clusterOfConv(arg); if (cl) S.selected = cl.id; if (route().screen !== "board") { go("#/board"); if (hashOf() === "#/board") render(); } else render(); break; }
      case "unlift": S.lift = null; S.liftPlaced = false; S.focusKey = "board"; render(); break;
      case "backToYard": { const c = conv(arg); if (c && c.project !== S.project) S.project = c.project; go("#/board"); break; }
      case "tray": S.tray = !S.tray; S.focusKey = "act:tray"; render(); break;
      case "unpin": delete S.pins[arg]; receipt("Released to the auto layout", null); render(); break;
      case "unpinAll": S.pins = {}; receipt("Everything flows again", null); if (route().dialog) closeDialog(); else render(); break;
      case "dismissBanner": S.dismissed = true; render(); break;
      case "arrive": { const c = conv(arg); S.seen.add(arg); S.project = projectOf(c); go(`#/chat/${arg}`); break; }
      case "receiptInverse": { const r = S.receipt; S.receipt = null; if (r && r.inverse) r.inverse(); else render(); break; }
      case "closeDialog": closeDialog(); break;
      case "assign": { const t = task(arg); const c = { id: `w-${t.id}`, project: t.project, title: t.title, engine: "codex", model: "gpt-5.6", effort: "high", state: "working", elapsed: "0:03", tool: "reading the task", feed: [{ kind: "user", at: F.now, text: t.title }] }; F.conversations.push(c); t.worker = c.id; t.status = "assigned"; receipt(`A worker took «${t.title}»`, "Undo", () => { delete t.worker; t.status = "inbox"; F.conversations.splice(F.conversations.indexOf(c), 1); render(); }); render(); break; }
      case "send": { const c = conv(arg); const text = (S.drafts[c.id] || "").trim(); if (!text) break; c.feed.push({ kind: "user", at: F.now, text }); S.drafts[c.id] = ""; if (F.runtime === "offline") { c.held = "1"; receipt("Queued · sends when the host is back", null); } else { c.state = "working"; c.elapsed = "0:01"; c.tool = "thinking"; delete c.stalled; if (c.question) S.answered[c.id] = true; } render(); break; }
      case "stop": { const c = conv(arg); c.state = "returned"; c.age = "now"; delete c.elapsed; receipt("Interrupted · the agent finished its turn", null); render(); break; }
      case "kill": { const c = conv(arg); S.killed.add(arg); if (route().dialog) closeDialog(); receipt(`Killed «${c.title}»`, "Respawn", () => { S.killed.delete(arg); render(); }); render(); break; }
      case "respawn": S.killed.delete(arg); receipt("Respawned · the queue drains", null); render(); break;
      case "answer-conv": { const [id, which] = arg.split(":"); const c = conv(id); const text = which === "own" ? ($app.querySelector('[data-focus="own"]') || {}).value || "" : c.question.options[Number(which)][0]; if (!text.trim()) break; c.feed.push({ kind: "user", at: F.now, text }); S.answered[id] = true; c.state = "working"; c.elapsed = "0:01"; c.tool = "applying the answer"; render(); break; }
      case "attach": receipt("Attach: the picker opens here", null); render(); break;
      case "mic": receipt("Dictation starts here", null); render(); break;
      case "set": { const [id, key, ...v] = arg.split(":"); const val = v.join(":"); const s = S.settings[id]; if (key === "speed") s.fast = val === "fast"; else s[key] = val; S.focusKey = `act:${spec}`; render(); break; }
      case "signin": { closeDialog(); receipt(`Sign in to ${arg.split(":")[1]} · the device flow opens`, null); render(); break; }
      case "compact": closeDialog(); receipt("Compacting the context", null); render(); break;
      case "copyResume": closeDialog(); receipt("Resume command copied", null); render(); break;
      case "recheck": closeDialog(); receipt("Host re-checked · connected", null); render(); break;
      case "edit": { S.editing = arg; const [pid, sid] = arg.split(":"); const s = pipe(pid).stages.find((x) => x.id === sid); S.editDraft = { ...s }; S.focusKey = "focus:prompt"; render(); break; }
      case "ed": { const [key, ...v] = arg.split(":"); S.editDraft[key] = v.join(":"); if (key === "engine") S.editDraft.model = S.editDraft.engine === "codex" ? "gpt-5.6" : "Opus"; S.focusKey = `act:${spec}`; render(); break; }
      case "save": { const [pid, sid] = arg.split(":"); const p = pipe(pid); const s = p.stages.find((x) => x.id === sid); Object.assign(s, S.editDraft); p.revision += 1; p.log.unshift([`rev ${p.revision}`, "edit-stage", sid, "operator", "applies from the next attempt"]); S.editing = null; receipt(`Stage ${sid} saved · applies from the next attempt`, "Undo", () => { p.revision -= 1; p.log.shift(); render(); }); render(); break; }
      case "restart": { const [pid, sid] = arg.split(":"); const p = pipe(pid); const s = p.stages.find((x) => x.id === sid); Object.assign(s, S.editDraft); const a = lastAttempt(s); if (a) a.state = "passed"; s.attempts.push({ n: s.attempts.length + 1, state: "running", conv: null, sha: a ? a.sha : "" }); p.revision += 1; S.editing = null; receipt(`Stage ${sid} restarted as attempt ${s.attempts.length}`, null); render(); break; }
      case "cancelEdit": S.editing = null; render(); break;
      case "answer": { const p = pipe(arg); const s = p.stages.find((x) => x.id === p.stage); const text = ($app.querySelector('[data-focus="answer"]') || {}).value || ""; p.state = "running"; p.log.unshift([`rev ${++p.revision}`, "answer", s.id, "operator", text ? `«${text.slice(0, 40)}»` : "retry"]); const f = p.stages.find((x) => x.id === (s.onFail ? s.onFail.to : s.id)); p.stage = f.id; f.attempts.push({ n: f.attempts.length + 1, state: "running", conv: null, sha: "" }); receipt(`Answered · ${f.id} runs again`, "Undo", () => { p.state = "needs_decision"; p.stage = s.id; f.attempts.pop(); p.log.shift(); p.revision -= 1; render(); }); render(); break; }
      case "skip": { const p = pipe(arg); const s = p.stages.find((x) => x.id === p.stage); const a = lastAttempt(s); if (a) a.state = "skipped"; const i = p.stages.indexOf(s); const n = p.stages[i + 1]; if (n) { p.stage = n.id; p.state = "running"; n.attempts.push({ n: n.attempts.length + 1, state: "running", conv: null, sha: "" }); } else p.state = "completed"; receipt(`Skipped ${s.id}`, "Retry stage", () => { if (a) a.state = "failed"; if (n) n.attempts.pop(); p.stage = s.id; p.state = "needs_decision"; render(); }); render(); break; }
      case "pause": { const p = pipe(arg); p.pausedState = p.state; p.state = "paused"; receipt("Paused · nothing new spawns", "Resume", () => { p.state = p.pausedState; render(); }); render(); break; }
      case "resume": { const p = pipe(arg); p.state = p.pausedState || "running"; receipt("Resumed", null); render(); break; }
      case "archive": { const p = pipe(arg); const was = p.state; p.state = "closed"; F.pipelines.splice(F.pipelines.indexOf(p), 1); S.selected = null; receipt(`Archived «${p.task}»`, "Restore", () => { p.state = was; F.pipelines.push(p); render(); }); render(); break; }
      case "start": { const p = pipe(arg); p.state = "running"; p.stage = p.stages[0].id; p.stages[0].attempts.push({ n: 1, state: "running", conv: null, sha: "" }); receipt("Started · attempt 1 spawns", "Pause", () => { p.state = "paused"; render(); }); render(); break; }
      case "rerun": { const p = pipe(arg); p.state = "running"; p.stage = p.stages[0].id; p.stages[0].attempts.push({ n: p.stages[0].attempts.length + 1, state: "running", conv: null, sha: "" }); receipt("Re-running from the first stage", null); render(); break; }
      case "switch": { const [engine, id] = arg.split(":"); const prev = F.accounts[engine].find((a) => a.active); F.accounts[engine].forEach((a) => { a.active = a.id === id; }); receipt(`Switched to ${F.accounts[engine].find((a) => a.id === id).label}`, "Switch back", () => { F.accounts[engine].forEach((a) => { a.active = a.id === prev.id; }); render(); }); render(); break; }
      case "useReset": { const [engine, id] = arg.split(":"); const a = F.accounts[engine].find((x) => x.id === id); a.resets.available -= 1; a.windows[0].left = 100; a.windows[0].elapsed = 0; a.windows[0].series = [[0, 100]]; receipt("Reset used · the 5 h window is full", null); render(); break; }
      case "refresh": receipt("Limits refreshed", null); render(); break;
      case "addAccount": receipt("A new account starts with the device sign-in", null); render(); break;
      case "createConv": closeDialog(); receipt("A new conversation opens in the yard", null); render(); break;
      case "createTask": { closeDialog(); F.tasks.push({ id: `n${Date.now() % 10000}`, project: S.project, title: "New task", issue: null, status: "inbox" }); S.tray = true; receipt("Task added to the backlog", null); render(); break; }
      case "createPipeline": closeDialog(); receipt("Pick a template · the draft lands in the yard", null); render(); break;
      case "inspectFromChat": { const c = pipe(arg); S.project = c.project; S.selected = arg; S.lift = null; go("#/board"); break; }
      case "rename": closeDialog(); receipt("Rename: the title becomes a field", null); render(); break;
      case "handoff": closeDialog(); receipt("Hand-off draft created", "Undo", () => render()); render(); break;
      case "rot": { const [key, ...v] = arg.split(":"); S.rotate[key] = v.join(":"); if (key === "engine") S.rotate.model = S.rotate.engine === "codex" ? "gpt-5.6" : "Opus"; S.focusKey = `act:${spec}`; render(); break; }
      case "rotateNow": { const r = S.rotate; const s = F.seats[S.project] || (F.seats[S.project] = { conv: "seat-new", ctx: { left: 100, window: "100k" }, since: "now", plan: "Max plan" }); Object.assign(s, { engine: r.engine, model: r.model, effort: r.effort, account: r.account, state: "live", predecessor: true, since: "now" }); if (!conv(s.conv)) F.conversations.push({ id: s.conv, project: S.project, seat: true, title: `${projectName(S.project)} orchestrator`, engine: r.engine, model: r.model, effort: r.effort, state: "working", elapsed: "0:02", feed: [{ kind: "agent", at: F.now, text: "Ready. Reading the mandate." }] }); closeDialog(); receipt("Successor seated · the predecessor hands over", null); go(`#/chat/${s.conv}`); break; }
      case "archiveProject": closeDialog(); receipt(`Archived ${projectName(S.project)}`, "Restore", () => render()); render(); break;
      case "killTask": closeDialog(); receipt(`Killed ${arg}`, "Respawn", () => render()); render(); break;
      case "reopen": closeDialog(); receipt("Reopened in the yard", null); render(); break;
      default: break;
    }
    void el;
  }

  /* ── input ────────────────────────────────────────────────────────────── */
  $app.addEventListener("click", (e) => {
    if (suppressClick) { e.preventDefault(); return; }
    const goEl = e.target.closest("[data-go]");
    if (goEl && goEl.dataset.go) {
      e.preventDefault();
      const hash = goEl.dataset.go;
      const isDialog = DIALOGS.some((d) => hash.endsWith(`/${d}`));
      if (isDialog) { S.trigger = keyOf(goEl); go(hash, true); }
      else { if (goEl.closest("[data-dialog]")) closeDialogSilently(); go(hash); }
      return;
    }
    const actEl = e.target.closest("[data-act]");
    if (actEl) { e.preventDefault(); act(actEl.dataset.act, actEl); }
  });
  $app.addEventListener("input", (e) => { if (e.target.matches("[data-search]")) { S.search = e.target.value; const res = $app.querySelector(".results"); if (res) { const tmp = document.createElement("div"); tmp.innerHTML = dialogHtml(route()); res.innerHTML = tmp.querySelector(".results").innerHTML; } } });
  function closeDialogSilently() { history.replaceState(null, "", route().base); }
  const keyOf = (el) => el.dataset.go ? `go:${el.dataset.go}` : el.dataset.act ? `act:${el.dataset.act}` : el.dataset.focus ? `focus:${el.dataset.focus}` : el.dataset.cluster ? `cluster:${el.dataset.cluster}` : null;

  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); };
  window.addEventListener("keydown", (e) => {
    const r = route();
    if (e.key === "Escape") {
      if (r.dialog) { e.preventDefault(); closeDialog(); return; }
      if (typing() && r.screen === "chat") { e.preventDefault(); act(`backToYard:${r.id}`); return; }
      if (typing()) { e.preventDefault(); document.activeElement.blur(); S.focusKey = "board"; restoreFocus(r); return; }
      if (r.screen === "chat") { e.preventDefault(); act(`backToYard:${r.id}`); return; }
      if (S.lift) { e.preventDefault(); act("unlift"); return; }
      if (S.editing) { e.preventDefault(); act("cancelEdit"); return; }
      if (S.selected) { e.preventDefault(); act("deselect"); return; }
      return;
    }
    if (typing() || r.dialog) {
      if (r.dialog) trapTab(e);
      return;
    }
    const k = e.key;
    if (k === "n" || k === "N") { e.preventDefault(); walkNeeds(k === "n" ? 1 : -1); return; }
    if (/^[1-9]$/.test(k) && r.screen === "board") { const cl = M.clusters.find((c) => c.key === Number(k)); if (cl) { e.preventDefault(); act(`inspect:${cl.id}`); } return; }
    if (k === "f") { e.preventDefault(); fitAll(true); return; }
    if (k === "0") { e.preventDefault(); fitNeeds(true); return; }
    if (k === "+" || k === "=") { e.preventDefault(); zoomCenter(1.25); return; }
    if (k === "-") { e.preventDefault(); zoomCenter(0.8); return; }
    if (k === "t" && r.screen === "board") { e.preventDefault(); act("tray"); return; }
    if (k === "i") { const f = $app.querySelector('.lift [data-focus="field"], .chat [data-focus="field"]'); if (f) { e.preventDefault(); f.focus(); } return; }
    if (k === "o") { e.preventDefault(); const s = F.seats[S.project]; if (s) go(`#/chat/${s.conv}`); else go("#/board/rotate", true); return; }
    if (k === "a") { e.preventDefault(); go("#/accounts"); return; }
    if (k === "/") { e.preventDefault(); S.trigger = null; go(`${r.base}/search`, true); return; }
    if (k === "?") { e.preventDefault(); go(`${r.base}/keys`, true); return; }
    if (k === "[") { e.preventDefault(); act("rail"); return; }
    if (k === "c") { e.preventDefault(); go(`${r.base}/create`, true); return; }
    if (k === "Enter" && r.screen === "board") {
      e.preventDefault();
      if (S.lift) { go(`#/chat/${S.lift}`); return; }
      const cl = S.selected ? clusterById(S.selected) : null;
      if (cl) { const n = cl.nodes.find((x) => x.conv && NEEDS.has(stateBits(x.conv).key)) || cl.nodes.find((x) => x.conv); if (n) act(`open:${n.conv.id}`); }
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k) && r.screen === "board") { e.preventDefault(); moveSelection(k); }
  });
  function trapTab(e) {
    if (e.key !== "Tab") return;
    const d = $app.querySelector("[data-dialog]"); if (!d) return;
    const f = [...d.querySelectorAll("button, input, textarea, select, a[href], [tabindex='0']")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  }
  function walkNeeds(dir) {
    const q = needsQueue(S.project);
    if (!q.length) return;
    let i = q.findIndex((x) => (x.kind === "conv" ? x.conv === S.lift : x.cluster === S.selected && !S.lift));
    i = (i + dir + q.length) % q.length;
    const it = q[i];
    if (route().screen !== "board") { go("#/board"); }
    if (it.kind === "conv") act(`open:${it.conv}`); else act(`inspect:${it.cluster}`);
  }
  function moveSelection(key) {
    const cur = S.selected ? clusterById(S.selected) : null;
    if (!cur) { const first = M.clusters[0]; if (first) act(`inspect:${first.id}`); return; }
    const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    let best = null, bestD = Infinity;
    for (const c of M.clusters) {
      if (c === cur) continue;
      const dx = c.x + c.w / 2 - cx, dy = c.y + c.h / 2 - cy;
      const along = dx * dir[0] + dy * dir[1]; if (along <= 0) continue;
      const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
      const d = along + across * 2.5;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) act(`inspect:${best.id}`);
  }

  /* Where the focus lands after a render: a stage's primary target, a dialog's
     first control, or the element identified by S.focusKey. Never the body. */
  function restoreFocus(r) {
    const key = S.focusKey; S.focusKey = null;
    const byKey = (k) => {
      if (!k) return null;
      if (k === "board") return $app.querySelector("[data-board]");
      const [kind, ...rest] = k.split(":"); const v = rest.join(":");
      if (kind === "go") return $app.querySelector(`[data-go="${CSS.escape(v)}"]`);
      if (kind === "act") return $app.querySelector(`[data-act="${CSS.escape(v)}"]`);
      if (kind === "focus") return $app.querySelector(`[data-focus="${CSS.escape(v)}"]`);
      if (kind === "cluster") return $app.querySelector(`.cluster[data-cluster="${CSS.escape(v)}"] .tile`);
      return null;
    };
    let el = byKey(key);
    if (!el && r.dialog) { const d = $app.querySelector("[data-dialog]"); el = d && (d.querySelector("[data-focus]") || d.querySelector("button, input, textarea")); }
    if (!el && r.screen === "chat") el = $app.querySelector('.qcard [data-focus="opt0"]') || $app.querySelector('[data-focus="field"]');
    if (!el && r.screen === "accounts") el = $app.querySelector(".arow.on") || $app.querySelector(".arow");
    if (!el && S.lift) el = $app.querySelector('.lift .qcard [data-focus="opt0"]') || $app.querySelector('.lift[data-focus="lift"]');
    if (!el && S.selected) el = $app.querySelector('.inspector [data-focus="answer"]') || $app.querySelector(".inspector .ib");
    if (!el) el = $app.querySelector("[data-board]") || $app.querySelector("button");
    if (el) el.focus({ preventScroll: true });
  }

  /* ── the bench ────────────────────────────────────────────────────────── */
  function layoutBench() {
    const big = innerWidth > FRAME_W + 40 && innerHeight > FRAME_H + 120;
    $bench.hidden = !big;
    $frame.style.width = big ? `${FRAME_W}px` : "100vw";
    $frame.style.height = big ? `${FRAME_H}px` : "100vh";
    document.body.classList.toggle("bench", big);
    if (big && !$bench.innerHTML) {
      const link = (s) => { const u = new URL(location.href); u.search = `?scheme=${scheme}&w=${FRAME_W}${s.scenario ? `&scenario=${s.scenario}` : ""}${s.query ? `&${s.query}` : ""}`; u.hash = s.hash; return `<a href="${u.toString()}" ${s.w && !s.w.includes(String(FRAME_W)) ? 'class="dim"' : ""}>${esc(s.id)}</a>`; };
      const opt = (k, v, cur) => { const u = new URL(location.href); u.searchParams.set(k, v); return `<a href="${u.toString()}" class="${String(cur) === String(v) ? "on" : ""}">${esc(v)}</a>`; };
      $bench.innerHTML = `<div class="bl"><b>desktop v2 · the yard</b> ${[1280, 1440, 1920].map((w) => opt("w", w, FRAME_W)).join("")} · ${["dark", "light"].map((s) => opt("scheme", s, scheme)).join("")} · <span class="muted">scenario: ${esc(scenario || "none")}</span></div><div class="bl links">${window.SCREENS.map(link).join("")}</div>`;
    }
  }
  window.addEventListener("resize", () => { layoutBench(); if (boardEl()) applyCamera(); });
  window.addEventListener("hashchange", () => { S.zoomApplied = true; render(); });
  window.__proto = { counts, clustersOf, needsQueue, cam, S, F, fitCluster, fitAll, pack, model: () => M };
  layoutBench();
  render();
})();
