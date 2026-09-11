/** Chromium acceptance for #1651. Runs the real board with 461 synthetic tasks.
 * Every HTTP request is fulfilled in the browser; no Viewer, provider or active
 * operator view is contacted. Artifacts stay outside the checkout.
 *
 * BOARD_CAPTURE_DIR=<private dir> bun scripts/capture-board-density.ts
 * BOARD_SOURCE_REF=<old sha> repeats the same probes with old board source.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import os from "node:os";

const repo = path.resolve(import.meta.dir, "..");
const parent = path.resolve(process.env.BOARD_CAPTURE_DIR ?? path.join(os.homedir(), "codex-artifacts"));
if (parent === repo || parent.startsWith(repo + path.sep)) throw new Error("Capture artifacts must be outside the checkout");
fs.mkdirSync(parent, { recursive: true });
const out = fs.mkdtempSync(path.join(parent, "llv-issue-1651-"));
const sourceRef = process.env.BOARD_SOURCE_REF;
const originalModules = ["src/components/scheme/SchemeBoard.tsx", "src/components/scheme/taskBands.ts", "src/components/scheme/TaskBandsLayer.tsx", "src/components/scheme/nodes.tsx", "src/components/pipelines/StageStatusRow.tsx", "src/components/scheme/boardPresentation.ts"];
const old = new Map<string, string>();
if (sourceRef) for (const file of originalModules) {
  const result = Bun.spawnSync(["git", "show", `${sourceRef}:${file}`], { cwd: repo });
  if (result.exitCode) throw new Error(`Cannot read old source: ${file}`);
  old.set(path.join(repo, file), result.stdout.toString());
}
const build = await Bun.build({
  // iife: a classic script's top-level `function dispatchEvent` (React's own)
  // would otherwise replace window.dispatchEvent for the whole page.
  entrypoints: [path.join(repo, "scripts/fixtures/board-density.tsx")], outdir: out, target: "browser", format: "iife", minify: false,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: old.size ? [{ name: "old-board-control", setup(builder) {
    builder.onLoad({ filter: /\.[jt]sx?$/ }, args => { const contents = old.get(args.path); return contents === undefined ? undefined : { contents, loader: args.path.endsWith("tsx") ? "tsx" : "ts" }; });
  } }] : [],
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const css = await postcss([tailwind()]).process(fs.readFileSync(path.join(repo, "src/app/globals.css"), "utf8"), { from: path.join(repo, "src/app/globals.css") });
fs.writeFileSync(path.join(out, "style.css"), css.css);
const failures: string[] = [], errors: string[] = [], requests: string[] = [];
const must = (condition: unknown, label: string) => { if (!condition) failures.push(label); };
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const runs: unknown[] = [];

function reading() {
  const viewport = document.querySelector<HTMLElement>('[aria-label^="Agent board"]')!;
  const world = viewport.querySelector<HTMLElement>("[data-atomic-task-layout]")!;
  const match = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([\d.e+-]+)\)/.exec(world.style.transform)!;
  const cam = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
  const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const visible = (element: Element) => element.getBoundingClientRect().width > 0;
  const nodes = [...document.querySelectorAll<HTMLElement>("[data-scheme-node]")].filter(visible).map(element => ({
    key: element.dataset.schemeNode!, rect: rect(element), kind: element.dataset.schemeNodePresentation,
    painted: rect(element.querySelector("[data-pipeline-stage-card], [data-scheme-summary], [data-review-deck-collapsed], [data-native-owner]") ?? element),
  }));
  const bands = [...document.querySelectorAll<HTMLElement>("[data-scheme-band]")].map(element => ({ id: element.dataset.schemeBand!, rect: rect(element), header: rect(element.querySelector("[data-scheme-band-header]")!), title: rect(element.querySelector("[data-scheme-band-title]")!), titleWidth: (element.querySelector("[data-scheme-band-title]") as HTMLElement).clientWidth }));
  const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
  const collisions: string[] = [];
  for (const band of document.querySelectorAll<HTMLElement>("[data-scheme-band]")) {
    const header = band.querySelector<HTMLElement>("[data-scheme-band-header]")!;
    const controls = [...header.querySelectorAll<HTMLElement>("button")];
    for (const [index, a] of controls.entries()) {
      const ar = rect(a), hr = rect(header);
      if (ar.x < hr.x - 1 || ar.y < hr.y - 1 || ar.x + ar.w > hr.x + hr.w + 1 || ar.y + ar.h > hr.y + hr.h + 1) collisions.push(`${band.dataset.schemeBand}: control outside header`);
      for (const b of controls.slice(index + 1)) if (overlap(ar, rect(b))) collisions.push(`${band.dataset.schemeBand}: header controls overlap`);
    }
  }
  const chips = [...document.querySelectorAll("[data-edge-chip], [data-band-dependency], [data-pipeline-stage-label], [data-board-role] > div")].filter(visible);
  for (const chip of chips) for (const node of nodes) if (overlap(rect(chip), node.rect)) collisions.push(`${chip.getAttribute("data-edge-chip") ?? chip.getAttribute("data-band-dependency") ?? "role"}: covers ${node.key}`);
  for (const label of document.querySelectorAll("[data-board-role] > div, [data-pipeline-stage-label]")) {
    const node = label.closest("[data-scheme-node]");
    if (!node || !visible(label)) continue;
    for (const button of node.querySelectorAll("button")) if (visible(button) && overlap(rect(label), rect(button))) collisions.push("role badge overlaps card controls");
  }
  const pathCollisions: string[] = [];
  for (const route of document.querySelectorAll<SVGPathElement>("[data-pipeline-edge] path:first-child")) {
    const matrix = route.getScreenCTM(); if (!matrix) continue;
    const length = route.getTotalLength();
    for (let i = 2; i < 98; i += 2) {
      const p = route.getPointAtLength(length * i / 100).matrixTransform(matrix);
      if (nodes.some(n => p.x > n.rect.x + 2 && p.x < n.rect.x + n.rect.w - 2 && p.y > n.rect.y + 2 && p.y < n.rect.y + n.rect.h - 2)) { pathCollisions.push("dependency crosses a card"); break; }
    }
  }
  return { cam, nodes, bands, collisions, pathCollisions };
}
type Reading = ReturnType<typeof reading>;
const wait = (page: Page) => page.waitForTimeout(220);
async function panTo(page: Page, selector: string, top = 88) {
  for (let i = 0; i < 12; i++) {
    const box = await page.locator(selector).count() ? await page.locator(selector).first().boundingBox() : null;
    if (!box) return false;
    const width = page.viewportSize()!.width;
    const dx = box.width < width - 48 && (box.x < 24 || box.x + box.width > width - 24) ? box.x + box.width / 2 - width / 2 : 0;
    if (Math.abs(box.y - top) < 3 && Math.abs(dx) < 3) return true;
    await page.mouse.move(5, 400);
    await page.mouse.wheel(dx, box.y - top);
    await wait(page);
  }
  return false;
}
async function click(page: Page, selector: string) {
  const locator = page.locator(selector).first();
  if (!await locator.count()) return false;
  const box = await locator.boundingBox();
  if (!box) return false;
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hit = await locator.evaluate((element, p) => element.contains(document.elementFromPoint(p.x, p.y)), p);
  if (!hit) return false;
  await page.mouse.click(p.x, p.y); await wait(page); return true;
}
async function zoom(page: Page, target: number) {
  const { cam } = await page.evaluate(reading);
  await page.mouse.move(300, 250); await page.keyboard.down("Control");
  // The production wheel handler's exponential zoom law. Input still crosses
  // Chromium's real wheel pipeline; no camera state is assigned by the test.
  await page.mouse.wheel(0, -Math.log(target / cam.z) / 0.0022);
  await page.keyboard.up("Control"); await wait(page);
}

async function open(width: number, query = "") {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    (window as unknown as {process: unknown}).process = { env: { NODE_ENV: "production" } };
    Object.defineProperty(window, "EventSource", { value: undefined });
    localStorage.setItem("llv_lang", "en"); localStorage.setItem("llvSound", "0"); localStorage.setItem("llvSchemeMode", "select");
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.stack ?? String(error)));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()); requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="height:100vh;display:flex"></div><script src="/board-density.js"></script></body></html>' });
    if (url.pathname === "/board-density.js" || url.pathname === "/style.css") return route.fulfill({ contentType: url.pathname.endsWith("css") ? "text/css" : "application/javascript", body: fs.readFileSync(path.join(out, url.pathname.slice(1))) });
    if (url.pathname === "/api/logs") {
      const {reqs} = route.request().postDataJSON();
      const data = Array.from({length:60}, (_, i) => JSON.stringify({type:"assistant",uuid:`reply-${i}`,timestamp:"2026-09-01T10:00:00Z",message:{role:"assistant",content:[{type:"text",text:`Recorded conversation message ${i}. ` + "This is a retained transcript paragraph for scrolling evidence. ".repeat(12)}]}})).join("\n")+"\n";
      return route.fulfill({json:{chunks:Object.fromEntries(reqs.map((r: {id:string;offset:number})=>[r.id,{data:r.offset?"":data,start:0,size:data.length,offset:data.length}]))}});
    }
    return route.fulfill({json:{ok:true,files:[],tasks:[],flows:[],pipelines:[],messages:[],entries:[],accounts:[],roles:[],models:[],backends:[],voices:[],options:[]}});
  });
  page.setDefaultTimeout(5000);
  await page.goto(`http://density.test/${query}`); await page.waitForSelector("[data-scheme-band]", {timeout:15000}); await wait(page);
  return { context, page };
}

/* Task 0's review loop: a deck the operator expanded must not be hidden by the
   completed task's automatic history fold, and a round recorded after
   completion is current work, never history. */
const historyBand = '[data-scheme-band="task:task-0"]', historyToggle = '[data-scheme-band-history="task:task-0"]', deck = '[data-scheme-node="deck::review-flow"]';
// RoundDeck's open form is its round group; the collapsed form is one chip button.
const openDeck = `${deck} [role="group"]`;
const present = async (page: Page, selector: string) => await page.locator(selector).count() > 0 && ((await page.locator(selector).first().boundingBox())?.width ?? 0) > 0;
const disclosure = async (page: Page) => await page.locator(historyToggle).count() ? await page.locator(historyToggle).getAttribute("aria-expanded") : "none";
/* A click selects the deck, and a selected target always reveals its band;
   clear it so the fold rule itself decides, as it does once the task is done. */
async function deselect(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape"); await wait(page);
}
async function reload(page: Page) { await page.reload(); await page.waitForSelector("[data-scheme-band]", {timeout:15000}); await wait(page); await zoom(page, 1); await panTo(page, historyBand); }
async function historyChecks(width: number) {
  const tag = `${width}-history`;
  let { context, page } = await open(width, "?case=history");
  await zoom(page, 1); await panTo(page, historyBand);
  must(await click(page, `${deck} [data-review-deck-collapsed]`), `${tag}: settled deck expands before completion`);
  await deselect(page);
  await page.evaluate(() => window.densityStep("complete")); await wait(page); await panTo(page, historyBand);
  for (const phase of ["completion", "reload"]) {
    if (phase === "reload") await reload(page);
    must(await disclosure(page) === "true", `${tag}: ${phase} keeps the expanded deck's history open (${await disclosure(page)})`);
    must(await present(page, openDeck), `${tag}: ${phase} keeps the expanded deck`);
  }
  await page.screenshot({ path: path.join(out, `${tag}-expanded-deck.png`) });
  /* The deck's collapse control sits in its pane header, which the phone
     layout does not draw (BranchPane); there the chip expands it only. */
  if (width >= 830) {
    // Collapsing the deck withdraws the only reason to open: the fold resumes.
    await panTo(page, deck, 200);
    must(await click(page, `${deck} [data-review-deck-collapse]`), `${tag}: deck collapse reachable`);
    await deselect(page); await panTo(page, historyBand);
    must(await disclosure(page) === "false" && !await present(page, deck), `${tag}: collapsing the deck returns to the automatic fold`);
    must(await click(page, historyToggle), `${tag}: Show history reachable`);
    must(await disclosure(page) === "true" && await present(page, `${deck} [data-review-deck-collapsed]`), `${tag}: Show history reveals the collapsed deck`);
    must(await click(page, `${deck} [data-review-deck-collapsed]`), `${tag}: deck expands inside shown history`);
    await deselect(page); await panTo(page, historyBand);
  }
  // The parent control stays explicit in both directions and survives reload.
  must(await click(page, historyToggle), `${tag}: Collapse history reachable`);
  must(await disclosure(page) === "false" && !await present(page, deck), `${tag}: explicit collapse wins over the deck choice`);
  await reload(page);
  must(await disclosure(page) === "false" && !await present(page, deck), `${tag}: explicit collapse survives reload`);
  must(await click(page, historyToggle), `${tag}: Show history after reload`);
  must(await disclosure(page) === "true" && await present(page, openDeck), `${tag}: explicit show restores the expanded deck`);
  await context.close();

  ({ context, page } = await open(width, "?case=history&steps=complete"));
  await zoom(page, 1); await panTo(page, historyBand);
  must(await disclosure(page) === "false" && !await present(page, deck), `${tag}: an old settled loop folds with its completed task`);
  await page.evaluate(() => window.densityStep("round")); await wait(page); await panTo(page, historyBand);
  for (const phase of ["new round", "reload"]) {
    if (phase === "reload") await reload(page);
    const text = await page.locator(historyBand).innerText();
    must(await disclosure(page) === "none" && !text.includes("Historical runs"), `${tag}: ${phase} after completion is not labeled history`);
    must(await present(page, openDeck), `${tag}: ${phase} keeps the decision deck open`);
  }
  for (const z of [0.9, 1.6, 1]) {
    await zoom(page, z); await panTo(page, historyBand);
    const result = await page.evaluate(reading);
    must(result.nodes.some(node => node.key === "deck::review-flow"), `${tag}-${Math.round(z * 100)}: decision deck placed`);
    must(result.collisions.length === 0, `${tag}-${Math.round(z * 100)}: ${result.collisions.slice(0, 8).join(", ")}`);
  }
  await page.screenshot({ path: path.join(out, `${tag}-new-round.png`) });
  runs.push({ tag, ...(await page.evaluate(reading)) });
  await context.close();
}

/* Completed task 1 owns pipeline-0 and folds as history. Each fixture step is
   evidence the fold must not hide: it stays open without the history label,
   live and after reload. */
const oldBand = '[data-scheme-band="task:task-1"]', oldToggle = '[data-scheme-band-history="task:task-1"]';
const oldMembers = ['[data-scheme-node="/fixture/worker-1.jsonl"]', '[data-scheme-node="slot::pipeline-0::build"]'];
async function evidenceChecks(width: number) {
  for (const step of ["parked", "undated", "pipelineRound", "unread"]) {
    const tag = `${width}-evidence-${step}`;
    const { context, page } = await open(width, "?case=history");
    await zoom(page, 1); await panTo(page, oldBand);
    must(await page.locator(oldToggle).getAttribute("aria-expanded") === "false", `${tag}: the old task folds before the step`);
    await page.evaluate(step => window.densityStep(step), step); await wait(page); await panTo(page, oldBand);
    for (const phase of ["live", "reload"]) {
      if (phase === "reload") { await page.reload(); await page.waitForSelector("[data-scheme-band]", {timeout:15000}); await wait(page); await zoom(page, 1); await panTo(page, oldBand); }
      const text = await page.locator(oldBand).innerText();
      must(!await page.locator(oldToggle).count() && !text.includes("Historical runs"), `${tag}: ${phase} is not labeled history`);
      for (const member of oldMembers) must(await present(page, member), `${tag}: ${phase} keeps ${member}`);
    }
    if (step === "pipelineRound") await page.screenshot({ path: path.join(out, `${tag}.png`) });
    await context.close();
  }
  /* Folding one task's history leaves another task's open reader alone. */
  const tag = `${width}-evidence-focus`;
  const { context, page } = await open(width, "?case=history");
  await zoom(page, 1); await panTo(page, oldBand);
  must(await click(page, oldToggle), `${tag}: Show history reachable`);
  await page.evaluate(() => window.openConversation(3)); await page.waitForTimeout(1600);
  const reader = '[data-scheme-node="/fixture/worker-3.jsonl"]';
  must(await page.locator(reader).getAttribute("data-scheme-node-presentation") === "native", `${tag}: worker 3 reader opens`);
  await panTo(page, oldToggle, 160);
  must(await click(page, oldToggle), `${tag}: Collapse history reachable`);
  must(await page.locator(oldToggle).getAttribute("aria-expanded") === "false", `${tag}: the old task folds`);
  must(await page.locator(reader).getAttribute("data-scheme-node-presentation") === "native", `${tag}: worker 3 reader stays open`);
  await context.close();
}

async function mirrorChecks(width: number) {
  for (const evidence of ["incomplete", "unknown", "running"]) {
    const {context, page} = await open(width, `?case=history&steps=complete&mirror=${evidence}`);
    const band = '[data-scheme-band="task:task-2"]';
    const toggle = '[data-scheme-band-history="task:task-2"]';
    for (const phase of ["initial", "reload"]) {
      if (phase === "reload") {
        await page.reload();
        await page.waitForSelector("[data-scheme-band]", {timeout: 15000});
        await wait(page);
      }
      await zoom(page, 1);
      await panTo(page, band);
      const tag = `${width}: ${evidence} mirror ${phase}`;
      must(!await page.locator(toggle).count() || await page.locator(toggle).getAttribute("aria-expanded") !== "false", `${tag} is not folded`);
      must(await present(page, '[data-scheme-mirror-band="task:task-2"]'), `${tag} stays visible`);
      must(!await page.locator(band).innerText().then(text => text.includes("Historical runs")), `${tag} has no historical label`);
    }
    await page.screenshot({path: path.join(out, `${width}-mirror-${evidence}.png`)});
    await context.close();
  }
}

try {
  for (const width of [1440, 830, 390]) {
    await mirrorChecks(width);
    if (process.env.BOARD_CAPTURE_CASE === "mirrors") continue;
    await historyChecks(width);
    await evidenceChecks(width);
    const { context, page } = await open(width);
    for (const z of [0.9, 1, 1.6]) {
      await zoom(page,z);
      await panTo(page,'[data-scheme-band="task:task-2"]');
      const result = await page.evaluate(reading), tag = `${width}-${Math.round(z*100)}`;
      must(Math.abs(result.cam.z-z)<0.005, `${tag}: exact requested zoom (${result.cam.z})`);
      must(result.bands.length===461, `${tag}: preserve every task`);
      must(result.collisions.length===0, `${tag}: ${result.collisions.slice(0,8).join(", ")}`);
      must(result.pathCollisions.length===0, `${tag}: ${result.pathCollisions.join(", ")}`);
      for(const node of result.nodes.filter(n=>n.key.startsWith("slot::"))) {
        must(node.rect.h / result.cam.z <= 105, `${tag}: inactive stage reserves ${node.rect.h/result.cam.z}px`);
        must(Math.abs(node.rect.h-node.painted.h)<1, `${tag}: stage painted/reserved height differs`);
      }
      for(const node of result.nodes.filter(n=>n.kind==='summary')) must(node.rect.h/result.cam.z<=89, `${tag}: collapsed conversation reserves ${node.rect.h/result.cam.z}px`);
      const empty=result.bands.find(b=>b.id==='task:task-80')!;
      must(empty.rect.h===empty.header.h,`${tag}: empty task reserves a blank body`);
      must(empty.titleWidth>=Math.min(520,width-80),`${tag}: empty task title loses its dedicated row (${empty.titleWidth})`);
      await page.screenshot({path:path.join(out,`${tag}.png`)});
      runs.push({tag,...result});
      const stage = '[data-scheme-node="slot::pipeline-1::build"]';
      await panTo(page, stage);
      const toggle = `${stage} [data-stage-row-toggle]`;
      const folded = await page.locator(stage).boundingBox();
      if (await click(page, toggle)) {
        const opened = await page.locator(stage).boundingBox();
        must(opened && Math.abs(opened.height / opened.width - 724 / 600) < 0.005, `${tag}: expanded stage reserves exact aspect ratio`);
        must(await click(page, toggle), `${tag}: pointer collapse remains reachable`);
        const foldedAgain = await page.locator(stage).boundingBox();
        must(folded && foldedAgain && Math.abs(folded.height-foldedAgain.height)<1, `${tag}: disclosure returns to compact bounds`);
      } else must(false, `${tag}: stage Details hit target`);
    }
    await zoom(page,1);
    await panTo(page,'[data-scheme-node="slot::pipeline-1::build"]');
    const slot='[data-scheme-node="slot::pipeline-1::build"]';
    const toggle=`${slot} [data-stage-row-toggle]`;
    const compact=await page.locator(slot).boundingBox();
    if (await click(page,toggle)) {
      const expanded=await page.locator(slot).boundingBox();
      must(expanded && compact && expanded.height>compact.height && Math.abs(expanded.height / expanded.width - 724 / 600) < 0.005,`${width}: Details expands reserved surface`);
      must(await page.locator(`${slot} [data-stage-row-card]`).count()===1,`${width}: Details opens actual prompt`);
      const expandedRead=await page.evaluate(reading);
      const frame=expandedRead.bands.find(b=>b.id==='task:task-2')!.rect;
      must(expanded && expanded.y+expanded.height<=frame.y+frame.h+1,`${width}: expanded details fit reserved band`);
      await page.screenshot({path:path.join(out,`${width}-details.png`)});
      // Escape and pointer collapse both cross real input handlers.
      await page.keyboard.press("Escape");await wait(page);
      must(Math.abs((await page.locator(slot).boundingBox())!.height-compact!.height)<1,`${width}: Escape collapses reserved surface`);
      await click(page,toggle);await click(page,toggle);
      must(Math.abs((await page.locator(slot).boundingBox())!.height-compact!.height)<1,`${width}: toggle collapses both ways`);
    } else must(false,`${width}: Details must be clickable`);
    await panTo(page,'[data-scheme-band="task:task-1"]');
    const history='[data-scheme-band-history="task:task-1"]';
    if(await click(page,history)) {
      must(await page.locator(history).getAttribute('aria-expanded')==='true',`${width}: Show history reveals members`);
      await click(page,history);
      must(await page.locator(history).getAttribute('aria-expanded')==='false',`${width}: history collapses`);
    } else must(false,`${width}: history toggle reachable`);
    const continuation = '[data-scheme-continuation-target="/fixture/worker-1.jsonl"]';
    await panTo(page, continuation, 180);
    if (await click(page, continuation)) {
      await page.waitForTimeout(1000);
      const opened = await page.locator('[data-scheme-node="/fixture/worker-1.jsonl"]').boundingBox();
      must(opened && opened.y >= 45 && opened.y + opened.height <= 1001, `${width}: continuation reveals and frames folded history target`);
    } else must(false, `${width}: folded history retains its incoming navigation link`);
    // The same focus prop used by a direct conversation opener. The actual
    // target must become the reader and be fully framed after layout settles.
    await page.evaluate(()=>window.openHistoryTarget());await page.waitForTimeout(1600);
    const target='[data-scheme-node="/fixture/worker-1.jsonl"]';
    const targetBox=await page.locator(target).boundingBox();
    must(targetBox && targetBox.y>=45 && targetBox.y+targetBox.height<=1000+1 && targetBox.x>=-1 && targetBox.x+targetBox.width<=width+1,`${width}: direct history target fully framed`);
    const reader=page.locator(`${target} [data-log-feed-scroller]`).first();
    if(await reader.count()) {
      const box=await reader.boundingBox(); const before=await reader.evaluate(e=>e.scrollTop), cameraBefore=(await page.evaluate(reading)).cam;
      if(box){await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-250);await wait(page);}
      const after=await reader.evaluate(e=>e.scrollTop), cameraAfter=(await page.evaluate(reading)).cam;
      must(after<before,`${width}: actual reader scrolls`);must(Math.abs(cameraAfter.y-cameraBefore.y)<1,`${width}: reader wheel leaves camera stable`);
      runs.push({tag:`${width}-reader`,before,after,cameraBefore,cameraAfter,targetBox});
    } else must(false,`${width}: history navigation opens actual reader`);
    await page.screenshot({path:path.join(out,`${width}-history-target.png`)});
    await panTo(page, '[data-scheme-band="task:task-0"]');
    if (await click(page, '[data-scheme-summary="/fixture/worker-0.jsonl"]')) {
      await page.waitForTimeout(1000);
      const activeRead = await page.evaluate(reading);
      must(activeRead.collisions.length === 0, `${width}: active reader role/control clearance: ${activeRead.collisions.join(", ")}`);
      await page.screenshot({path:path.join(out,`${width}-active-reader.png`)});
      runs.push({tag:`${width}-active-reader`,...activeRead});
    } else must(false, `${width}: active work reader opens`);
    // Board wheel over a collapsed card and over a header button.
    await panTo(page,'[data-scheme-band="task:task-3"]');
    for(const selector of ['[data-scheme-summary="/fixture/worker-3.jsonl"]','[data-scheme-band="task:task-3"] [data-scheme-band-details]']) {
      await panTo(page,selector,160);const box=await page.locator(selector).boundingBox();
      const before=(await page.evaluate(reading)).cam;
      if(box){await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,170);await wait(page);}
      const after=(await page.evaluate(reading)).cam;
      must(after.y<before.y-100,`${width}: ordinary wheel pans over ${selector}`);
    }
    await panTo(page,'[data-scheme-band="task:task-80"]');
    await page.screenshot({path:path.join(out,`${width}-empty-tasks.png`)});
    const emptyReading = await page.evaluate(reading);
    runs.push({tag:`${width}-empty`,...emptyReading});
    await page.mouse.click(width-5,400);await page.keyboard.press('1');await wait(page);
    must(Math.abs((await page.evaluate(reading)).cam.z-1)<0.001,`${width}: keyboard 100%`);
    await page.keyboard.press('0');await wait(page);
    must(Math.abs((await page.evaluate(reading)).cam.z-0.58)<0.001,`${width}: fit current`);
    await page.keyboard.press('Shift+0');await wait(page);
    must((await page.evaluate(reading)).cam.z<=0.22,`${width}: fit all enters overview`);
    await page.keyboard.press('1');await wait(page);
    const priorZoom=(await page.evaluate(reading)).cam;
    await click(page,'button[title="Zoom in (+)"]');
    must((await page.evaluate(reading)).cam.z>priorZoom.z,`${width}: toolbar zoom in`);
    await page.keyboard.press('0');await wait(page);
    const restored=(await page.evaluate(reading)).cam;await page.reload();await page.waitForTimeout(1000);
    const afterReload=(await page.evaluate(reading)).cam;
    must(Math.abs(afterReload.z-restored.z)<0.001,`${width}: restore zoom`);
    await context.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(out,"measurements.json"),JSON.stringify({sourceRef:sourceRef??"working-tree",runs,errors,requests:[...new Set(requests)],failures},null,2));
}
must(errors.length===0,`browser errors: ${errors.slice(0,3).join("; ")}`);
console.log(JSON.stringify({out,failures,errors},null,2));
if(failures.length) process.exitCode=1;
