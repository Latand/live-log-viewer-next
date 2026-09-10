/** Production projection -> rendered controls -> action routing with synthetic
 * host effects. Use isolated HOME/state/providers and CONTROL_PROOF_DIR outside
 * the checkout. Feed/composer bodies are omitted; no live endpoints are used. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { AgentRegistry } from "@/lib/agent/registry";
import { childControlFixture } from "@/lib/runtime/childControl.fixture";
import { projectStructuredFileLiveness } from "@/lib/runtime/livenessProjection";
import { applyConversationAction } from "@/lib/conversation/actions";
import { interruptConversation } from "@/lib/delivery";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import { BRANCH_SHARED_HOST_ERROR } from "@/lib/conversation/branchControl";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";

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
window.renderScenario=(file,surface,rootView)=>{
 window.fixtureRuntime=null;
 window.fixtureRootRuntime=rootView;
 const key=surface+Math.random(); const noop=()=>{};
 root.render(<main key={key} data-scenario={file.path+surface}>{surface==='orchestrator'?<OrchestratorConversation file={file} projectName="Fixture"/>:surface==='mobile'?<MobileConversationMenu file={file} stage={null} crowned={false} hostTaskCount={0} onRename={noop} onOpenHost={noop} onCloseCard={noop} onClose={noop}/>:<><ProcessStatusControls file={file}/><AgentControlStrip file={file}/></>}</main>);
};
`);
const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: out, plugins: [{ name: "inert-control-fixture", setup(builder) {
  builder.onResolve({ filter: /(^@\/hooks\/useRuntime$|\/TmuxComposer(?:\.tsx)?$|\/LogFeed(?:\.tsx)?$)/ }, (args) => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ loader: "js", contents: args.path.includes("useRuntime")
    ? `export const useRuntimeEnabled=()=>true; export const useRuntimeSession=()=>window.fixtureRuntime; export const useRuntimeSessionByArtifact=()=>window.fixtureRootRuntime; export const refreshRuntime=async()=>true; export const useRuntimeReceiptsForArtifact=()=>[]; export const sendRuntimeMessage=async()=>{throw new Error("fixture prohibits sends")};`
    : args.path.includes("TmuxComposer") ? `export const TmuxComposer=()=>null; export const appendComposerDraft=()=>{};` : `export const LogFeed=()=>null;` }));
  builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(path.join(repo, "src", args.path.slice(2)), repo) }));
  builder.onResolve({ filter: /^react(\/|$)/ }, (args) => ({ path: Bun.resolveSync(args.path, repo) }));
} }] });
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0]!.text();

const fixture = childControlFixture();
const { registry, root: rootFile, child, stale, observed } = fixture;
let activeRegistry = registry;
let selectedChild = child;
let activeObserved = observed;
const advancedSnapshot = registry.snapshot();
const advancedRoot = advancedSnapshot.conversations[rootFile.conversationId!]!;
const previous = advancedRoot.generations.at(-1)!;
const current = { ...previous, id: crypto.randomUUID(), path: path.join(path.dirname(rootFile.path), "current-root.jsonl") };
advancedRoot.generations.push(current);
const previousEntry = advancedSnapshot.entries[`claude:${previous.id}`]!;
advancedSnapshot.entries[`claude:${current.id}`] = { ...previousEntry, key: { engine: "claude", sessionId: current.id }, artifactPath: current.path };
previousEntry.host = null;
previousEntry.status = "dead";
advancedSnapshot.conversationAliases.conversation_child_alias = fixture.childConversation.id;
advancedSnapshot.conversationAliases.conversation_root_alias = advancedRoot.id;
advancedSnapshot.conversations[fixture.childConversation.id]!.generations.at(-1)!.launchProfile.parentConversationId = "conversation_root_alias";
const advancedPath = path.join(path.dirname(rootFile.path), "advanced-registry.json");
fs.writeFileSync(advancedPath, JSON.stringify(advancedSnapshot));
const advancedRegistry = new AgentRegistry(advancedPath, undefined, undefined, { sqliteMode: "off" });
const aliasChild = { ...child, conversationId: "conversation_child_alias" };
const advancedObserved = { ...observed, claimedPaths: [child.path, current.path], primaryPath: child.path };
const posts: Record<string, unknown>[] = [];
const effects: string[] = [];
const unexpected = async (): Promise<never> => { throw new Error("unexpected host operation"); };
const dependencies = {
  registry: () => activeRegistry,
  structuredEnabled: () => true,
  dispatchStructuredControl: (request: Parameters<typeof dispatchStructuredControl>[0]) =>
    dispatchStructuredControl(request, { registry: activeRegistry, enabled: () => true, client: null }),
  interruptConversation: (pathname: string) => interruptConversation(pathname, {
    registry: activeRegistry, pathAllowed: () => true, livePaneHost: async () => activeObserved,
    interruptHost: async (host) => { assert.equal(host.agent.pid, observed.agentPid); effects.push(host.paneId); return true; },
  }),
  killConversation: unexpected, resumeConversation: unexpected,
  compactConversation: unexpected, answerDialogKey: unexpected,
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/controls.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  if (url.pathname === "/api/conversation-host") {
    const body = await request.json() as Record<string, unknown>;
    posts.push(body);
    assert.equal(body.path, selectedChild.path);
    assert.equal(body.conversationId, selectedChild.conversationId);
    const result = await applyConversationAction({
      action: String(body.action), conversationId: String(body.conversationId),
      transcriptPath: String(body.path), operationId: String(body.operationId),
    }, dependencies);
    return Response.json(result.body, { status: result.status });
  }
  if (url.pathname.startsWith("/api/")) return Response.json({ error: "fixture endpoint unavailable" }, { status: 404 });
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><div id="root"></div><script type="module" src="/controls.js"></script></html>', { headers: { "content-type": "text/html" } });
} });
const executablePath = process.env.CHROME_BIN ?? ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(fs.existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results: string[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => "renderScenario" in window);
  async function render(file: FileEntry, surface: string, rootView: RuntimeSessionView | null = stale) {
    await page.evaluate(({file, surface, rootView}) => (window as unknown as {
      renderScenario: (f: FileEntry, s: string, r: RuntimeSessionView | null) => void;
    }).renderScenario(file, surface, rootView), {file, surface, rootView});
    await page.waitForFunction((scenario) => document.querySelector("main")?.getAttribute("data-scenario") === scenario, file.path + surface);
    // Flush React's commit before counting controls that must be absent.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  for (const surface of ["desktop", "orchestrator", "mobile"]) {
    await page.setViewportSize(surface === "mobile" ? {width: 390, height: 844} : {width: 1000, height: 800});
    const interrupt = surface === "mobile" ? page.locator('[data-mobile2-menu-row="stop"]') : page.getByRole("button", {name: /Interrupt/});
    for (const includeRoot of [true, false]) {
      await projectStructuredFileLiveness(includeRoot ? [rootFile, child] : [child], registry);
      assert.equal(child.controlHost, undefined);
      assert.equal(child.proc, null);
      assert.equal(child.pid, null);
      await render(child, surface);
      assert.equal(await interrupt.count(), 1, `${surface}: current root interrupt must render`);
      const before = effects.length;
      const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/conversation-host")), interrupt.click()]);
      assert.equal(response.status(), 200, JSON.stringify(await response.json()));
      assert.equal(effects.length, before + 1);
      assert.equal(posts.at(-1)!.action, "interrupt");
      results.push(`${surface}/root-selected-${includeRoot}: pointer interrupt reaches unique owner once`);
    }
    activeRegistry = advancedRegistry;
    activeObserved = advancedObserved;
    selectedChild = aliasChild;
    await projectStructuredFileLiveness([aliasChild], advancedRegistry);
    assert.equal(aliasChild.rootControlHost?.conversationId, advancedRoot.id);
    await render(aliasChild, surface);
    const beforeAdvanced = effects.length;
    const [advancedResponse] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/conversation-host")), interrupt.click()]);
    assert.equal(advancedResponse.status(), 200, JSON.stringify(await advancedResponse.json()));
    assert.equal(effects.length, beforeAdvanced + 1);
    assert.equal(posts.at(-1)!.conversationId, "conversation_child_alias");
    results.push(`${surface}/alias-current-generation: pointer interrupt preserves selected alias and resolves current owner`);
    const beforeStop = effects.length;
    const kill = surface === "mobile" ? page.locator('[data-mobile2-menu-row="kill"]') : page.getByRole("button", {name: "Stop host", exact: true});
    await kill.click();
    if (surface !== "mobile") await page.getByRole("button", {name: "Yes, stop", exact: true}).click();
    await page.getByText(BRANCH_SHARED_HOST_ERROR, {exact: true}).waitFor();
    assert.equal(posts.at(-1)!.action, "kill");
    assert.equal(effects.length, beforeStop);
    results.push(`${surface}: selected child stop visibly refused without host effects`);
    activeRegistry = registry;
    activeObserved = observed;
    selectedChild = child;
    for (const negative of ["missing", "dead", "ambiguous", "identity", "superseded"]) {
      const snapshot = registry.snapshot();
      const parent = snapshot.conversations[rootFile.conversationId!]!;
      const owner = snapshot.entries[`claude:${parent.generations.at(-1)!.id}`]!;
      const selected = { ...child };
      if (negative === "missing") delete snapshot.conversations[parent.id];
      if (negative === "dead") owner.status = "dead";
      if (negative === "ambiguous") snapshot.entries["claude:conflict"] = { ...owner, artifactPath: "/fixture/unrelated.jsonl" };
      if (negative === "identity") selected.conversationId = parent.id;
      if (negative === "superseded") parent.supersededBy = { conversationId: "conversation_successor", at: "2026-09-01", reason: "stage-retry" };
      await projectStructuredFileLiveness([selected], registry, snapshot);
      await render(selected, surface);
      assert.equal(await interrupt.count(), 0, `${surface}/${negative}: no interrupt`);
      assert.equal(await kill.count(), 0, `${surface}/${negative}: no stop`);
      assert.equal(effects.length, beforeStop);
      results.push(`${surface}/${negative}: controls absent`);
    }
  }
  const beforeMismatch = effects.length;
  const mismatch = await applyConversationAction({ action: "interrupt", conversationId: rootFile.conversationId!, transcriptPath: child.path }, dependencies);
  assert.equal(mismatch.status, 409);
  assert.equal(effects.length, beforeMismatch);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ results, effects: effects.length, selectedIdentityPreserved: true, mismatchStatus: mismatch.status, errors }, null, 2));
  console.log(results.join("\n"));
} finally { await browser.close(); server.stop(true); }
