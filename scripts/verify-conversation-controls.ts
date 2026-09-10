/** Browser activation proof for the production controls with inert host endpoints.
 * Run with CONTROL_PROOF_DIR pointing outside the checkout. No provider is started.
 * Feed and composer bodies are omitted from the orchestrator fixture; its real
 * composition, control strip, header and mobile menu are bundled unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const repo = path.resolve(import.meta.dir, "..");
const out = path.resolve(process.env.CONTROL_PROOF_DIR ?? "");
if (!process.env.CONTROL_PROOF_DIR || out === repo || out.startsWith(`${repo}/`)) throw new Error("CONTROL_PROOF_DIR must be outside the checkout");
fs.mkdirSync(out, { recursive: true });
const entry = path.join(out, "controls.tsx");
fs.writeFileSync(entry, `
import React from ${JSON.stringify(path.join(repo, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(path.join(repo, "node_modules/react-dom/client.js"))};
import {AgentControlStrip} from ${JSON.stringify(path.join(repo, "src/components/AgentControlStrip.tsx"))};
import {ProcessStatusControls} from ${JSON.stringify(path.join(repo, "src/components/TaskHeader.tsx"))};
import {OrchestratorConversation} from ${JSON.stringify(path.join(repo, "src/components/orchestrator/OrchestratorConversation.tsx"))};
import {MobileConversationMenu} from ${JSON.stringify(path.join(repo, "src/components/mobile/MobileConversationMenu.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderScenario=(transport,surface,busy)=>{
 window.fixtureRuntime={session:{conversationId:'conversation_selected',hostKind:transport==='claude'?'claude-broker':'codex-app-server',host:transport==='legacy'?'dead':'hosted',turn:busy?'running':'idle',activeTurnId:busy?'turn-one':null,sessionKey:{engine:transport==='claude'?'claude':'codex'},capabilities:{}},receipts:[],attentions:[],legacy:false,structuredControlsEnabled:true,uiState:{}};
 const file={path:'/fixture/selected.jsonl',conversationId:'conversation_selected',root:'codex-sessions',name:'selected.jsonl',project:'fixture',title:'Selected conversation',engine:transport==='claude'?'claude':'codex',kind:'session',fmt:'codex',parent:null,mtime:1,size:1,activity:busy?'live':'idle',proc:'running',pid:123,model:null,ctx:null,pendingQuestion:null,waitingInput:null,lastTurn:busy?{startedAt:1,completedAt:null}:null,...(transport==='legacy'?{controlHost:{conversationId:'conversation_selected',transport:'legacy'}}:{})};
 const key=transport+surface+busy+Math.random(); const noop=()=>{};
 root.render(<main key={key}>{surface==='orchestrator'?<OrchestratorConversation file={file} projectName="Fixture"/>:surface==='mobile'?<MobileConversationMenu file={file} stage={null} crowned={false} hostTaskCount={0} onRename={noop} onOpenHost={noop} onCloseCard={noop} onClose={noop}/>:<><ProcessStatusControls file={file}/><AgentControlStrip file={file}/></>}</main>);
};
`);
const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: out, plugins: [{ name: "inert-control-fixture", setup(builder) {
  builder.onResolve({ filter: /(^@\/hooks\/useRuntime$|\/TmuxComposer(?:\.tsx)?$|\/LogFeed(?:\.tsx)?$)/ }, (args) => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ loader: "js", contents: args.path.includes("useRuntime")
    ? `export const useRuntimeEnabled=()=>true; export const useRuntimeSession=()=>window.fixtureRuntime; export const useRuntimeSessionByArtifact=()=>null; export const refreshRuntime=async()=>true; export const useRuntimeReceiptsForArtifact=()=>[]; export const sendRuntimeMessage=async()=>{throw new Error("fixture prohibits sends")};`
    : args.path.includes("TmuxComposer") ? `export const TmuxComposer=()=>null; export const appendComposerDraft=()=>{};` : `export const LogFeed=()=>null;` }));
  builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(path.join(repo, "src", args.path.slice(2)), repo) }));
  builder.onResolve({ filter: /^react(\/|$)/ }, (args) => ({ path: Bun.resolveSync(args.path, repo) }));
} }] });
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0]!.text();
const posts: Record<string, unknown>[] = [];
const receipts = new Map<string, Record<string, unknown>>();
let terminal = "delivered";
let legacy = false;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/controls.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  if (url.pathname === "/api/conversation-host") {
    const body = await request.json() as Record<string, unknown>; posts.push(body);
    assert.equal(body.conversationId, "conversation_selected");
    assert.equal(body.path, "/fixture/selected.jsonl");
    if (legacy) return Response.json({ ok: true, target: "%selected" });
    receipts.set(String(body.operationId), { operationId: body.operationId, conversationId: body.conversationId, kind: body.action, status: terminal === "failed" ? "failed" : body.action === "interrupt" ? "interrupted" : "delivered", error: terminal === "failed" ? "Synthetic host refused" : undefined });
    return Response.json({ ok: true, receipt: { operationId: body.operationId, status: "queued" } }, { status: 202 });
  }
  if (url.pathname.startsWith("/api/runtime/operations/")) return Response.json({ receipt: receipts.get(url.pathname.split("/").at(-1)!) });
  if (url.pathname.startsWith("/api/")) return Response.json({ error: "No live endpoint in this fixture" }, { status: 404 });
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><div id="root"></div><script type="module" src="/controls.js"></script></html>', { headers: { "content-type": "text/html" } });
} });
const executablePath = process.env.CHROME_BIN ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(fs.existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results: string[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => "renderScenario" in window);
  for (const surface of ["desktop", "orchestrator", "mobile"]) {
    await page.setViewportSize(surface === "mobile" ? { width: 390, height: 844 } : { width: 1000, height: 800 });
    for (const transport of ["codex", "claude", "legacy"]) for (const busy of [true, false]) {
      legacy = transport === "legacy";
      await page.evaluate(({ transport, surface, busy }) => (window as unknown as { renderScenario: (t: string, s: string, b: boolean) => void }).renderScenario(transport, surface, busy), { transport, surface, busy });
      const before = posts.length;
      const interrupt = surface === "mobile" ? page.locator('[data-mobile2-menu-row="stop"]') : page.getByRole("button", { name: /Interrupt/ });
      await interrupt.waitFor({ state: "visible" });
      await interrupt.focus(); await page.keyboard.press("Enter");
      await interrupt.click({ trial: true });
      assert.equal(posts.length, before + 1, `${surface}/${transport} interrupt`);
      assert.equal(posts.at(-1)!.action, "interrupt");
      const kill = surface === "mobile" ? page.locator('[data-mobile2-menu-row="kill"]') : page.getByRole("button", { name: "Stop host", exact: true });
      await kill.waitFor({ state: "visible" });
      await kill.focus(); await page.keyboard.press("Space");
      if (surface !== "mobile") await page.getByRole("button", { name: "Yes, stop", exact: true }).click();
      await page.getByText("Host stopped. History is retained; send a message to resume.", { exact: true }).waitFor();
      assert.equal(posts.length, before + 2, `${surface}/${transport} stop`);
      assert.equal(posts.at(-1)!.action, "kill");
      results.push(`${surface}/${transport}/${busy ? "busy" : "idle"}: interrupt and stop activated`);
    }
  }
  terminal = "failed"; legacy = false;
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.evaluate(() => (window as unknown as { renderScenario: (t: string, s: string, b: boolean) => void }).renderScenario("codex", "desktop", true));
  await page.getByRole("button", { name: "Stop host", exact: true }).click();
  await page.getByRole("button", { name: "Yes, stop", exact: true }).click();
  await page.getByText("Synthetic host refused", { exact: true }).waitFor();
  results.push("failed receipt remains visible");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ results, posts, errors }, null, 2));
  console.log(results.join("\n"));
} finally { await browser.close(); server.stop(true); }
