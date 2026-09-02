import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CANVAS,
  DRIVERS,
  evaluateGates,
  FLOWS,
  GATE_IDS,
  HOOKS,
  LANDSCAPE_SCREENS,
  parseArgs,
  runFlows,
  SCENARIOS,
  SCREENS,
  seedHome,
  summarize,
  type FlowPage,
  type FlowResult,
  type FrameResult,
  type Geometry,
  type Control,
} from "./capture-mobile-v2";

/*
 * The mobile-v2 capture harness (issue #1439, lane 0) is the evidence tool
 * every later lane's reviewer uses, so what this file pins is that the tool
 * can say NO: each gate goes red on the one geometry it exists to refuse, each
 * §3.3 flow goes red on the one contract breach it exists to catch, the
 * strictness switch turns those reds into an exit code, and the run allocates
 * its own directory before it renders anything (the #979 refusal-by-name).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "capture-mobile-v2.ts");
const ids = (failures: { gate: string }[]) => failures.map((f) => f.gate);

/* ── screens ─────────────────────────────────────────────────────────────── */

describe("screens", () => {
  test("the matrix is the prototype's screen list, state screens included, and every id has a driver", () => {
    const stateScreens = ["board-noseat", "board-degraded", "board-crowded", "chat-arrival", "chat-offline", "chat-held", "chat-limit", "chat-stalled"];
    const known = SCREENS.map((s) => s.id);
    for (const id of stateScreens) expect(known).toContain(id);
    expect(known.length).toBeGreaterThanOrEqual(29);
    for (const id of known) expect(typeof DRIVERS[id]).toBe("function");
    for (const screen of SCREENS) if (screen.scenario) expect(SCENARIOS[screen.scenario]).toBeDefined();
    for (const id of LANDSCAPE_SCREENS) expect(known).toContain(id);
  });
});

/* ── arguments ───────────────────────────────────────────────────────────── */

describe("parseArgs", () => {
  test("defaults: not strict, every screen, flows on", () => {
    expect(parseArgs([])).toEqual({ strict: false, only: [], flows: true });
  });
  test("--strict turns strictness on; --only and MOBILE_V2_ONLY narrow the matrix and skip the flows", () => {
    expect(parseArgs(["--strict"]).strict).toBe(true);
    const only = parseArgs(["--only=board,chat-working"]);
    expect(only.only).toEqual(["board", "chat-working"]);
    expect(only.flows).toBe(false);
    expect(parseArgs([], { MOBILE_V2_ONLY: "accounts" }).only).toEqual(["accounts"]);
    expect(parseArgs(["--no-flows"]).flows).toBe(false);
  });
  test("an unknown flag or an unknown screen is refused by name", () => {
    expect(() => parseArgs(["--loose"])).toThrow(/unknown argument --loose/);
    expect(() => parseArgs(["--only=board,bench"])).toThrow(/bench/);
  });
});

/* ── gates ───────────────────────────────────────────────────────────────── */

const control = (label: string, x: number, y: number, w = 44, h = 44, extra: Partial<Control> = {}): Control =>
  ({ tag: "button", label, rect: { x, y, w, h }, small: w < 43.5 || h < 43.5, inReceipt: null, ...extra });

/** A frame the prototype would produce: one bar, three targets, a composer
    above a 336 px keyboard, the dark canvas. */
function green(): Geometry {
  return {
    scrollWidth: 390,
    innerWidth: 390,
    canvas: CANVAS.dark,
    benchShown: false,
    controls: [control("‹", 0, 4), control("⚠ 3", 240, 4, 56), control("⋯", 342, 4), control("send", 338, 456)],
    title: { w: 236 },
    send: { bottom: 500 },
    field: { top: 420 },
    receipts: [],
    scrollY: 0,
    visibleBottom: 508,
  };
}
const dark = { scheme: "dark" as const, keyboard: true, width: 390, height: 844 };

describe("gates", () => {
  test("a frame within every budget passes every gate", () => {
    expect(evaluateGates(green(), dark)).toEqual([]);
  });
  test("overflow: a document wider than the viewport", () => {
    expect(ids(evaluateGates({ ...green(), scrollWidth: 564 }, dark))).toEqual(["overflow"]);
  });
  test("bench: desktop chrome inside the phone viewport", () => {
    expect(ids(evaluateGates({ ...green(), benchShown: true }, dark))).toEqual(["bench"]);
  });
  test("hit: one control under 44 px", () => {
    const g = green();
    g.controls.push(control("Dictate", 300, 800, 32, 32));
    const failures = evaluateGates(g, dark);
    expect(ids(failures)).toEqual(["hit"]);
    expect(failures[0].message).toContain("Dictate");
  });
  test("overlap: two controls whose rects intersect", () => {
    const g = green();
    g.controls.push(control("Rename", 146, 182), control("Kill", 184, 182));
    const failures = evaluateGates(g, dark);
    expect(ids(failures)).toEqual(["overlap"]);
    expect(failures[0].message).toContain("Rename");
    expect(failures[0].message).toContain("Kill");
  });
  test("overlap: a control clipped away by its scroller does not count", () => {
    const g = green();
    /* Its unclipped box is a full 44 px row; the scroller clipped it to nothing. */
    g.controls.push(control("row under the dock", 0, 456, 390, 0, { small: false }));
    expect(evaluateGates(g, dark)).toEqual([]);
  });
  test("receipt: a receipt covering a control outside itself", () => {
    const g = green();
    g.receipts.push({ x: 0, y: 440, w: 390, h: 60 });
    const failures = evaluateGates(g, dark);
    expect(ids(failures)).toEqual(["receipt"]);
    expect(failures[0].message).toContain("send");
  });
  test("receipt: its own inverse action inside it is not covered", () => {
    const g = green();
    g.controls = g.controls.filter((c) => c.label !== "send");
    g.controls.push(control("Respawn", 320, 448, 60, 44, { inReceipt: 0 }));
    g.receipts.push({ x: 0, y: 440, w: 390, h: 60 });
    g.send = { bottom: 400 };
    expect(evaluateGates(g, dark)).toEqual([]);
  });
  test("scheme: the light canvas under the dark scheme, and the other way round", () => {
    expect(ids(evaluateGates({ ...green(), canvas: CANVAS.light }, dark))).toEqual(["scheme"]);
    expect(ids(evaluateGates({ ...green(), canvas: CANVAS.dark }, { ...dark, scheme: "light" }))).toEqual(["scheme"]);
    expect(evaluateGates({ ...green(), canvas: CANVAS.light }, { ...dark, scheme: "light" })).toEqual([]);
  });
  test("title: a title cell under 190 px, or none at all — portrait only", () => {
    expect(ids(evaluateGates({ ...green(), title: { w: 175 } }, dark))).toEqual(["title"]);
    expect(ids(evaluateGates({ ...green(), title: null }, dark))).toEqual(["title"]);
    expect(evaluateGates({ ...green(), title: { w: 120 } }, { ...dark, keyboard: false, landscape: true, width: 844, height: 390 })).toEqual([]);
  });
  test("keyboard: send under the keyboard, field above the bar, a scrolled window, no composer", () => {
    expect(ids(evaluateGates({ ...green(), send: { bottom: 560 } }, dark))).toEqual(["keyboard"]);
    expect(ids(evaluateGates({ ...green(), field: { top: 40 } }, dark))).toEqual(["keyboard"]);
    expect(ids(evaluateGates({ ...green(), scrollY: 120 }, dark))).toEqual(["keyboard"]);
    expect(ids(evaluateGates({ ...green(), send: null }, dark))).toEqual(["keyboard"]);
    /* Outside the keyboard frame the same geometry is not measured. */
    expect(evaluateGates({ ...green(), send: { bottom: 560 } }, { ...dark, keyboard: false })).toEqual([]);
  });
  test("console: a page error", () => {
    expect(ids(evaluateGates(green(), { ...dark, consoleErrors: ["TypeError: x is not a function"] }))).toEqual(["console"]);
  });
  test("every gate id is one the gates can emit", () => {
    const g = green();
    g.scrollWidth = 564; g.benchShown = true; g.canvas = "rgb(1, 2, 3)"; g.title = { w: 10 }; g.scrollY = 5;
    g.controls.push(control("tiny", 0, 100, 20, 20), control("a", 100, 100), control("b", 120, 100));
    g.receipts.push({ x: 0, y: 440, w: 390, h: 60 });
    const emitted = new Set(ids(evaluateGates(g, { ...dark, consoleErrors: ["boom"] })));
    for (const gate of GATE_IDS) expect(emitted.has(gate)).toBe(true);
  });
});

/* ── summary and exit code ───────────────────────────────────────────────── */

const frame = (id: string, gates: FrameResult["gates"] = [], reached = true): FrameResult =>
  ({ frame: "390x844", scheme: "dark", id, title: id, file: `390x844/dark/${id}.png`, reached, note: reached ? "" : "today's board", gates });
const flow = (id: string, status: FlowResult["status"]): FlowResult => ({ id, title: id, status, detail: status === "green" ? "" : "why" });

describe("summarize", () => {
  test("not strict: reds are reported and the run still exits 0", () => {
    const s = summarize([frame("board", [{ gate: "title", message: "175px" }], false)], [flow("pipeline-stage-back", "unreached")], false);
    expect(s.exitCode).toBe(0);
    expect(s.red).toBe(1);
    expect(s.unreached).toBe(1);
    expect(s.lines.join("\n")).toContain("[title] 175px");
    expect(s.lines.join("\n")).toContain("not reached");
  });
  test("strict: a red gate fails the run", () => {
    expect(summarize([frame("board", [{ gate: "hit", message: "32×32" }])], [], true).exitCode).toBe(1);
  });
  test("strict: an unreached screen fails the run", () => {
    expect(summarize([frame("board-menu", [], false)], [], true).exitCode).toBe(1);
  });
  test("strict: a red or unreached flow fails the run", () => {
    expect(summarize([frame("board")], [flow("swipe-walks-switcher", "red")], true).exitCode).toBe(1);
    expect(summarize([frame("board")], [flow("swipe-walks-switcher", "unreached")], true).exitCode).toBe(1);
  });
  test("strict: all green exits 0", () => {
    const s = summarize([frame("board"), frame("chat-working")], [flow("pipeline-stage-back", "green")], true);
    expect(s.exitCode).toBe(0);
    expect(s.lines.at(-1)).toBe("strict: green");
  });
});

/* ── the §3.3 flows over a model of the hook contract ────────────────────── */

interface Breach {
  backKeepsSheet?: boolean;
  sheetPushesHistory?: boolean;
  closeResetsScroll?: boolean;
  swipeVisitsRecent?: boolean;
  noBump?: boolean;
  backFromStageLandsOnBoard?: boolean;
  /** The product before lane 1: no hook anywhere. */
  noHooks?: boolean;
}

/** The smallest phone that honours §3.3: screens push, sheets replace, a
    sibling switch replaces the top, back pops. `breach` breaks one rule. */
function phone(breach: Breach = {}): FlowPage {
  const order = ["orch", "c2", "c6", "c1", "c5", "c9"];
  const recent = ["c3"];
  const stack: string[] = ["board"];
  let sheet: string | null = null;
  let conversation = "c1";
  let feedScroll = 0;
  let bump = false;
  const top = () => stack[stack.length - 1];
  const has = async (selector: string): Promise<boolean> => {
    if (breach.noHooks) return false;
    const screen = /\[data-mobile2-screen="(\w+)"\]/.exec(selector)?.[1];
    if (screen) return top() === screen;
    const named = /\[data-mobile2-sheet="(\w+)"\]/.exec(selector)?.[1];
    if (named) return sheet === named;
    if (selector === "[data-mobile2-sheet]") return sheet !== null;
    if (selector === "[data-mobile2-feed]") return top() === "chat";
    if (selector === "[data-mobile2-bump]") return bump;
    return false;
  };
  const tap = async (selector: string): Promise<boolean> => {
    if (breach.noHooks) return false;
    const open = /\[data-mobile2-open="(\w+)"\]/.exec(selector)?.[1];
    if (open) { sheet = open; if (breach.sheetPushesHistory) stack.push(`${top()}+sheet`); return true; }
    if (selector === "[data-mobile2-close]") { if (!sheet) return false; sheet = null; if (breach.closeResetsScroll) feedScroll = 0; return true; }
    if (selector === HOOKS.go("pipelines")) { if (top() !== "board") return false; stack.push("pipelines"); return true; }
    if (selector === "[data-mobile2-pipeline-row]") { if (top() !== "pipelines") return false; stack.push("pipeline"); return true; }
    if (selector === `[data-mobile2-stage]${HOOKS.go("chat")}`) { if (top() !== "pipeline") return false; conversation = "c8"; stack.push("chat"); return true; }
    if (selector === HOOKS.go("accounts")) { if (sheet !== "menu") return false; sheet = null; stack.push("accounts"); return true; }
    if (selector === "[data-mobile2-back]") {
      if (stack.length <= 1) return false;
      stack.pop();
      if (breach.backFromStageLandsOnBoard) stack.splice(1);
      return true;
    }
    return false;
  };
  return {
    board: async () => { stack.splice(0, stack.length, "board"); sheet = null; bump = false; },
    chat: async () => { stack.splice(0, stack.length, "board", "chat"); sheet = null; conversation = "c1"; feedScroll = 0; bump = false; },
    has,
    tap,
    attr: async (selector, name) => (await has(selector)) && name === "data-mobile2-conversation" ? conversation : null,
    list: async (selector, name) => {
      if (!selector.startsWith(HOOKS.sheetOf("switch")) || sheet !== "switch") return [];
      const rows = [...order.map((id) => ({ id, section: id === "orch" ? "orchestrator" : "working" })), ...recent.map((id) => ({ id, section: "recent" }))];
      return rows.map((row) => (name === "data-mobile2-conversation" ? row.id : row.section));
    },
    back: async () => { if (stack.length > 1) stack.pop(); if (!breach.backKeepsSheet) sheet = null; },
    historyLength: async () => stack.length,
    scrollTop: async (selector) => (selector === "[data-mobile2-feed]" && top() === "chat" ? feedScroll : null),
    setScrollTop: async (_selector, value) => { feedScroll = value; },
    swipe: async (_selector, dir) => {
      const list = breach.swipeVisitsRecent ? [...order, ...recent] : order;
      const i = list.indexOf(conversation);
      const next = dir === "left" ? i + 1 : i - 1;
      if (next < 0 || next >= list.length) { bump = !breach.noBump; return; }
      conversation = list[next];
    },
  };
}

const byId = (results: FlowResult[]) => Object.fromEntries(results.map((r) => [r.id, r]));

describe("flows", () => {
  test("a phone that honours §3.3 passes every flow", async () => {
    const results = await runFlows(phone());
    expect(results.map((r) => r.id)).toEqual(FLOWS.map((f) => f.id));
    for (const r of results) expect(`${r.id}: ${r.status} ${r.detail}`).toBe(`${r.id}: green `);
  });
  test("the product before lane 1 reports every flow as not reached, none as red", async () => {
    for (const r of await runFlows(phone({ noHooks: true }))) expect(r.status).toBe("unreached");
  });
  test("‹ from a stage conversation landing on the board goes red", async () => {
    const r = byId(await runFlows(phone({ backFromStageLandsOnBoard: true })));
    expect(r["pipeline-stage-back"].status).toBe("red");
    expect(r["pipeline-stage-back"].detail).toContain("did not land on the pipeline");
  });
  test("browser back that lands on a sheet route goes red", async () => {
    const r = byId(await runFlows(phone({ backKeepsSheet: true })));
    expect(r["menu-accounts-browser-back"].status).toBe("green");
    expect(r["back-with-sheet-pops-screen"].status).toBe("red");
    expect(r["back-with-sheet-pops-screen"].detail).toContain("left a sheet");
  });
  test("a sheet that creates a history entry goes red", async () => {
    const r = byId(await runFlows(phone({ sheetPushesHistory: true })));
    expect(r["sheet-creates-no-history"].status).toBe("red");
    expect(r["sheet-creates-no-history"].detail).toContain("grew history");
  });
  test("closing ⚠ that loses the feed's scroll offset goes red", async () => {
    const r = byId(await runFlows(phone({ closeResetsScroll: true })));
    expect(r["attention-close-keeps-scroll"].status).toBe("red");
    expect(r["attention-close-keeps-scroll"].detail).toContain("scrollTop 0");
  });
  test("a swipe that visits Recent, or one that does not bump at the end, goes red", async () => {
    const visits = byId(await runFlows(phone({ swipeVisitsRecent: true })));
    expect(visits["swipe-walks-switcher"].status).toBe("red");
    expect(visits["swipe-walks-switcher"].detail).toContain("c3");
    const flat = byId(await runFlows(phone({ noBump: true })));
    expect(flat["swipe-walks-switcher"].status).toBe("red");
    expect(flat["swipe-walks-switcher"].detail).toContain("did not bump");
  });
});

/* ── the seeded home ─────────────────────────────────────────────────────── */

describe("seedHome", () => {
  test("writes an invented project with one transcript per seed, a private credentials file, and no path outside the sandbox", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1439-seed-"));
    try {
      const home = seedHome(base);
      expect(home.repoDir.startsWith(base)).toBe(true);
      const projects = path.join(home.home, ".claude", "projects");
      const [folder] = fs.readdirSync(projects);
      const transcripts = fs.readdirSync(path.join(projects, folder)).filter((f) => f.endsWith(".jsonl"));
      /* nine prototype conversations plus the crowded scenario's twenty-one lanes */
      expect(transcripts.length).toBe(30);
      for (const name of transcripts) {
        for (const line of fs.readFileSync(path.join(projects, folder, name), "utf8").trim().split("\n")) {
          const record = JSON.parse(line) as { cwd: string };
          expect(record.cwd).toBe(home.repoDir);
        }
      }
      expect(fs.statSync(path.join(home.home, ".claude", ".credentials.json")).mode & 0o077).toBe(0);
      expect(fs.statSync(home.outDir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

/* ── directory allocation (the #979 refusal-by-name) ─────────────────────── */

function runCapture(sandbox: string, captureDir: string) {
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
  fs.mkdirSync(sanctionedTemp, { recursive: true });
  /* No PATH and no browser: the subprocess dies right after the allocation
     and the seeding, which is exactly the window under test. */
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      NODE_ENV: "test",
      PATH: "",
      HOME: path.join(sandbox, "home"),
      TMPDIR: sanctionedTemp,
      XDG_CONFIG_HOME: path.join(sandbox, "xdg"),
      LLV_STATE_DIR: path.join(sandbox, "state"),
      NEXT_TELEMETRY_DISABLED: "1",
      CHROME_BIN: path.join(sandbox, "missing-browser"),
      MOBILE_V2_CAPTURE_DIR: captureDir,
    },
  });
}

describe("capture directory", () => {
  test("an override outside the temp root is refused by name, and its contents survive", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1439-refusal-"));
    const fixture = path.join(sandbox, "outside-temp", "llv-issue-1439-operator-data");
    const sentinel = path.join(fixture, "keep.txt");
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(sentinel, "keep", "utf8");
    try {
      const result = runCapture(sandbox, fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MOBILE_V2_CAPTURE_DIR");
      expect(result.stderr).toContain(fixture);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("no override lands one fresh run under the temp root, seeds its home and out, and publishes the latest link", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1439-default-"));
    const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
    try {
      const result = runCapture(sandbox, "");
      expect(result.status).not.toBe(0);
      const latest = path.join(sanctionedTemp, "llv-issue-1439-latest");
      expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
      const run = fs.realpathSync(latest);
      expect(path.dirname(run)).toBe(fs.realpathSync(sanctionedTemp));
      expect(fs.statSync(path.join(run, "home")).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(run, "out")).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
