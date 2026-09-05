import { test } from "bun:test";
import { chromium } from "playwright-core";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { resolve } from "node:path";

/* Opt-in real-layout gate. All data is synthetic; only the ephemeral fixture
   server is contacted. CHROME_BIN can select an installed browser. Generated
   JS, CSS, geometry and screenshots remain in the persistent evidence folder. */
const browserTest = process.env.LLV_CATALOG_BROWSER_TEST === "1" ? test : test.skip;
const FIXTURE = `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectDashboard } from "../../src/components/ProjectDashboard";
import { getMobileNav } from "../../src/components/mobile/mobileNav";
import type { FileEntry } from "../../src/lib/types";
const rows: FileEntry[] = Array.from({ length: 45 }, (_, i) => ({
  path: \`/repo/history-\${i}.jsonl\`, root: "claude-projects", name: \`history-\${i}.jsonl\`, project: "atlas",
  title: i === 22 ? "A very long conversation title that stays inside the phone while keeping the catalog row readable" : \`Catalog conversation \${i + 1}\`,
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: Date.now() / 1000 - i,
  size: 2000, activity: i === 0 ? "live" : "idle", proc: i === 0 ? "running" : null, pid: i === 0 ? 42 : null, model: "opus", conversationId: \`conversation_\${i}\`,
  cwd: "/repo", projectRoot: "/repo", pendingQuestion: null, waitingInput: null,
} as FileEntry));
let revision = 1;
const prefs = { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false, seenAt: {} };
const requests: string[] = [];
Object.assign(window, { catalogRequests: requests });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  let body: unknown = {};
  if (url.pathname === "/api/conversations") {
    requests.push(url.toString());
    const cursor = url.searchParams.get("cursor"); const offset = cursor ? Number(cursor) : 0;
    body = { items: rows.slice(offset, offset + 20), total: 4232, nextCursor: offset + 20 < rows.length ? String(offset + 20) : null };
  } else if (url.pathname.startsWith("/api/board")) {
    if (init?.method === "PATCH") Object.assign(prefs, JSON.parse(String(init.body)).patch ?? {});
    body = { board: { schemaVersion: 1, revision: revision++, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [], prefs } };
  } else if (url.pathname === "/api/orchestrator/seat") {
    body = { exists: true, pending: null, seat: { project: "atlas", seatEpoch: 1, conversationId: rows[0]!.conversationId,
      path: null, mandate: "Coordinate", state: "active", designatedAt: "2026-01-01T00:00:00.000Z",
      intent: { clientRequestId: "synthetic-seat-1", mode: "existing", launchId: null, error: null } } };
  } else if (url.pathname === "/api/log") body = { entries: [], hasMore: false };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
function App() {
  const [files, setFiles] = useState(rows.slice(0, 3));
  const [focus, setFocus] = useState<{ path: string; nonce: number; catalog: boolean } | null>(null);
  Object.assign(window, { poll: () => setFiles((f) => f.map((row) => ({ ...row, mtime: row.mtime + 100 }))) });
  return <ProjectDashboard files={files} project="atlas" projectName="Atlas" projectCwd="/repo"
    flows={[]} pipelines={[]} workflows={[]} tasks={[]} loaded openNonce={0} archived={false}
    catalogKnown catalogConversationCount={3325} onArchive={() => { throw Error("archive forbidden"); }} onUnarchive={() => {}}
    focusRequest={focus} onOpenCatalogFile={(file) => {
      getMobileNav().home(); setFiles((current) => current.some((x) => x.path === file.path) ? current : [...current, file]);
      setFocus({ path: file.path, nonce: Date.now(), catalog: true });
    }} />;
}
createRoot(document.getElementById("root")!).render(<App />);
`;

browserTest("real Home at 390 and 430: 20+20, poll, beyond-cap open/back, collapse and geometry", async () => {
const out = resolve(process.env.LLV_CATALOG_EVIDENCE_DIR ?? '.artifacts/mobile-inline-catalog');
await Bun.write(out + '/browser.tsx', FIXTURE);
const build = await Bun.build({ entrypoints: [out + '/browser.tsx'], target: 'browser', outdir: out + '/bundle', define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' } });
if (!build.success) throw new Error(build.logs.join('\n'));
const css = await postcss([tailwind()]).process(await Bun.file('src/app/globals.css').text(), { from: resolve('src/app/globals.css') });
await Bun.write(out + '/style.css', css.css);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/browser.js') return new Response(Bun.file(out + '/bundle/browser.js'));
  if (path === '/style.css') return new Response(Bun.file(out + '/style.css'));
  if (path.startsWith('/api/')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
  return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script src="/browser.js"></script>', { headers: { 'content-type': 'text/html' } });
} });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
const evidence = [];
try {
 for (const [width, height] of [[390,844], [430,932]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => console.error('BROWSER', e.message));
  await page.goto(`http://127.0.0.1:${server.port}/#p=atlas`);
  await page.waitForTimeout(700);
  await page.screenshot({path: `${out}/${width}-home.png`});
  await page.locator('[data-mobile2-row="catalog"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({path: `${out}/${width}-initial.png`});
  await page.waitForFunction(() => document.querySelectorAll('[data-catalog-path]').length === 20);
  const initial = await page.evaluate(() => (window as any).catalogRequests.length);
  const beforeAppend = await page.evaluate(() => {
    const board = document.querySelector<HTMLElement>('[data-mobile2-board]')!;
    const row = document.querySelector<HTMLElement>('[data-catalog-path="/repo/history-19.jsonl"]')!;
    board.scrollTop += row.getBoundingClientRect().top - board.getBoundingClientRect().top - 250;
    return row.getBoundingClientRect().top;
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-catalog-path]').length === 40);
  const afterAppend = (await page.locator('[data-catalog-path="/repo/history-19.jsonl"]').boundingBox())!.y;
  await page.locator('[data-catalog-path="/repo/history-22.jsonl"]').scrollIntoViewIfNeeded();
  const target = page.locator('[data-catalog-path="/repo/history-22.jsonl"]');
  const before = (await target.boundingBox())!.y;
  await page.evaluate(() => (window as any).poll()); await page.waitForTimeout(100);
  const afterPoll = (await target.boundingBox())!.y;
  await page.screenshot({ path: `${out}/${width}-expanded.png` });
  await target.click();
  await page.locator('[data-testid="mobile-chat-shell"]').waitFor();
  await page.goBack();
  await target.waitFor();
  const afterBack = (await target.boundingBox())!.y;
  await page.evaluate(() => (document.querySelector('[data-mobile2-row="catalog"]') as HTMLButtonElement).click());
  await page.waitForFunction(() => !document.querySelector('[data-catalog-path]'));
  await page.evaluate(() => (document.querySelector('[data-mobile2-row="catalog"]') as HTMLButtonElement).click());
  await target.waitFor();
  const afterReopen = (await target.boundingBox())!.y;
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    boardOverflow: (() => { const b = document.querySelector('[data-mobile2-board]')!; return b.scrollWidth > b.clientWidth; })(),
    rows: document.querySelectorAll('[data-catalog-path]').length,
    unique: new Set([...document.querySelectorAll<HTMLElement>('[data-catalog-path]')].map(x => x.dataset.catalogPath)).size,
    controls: [...document.querySelectorAll<HTMLElement>('[data-catalog-path], [data-mobile2-board-dock]')].map(x => x.getBoundingClientRect().height),
    requests: (window as any).catalogRequests,
  }));
  evidence.push({width,height, initial, beforeAppend,afterAppend, before,afterPoll,afterBack,afterReopen,...geometry});
  await page.screenshot({path:`${out}/${width}-returned.png`});
  if (initial !== 1 || Math.abs(beforeAppend-afterAppend)>2 || Math.abs(before-afterPoll)>2 || Math.abs(before-afterBack)>2 || Math.abs(before-afterReopen)>2 || geometry.overflow || geometry.boardOverflow || geometry.rows !== 40 || geometry.unique !== 40 || geometry.controls.some(h=>h<44)) throw Error(JSON.stringify(evidence));
  await page.close();
 }
 await Bun.write(out+'/geometry.json', JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence,null,2));
} finally { await browser.close(); server.stop(true); }

}, 60000);
