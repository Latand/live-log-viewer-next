import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry } from "@/lib/types";
import type { LogTailState } from "@/hooks/useLogTail";

const dom = new Window({ width: 390, height: 844 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
});
const previousFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
const { LogFeed } = await import("./LogFeed");
const { setLogFeedDependenciesForTests } = await import("./logFeedDependencies");

// Native Codex envelopes, with synthetic content/identities. Actual parser and
// FeedItem stay mounted. Geometry comes from committed DOM attributes, so the
// before-mutation snapshot sees old layout and the layout phase sees insertion.
const message = (id: string, role = "assistant") => JSON.stringify({ type: "response_item", payload: {
  type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text: id }],
}});
const tool = (id: string) => JSON.stringify({ type: "response_item", payload: {
  type: "custom_tool_call", call_id: id, name: "exec", input: "{}",
}});
const lines = [message("older-user", "user"), message("older-answer"), message("boundary", "user"),
  tool("tool-a"), tool("tool-b"), message("answer"), message("next", "user"), message("last")];
let root: Root | undefined;
let host: HTMLDivElement;
let tail: LogTailState;
let file: FileEntry;
let finish: (count: number) => void;
let calls: number;
const render = () => flushSync(() => root!.render(<LogFeed file={file} showSvc={false} lineFilter=""
  onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} />));
const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
let serial = 0;
async function mount(fixture = lines) {
  calls = 0;
  tail = { lines: fixture.slice(3), linesStart: 3, size: 1000, loading: false, error: null,
    tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: true, loadingOlder: false,
    loadOlder: () => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); }, prependGen: 0 };
  setLogFeedDependenciesForTests({ useLogTail: () => tail });
  file = { path: `/fixture/prepend-${++serial}`, name: "fixture", root: "fixture", engine: "codex",
    fmt: "codex", kind: "session", size: 1000, mtime: 0, activity: "idle" } as unknown as FileEntry;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  render(); await wait(); render();
  const scroller = host.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
  const prepended = () => scroller.dataset.tailLinesStart === "0";
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => prepended() ? 2400 : 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 500 });
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    const key = this.getAttribute("data-feed-key");
    if (!key) return original.call(this);
    const source = Number(key.split(":")[1]);
    const top = (source < 3 ? source * 100 : 400 + (source - 3) * 100) + (prepended() && source >= 3 ? 400 : 0) - scroller.scrollTop;
    return new dom.DOMRect(0, top, 390, 100);
  };
  restoreGeometry = () => { dom.HTMLElement.prototype.getBoundingClientRect = original; };
  scroller.scrollTop = 80;
  return scroller;
}
let restoreGeometry = () => {};
afterEach(async () => {
  if (root) flushSync(() => root!.unmount()); root = undefined;
  host?.remove(); restoreGeometry(); setLogFeedDependenciesForTests(null);
  await dom.happyDOM.abort();
});
afterAll(() => { globalThis.fetch = previousFetch; });
function request() {
  const button = [...host.querySelectorAll("button")].find((button) => /earlier/i.test(button.textContent ?? ""));
  expect(button).toBeDefined(); flushSync(() => button!.click());
}
for (const movement of [0, 60, -60]) {
  test(`pending prepend preserves current group offset with movement ${movement}`, async () => {
    const scroller = await mount(); request();
    scroller.scrollTop = 80 + movement;
    const key = "group:3:0";
    const offset = () => host.querySelector<HTMLElement>(`[data-feed-key="${key}"]`)!.getBoundingClientRect().top;
    const before = offset();
    tail = { ...tail, lines, linesStart: 0, prependGen: 1, hasMore: false };
    render(); finish(3); await wait(); render();
    expect(offset()).toBe(before);
    expect(scroller.scrollTop).toBe(480 + movement);
    expect([...host.querySelectorAll("[data-feed-key]")].map((row) => row.getAttribute("data-feed-key")))
      .toEqual(["row:0:0", "row:1:0", "row:2:0", "group:3:0", "row:5:0", "row:6:0", "row:7:0"]);
  });
}

test("interleaved tail growth and media below the reader do not enter prepend compensation", async () => {
  const scroller = await mount(); request(); scroller.scrollTop = 140;
  tail = { ...tail, lines: [...tail.lines, message("tail-arrival")] }; render();
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => tail.prependGen ? 3300 : 2900 });
  const before = host.querySelector<HTMLElement>('[data-feed-key="group:3:0"]')!.getBoundingClientRect().top;
  tail = { ...tail, lines: [...lines, message("tail-arrival")], linesStart: 0, prependGen: 1 }; render();
  finish(3); await wait();
  expect(scroller.scrollTop).toBe(540);
  expect(host.querySelector<HTMLElement>('[data-feed-key="group:3:0"]')!.getBoundingClientRect().top).toBe(before);
  // A late size change below the anchor has no continuing restoration authority.
  scroller.scrollTop += 25; render(); expect(scroller.scrollTop).toBe(565);
});

test("repeated request triggers share a pending load and an empty result permits retry", async () => {
  const scroller = await mount(); request(); request(); expect(calls).toBe(1);
  scroller.scrollTop = 140; finish(0); await wait(); render(); expect(scroller.scrollTop).toBe(140);
  request(); expect(calls).toBe(2);
  tail = { ...tail, lines, linesStart: 0, prependGen: 1 }; render(); finish(3); await wait();
  expect(scroller.scrollTop).toBe(540);
});

test("a previous conversation response cannot reveal more rows in the new project", async () => {
  await mount(); request(); const oldFinish = finish;
  file = { ...file, path: file.path + "-other", project: "other-project" };
  tail = { ...tail, lines: Array.from({ length: 1700 }, (_, i) => message(`other-${i}`, i % 2 ? "assistant" : "user")),
    linesStart: 0, hasMore: false, prependGen: 0 };
  render(); await wait(); render();
  expect(host.querySelectorAll("[data-feed-key]").length).toBe(1500);
  oldFinish(3); await wait(); render();
  expect(host.querySelectorAll("[data-feed-key]").length).toBe(1500);
});

test("an unmounted pending load cannot change the replacement pane", async () => {
  await mount(); request(); const oldFinish = finish;
  flushSync(() => root!.unmount()); root = undefined; host.remove(); restoreGeometry();
  const scroller = await mount(); scroller.scrollTop = 140;
  oldFinish(3); await wait(); render(); expect(scroller.scrollTop).toBe(140);
});

test("a tool group coalescing across the page boundary preserves the current group offset", async () => {
  const scroller = await mount(); request(); scroller.scrollTop = 140;
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute("data-feed-kind") === "cmd-group") {
      return new dom.DOMRect(0, (scroller.dataset.tailLinesStart === "0" ? 800 : 400) - scroller.scrollTop, 390, 100);
    }
    return original.call(this);
  };
  tail = { ...tail, lines: [message("older", "user"), message("commentary"), tool("older-tool"), ...lines.slice(3)],
    linesStart: 0, prependGen: 1 };
  render(); finish(3); await wait();
  expect(host.querySelector('[data-feed-key="group:3:0"]')).toBeNull();
  expect(host.querySelector<HTMLElement>('[data-feed-key="group:2:0"]')!.getBoundingClientRect().top).toBe(260);
});

test("successive pages each preserve movement made after their own request", async () => {
  const scroller = await mount();
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute("data-feed-key") === "group:3:0") {
      const start = Number(scroller.dataset.tailLinesStart);
      return new dom.DOMRect(0, (start === 3 ? 400 : start === 0 ? 800 : 1100) - scroller.scrollTop, 390, 100);
    }
    return original.call(this);
  };
  request(); scroller.scrollTop = 140;
  tail = { ...tail, lines, linesStart: 0, prependGen: 1 }; render(); finish(3); await wait();
  expect(scroller.scrollTop).toBe(540);
  request(); scroller.scrollTop += 20;
  tail = { ...tail, lines: [message("oldest", "user"), message("oldest-answer"), message("oldest-boundary", "user"), ...lines],
    linesStart: -3, prependGen: 2, hasMore: false }; render(); finish(3); await wait();
  expect(scroller.scrollTop).toBe(860);
});

test("a scaled compact canvas converts viewport pixels to scroll coordinates", async () => {
  const scroller = await mount(); request(); scroller.scrollTop = 140;
  Object.defineProperty(scroller, "offsetHeight", { configurable: true, get: () => 500 });
  const original = dom.HTMLElement.prototype.getBoundingClientRect;
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-log-feed-scroller")) return new dom.DOMRect(0, 0, 312, 400);
    const rect = original.call(this);
    return new dom.DOMRect(rect.x * 0.8, rect.y * 0.8, rect.width * 0.8, rect.height * 0.8);
  };
  tail = { ...tail, lines, linesStart: 0, prependGen: 1 }; render(); finish(3); await wait();
  expect(scroller.scrollTop).toBe(540);
});

// Optional private API-record replay: the path and captured records never enter
// source or public CI logs. The same mounted geometry model checks the native
// group identity retained by the diagnostic capture.
for (const movement of [0, 60, -60]) {
test.skipIf(!process.env.LLV_PREPEND_RECORDS)(`sanitized API page preserves current group with movement ${movement}`, async () => {
  const records = (await Bun.file(process.env.LLV_PREPEND_RECORDS!).json() as unknown[]).map((record) => JSON.stringify(record));
  const scroller = await mount(records); request(); scroller.scrollTop = 80 + movement;
  expect(host.querySelector('[data-feed-key="group:3:0"]')).not.toBeNull();
  tail = { ...tail, lines: records, linesStart: 0, prependGen: 1 }; render(); finish(3); await wait();
  expect(scroller.scrollTop).toBe(480 + movement);
  expect(host.querySelector<HTMLElement>('[data-feed-key="group:3:0"]')!.getBoundingClientRect().top).toBe(320 - movement);
});
}

// Opt-in real layout check. A private ephemeral HTTP fixture serves the actual
// LogFeed bundle, with an inert tail dependency and no Viewer API or live state.
test.skipIf(!process.env.LLV_PREPEND_BROWSER)("mobile Chromium measures prepend with native anchoring enabled and disabled", async () => {
  const { chromium } = await import("playwright-core");
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LogFeed} from './src/components/LogFeed';
    import {setLogFeedDependenciesForTests} from './src/components/logFeedDependencies';
    const records = ${JSON.stringify(lines)};
    const message = ${message.toString()};
    let finish;
    let tail = {lines: records.slice(3).concat(Array.from({length:30},(_,i)=>message('later-'+i, i%2?'assistant':'user'))),
      linesStart:3,size:1000,loading:false,error:null,tickTime:null,paused:false,setPaused(){},clear(){},
      hasMore:true,loadingOlder:false,prependGen:0,loadOlder:()=>new Promise(r=>finish=r)};
    setLogFeedDependenciesForTests({useLogTail:()=>tail});
    const root = createRoot(document.getElementById('root'));
    const file = {path:'/fixture/browser',name:'fixture',root:'codex',engine:'codex',fmt:'codex',activity:'idle'};
    const render=()=>flushSync(()=>root.render(<LogFeed file={file} showSvc={false} lineFilter='' onStatus={()=>{}}
      paused={false} follow={false} setFollow={()=>{}}/>));
    render();
    window.prepend=()=>{tail={...tail,lines:records.slice(0,3).concat(tail.lines),linesStart:0,prependGen:1,hasMore:false};render();finish(3);};
    window.ready=true;
  `;
  const baseline = process.env.LLV_PREPEND_BASELINE
    ? await new Response(Bun.spawn(["git", "show", "ddc788e9:src/components/LogFeed.tsx"], { stdout: "pipe" }).stdout).text()
    : null;
  const build = await Bun.build({ entrypoints: ["prepend-browser-fixture"], target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env": "{}" },
    plugins: [{ name: "fixture", setup(builder) {
      if (baseline) builder.onLoad({ filter: /[/\\]LogFeed\.tsx$/ }, () => ({ contents: baseline, loader: "tsx", resolveDir: `${process.cwd()}/src/components` }));
      builder.onResolve({ filter: /^prepend-browser-fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: source, loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0].text();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/bundle.js") return new Response(bundle, { headers: { "Content-Type": "application/javascript" } });
    if (new URL(request.url).pathname.startsWith("/api/")) return new Response("{}", { status: 404 });
    return new Response(`<style>
      body{margin:0} [data-log-feed-scroller]{height:500px;overflow-y:auto;width:390px}
      [data-feed-key]{min-height:100px;box-sizing:border-box} svg{height:16px;width:16px}
      button{min-height:44px} [data-feed-key] pre{white-space:pre-wrap}
    </style><div id="root"></div><script src="/bundle.js"></script>`, { headers: { "Content-Type": "text/html" } });
  } });
  const browser = await chromium.launch({ executablePath: process.env.LLV_PREPEND_BROWSER, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    for (const anchoring of ["auto", "none"]) {
      for (const movement of [0, 60, -60]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        page.on("pageerror", (error) => console.log("fixture error:", error.message));
        await page.goto(`http://127.0.0.1:${server.port}`);
        await page.waitForFunction(() => (window as unknown as {ready:boolean}).ready);
        await page.waitForTimeout(100);
        const before = await page.evaluate(({ anchoring, movement }) => {
          const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
          scroller.style.overflowAnchor = anchoring;
          scroller.scrollTop = 80;
          [...document.querySelectorAll("button")].find(b => /earlier/i.test(b.textContent ?? ""))!.click();
          scroller.scrollTop += movement;
          const row = document.querySelector<HTMLElement>('[data-feed-key="group:3:0"]')!;
          return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        }, { anchoring, movement });
        await page.evaluate(() => (window as unknown as {prepend():void}).prepend());
        await page.waitForTimeout(100);
        const after = await page.evaluate(() => document.querySelector('[data-feed-key="group:3:0"]')!.getBoundingClientRect().top
          - document.querySelector('[data-log-feed-scroller]')!.getBoundingClientRect().top);
        expect(Math.abs(after - before)).toBeLessThan(1);
        console.log(`browser anchor=${anchoring} movement=${movement} offset=${before} -> ${after}`);
        // A delayed image below the visible row must not start a second restore.
        await page.evaluate(async () => {
          const last = [...document.querySelectorAll("[data-feed-key]")].at(-1)!;
          const img = document.createElement("img"); img.width = 200; img.height = 1;
          last.append(img);
          await new Promise(resolve => setTimeout(resolve, 20));
          img.height = 200;
          img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
          await img.decode();
        });
        await page.waitForTimeout(50);
        const afterImage = await page.evaluate(() => document.querySelector('[data-feed-key="group:3:0"]')!.getBoundingClientRect().top
          - document.querySelector('[data-log-feed-scroller]')!.getBoundingClientRect().top);
        expect(Math.abs(afterImage - before)).toBeLessThan(1);
        await page.close();
      }
    }
  } finally { await browser.close(); server.stop(true); }
}, 30000);
