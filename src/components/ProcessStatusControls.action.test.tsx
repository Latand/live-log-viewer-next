import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { useActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";

/* Finding 2 (issue #241 §4): the header Kill must obey the one capability matrix
   rather than posting to `/api/proc` on every running PID. A structured host
   shows a *disabled* Kill with the #240 tooltip; a dead host omits it; a live
   tmux root (or shell task) hits the endpoint. A scanner-shaped live subagent
   (proc:null, pid:null — the root writes its transcript) still shows an enabled
   Kill whose /api/proc call the server resolves to the canonical root pid. The
   runtime hooks are mocked so each surface is exercised deterministically. */

let currentRv: RuntimeSessionView | null = null;
let planeEnabled = false;
let rootByArtifact: (path: string | null) => RuntimeSessionView | null = () => null;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  useRuntime: () => ({ enabled: planeEnabled, connection: planeEnabled ? "live" : "offline", resyncedAt: null, store: {} }),
  useRuntimeSession: () => currentRv,
  useRuntimeSessionByArtifact: (path: string | null) => rootByArtifact(path),
}));

const { ProcessStatusControls } = await import("./TaskHeader");

const dom = new Window();
useActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

function rv(hostKind: HostKind, host: HostAxis, artifactPath?: string): RuntimeSessionView {
  return { session: { hostKind, host, artifactPath, conversationId: "conversation_root" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: hostKind === "tmux-legacy", structuredControlsEnabled: true };
}

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/c.jsonl", root: "claude-projects", name: "c.jsonl", project: "viewer", title: "c",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity: "live", proc: "running", pid: 77, model: "sonnet", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null, ...over,
  } as FileEntry;
}

const realFetch = globalThis.fetch;

async function mount(f: FileEntry): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ProcessStatusControls file={f} />));
  return { host, root };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  currentRv = null;
  planeEnabled = false;
  rootByArtifact = () => null;
  document.body.replaceChildren();
});

const killBtns = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("button")).filter((b) => (b.textContent ?? "").includes(translate("en", "task.kill")));

const clickButton = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

test("a live tmux root shows an enabled Kill that confirms then posts to /api/proc", async () => {
  currentRv = null; // no structured host → live-root
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(String(url));
    void init;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, pid: 77 }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount(file());
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(false);
  // first click arms the confirmation, no request yet
  await clickButton(kill);
  expect(calls.length).toBe(0);
  const confirm = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(translate("en", "task.confirmKillYes")))!;
  await clickButton(confirm as HTMLButtonElement);
  expect(calls.filter((u) => u.includes("/api/proc")).length).toBe(1);
  await act(async () => root.unmount());
});

test("a scanner-shaped subagent under a live TMUX root shows an enabled Kill that posts the child path (server resolves the root)", async () => {
  // The runtime plane is authoritative and carries the live tmux root keyed by
  // the subagent's artifact path — the production shape (finding 2).
  planeEnabled = true;
  rootByArtifact = (path) => (path === "/root.jsonl" ? rv("tmux-legacy", "hosted", "/root.jsonl") : null);
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, pid: 5 }) } as unknown as Response);
  }) as typeof fetch;

  const child = file({ path: "/child.jsonl", kind: "subagent", parent: "/root.jsonl", proc: null, pid: null });
  const { host, root } = await mount(child);
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(false);
  await clickButton(kill);
  const confirm = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(translate("en", "task.confirmKillYes")))!;
  await clickButton(confirm as HTMLButtonElement);
  const procCalls = calls.filter((c) => c.url.includes("/api/proc"));
  expect(procCalls.length).toBe(1);
  // The client sends the child path; /api/proc resolves it to the root pid.
  expect(procCalls[0]!.body).toMatchObject({ path: "/child.jsonl" });
  await act(async () => root.unmount());
});

test("a scanner-shaped subagent under a live STRUCTURED root shows an ENABLED Kill routed to the ROOT's structured channel (#242) — zero /api/proc", async () => {
  planeEnabled = true;
  rootByArtifact = (path) => (path === "/root.jsonl" ? rv("claude-broker", "hosted", "/root.jsonl") : null);
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, structured: true, target: "conversation_root" }) } as unknown as Response);
  }) as typeof fetch;

  const child = file({ path: "/child.jsonl", kind: "subagent", parent: "/root.jsonl", proc: null, pid: null });
  const { host, root } = await mount(child);
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(false);
  await clickButton(kill);
  const confirm = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(translate("en", "task.confirmKillYes")))!;
  await clickButton(confirm as HTMLButtonElement);
  // exactly one structured request via /api/tmux, carrying the ROOT identity;
  // never /api/proc for a structured host.
  const tmuxCalls = calls.filter((c) => c.url.includes("/api/tmux"));
  expect(tmuxCalls.length).toBe(1);
  expect(tmuxCalls[0]!.body).toMatchObject({ action: "kill", conversationId: "conversation_root" });
  expect(calls.some((c) => c.url.includes("/api/proc"))).toBe(false);
  await act(async () => root.unmount());
});

test("a scanner-shaped subagent whose root is dead omits the Kill entirely", async () => {
  planeEnabled = true;
  rootByArtifact = (path) => (path === "/root.jsonl" ? rv("claude-broker", "dead", "/root.jsonl") : null);
  const child = file({ path: "/child.jsonl", kind: "subagent", parent: "/root.jsonl", proc: null, pid: null });
  const { host, root } = await mount(child);
  expect(killBtns(host).length).toBe(0);
  await act(async () => root.unmount());
});

test("a structured host shows an ENABLED Kill routed to its structured channel (#242) — one request, zero /api/proc", async () => {
  currentRv = rv("codex-app-server", "hosted");
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, structured: true, target: "conversation_root" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount(file());
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(false);
  await clickButton(kill);
  const confirm = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(translate("en", "task.confirmKillYes")))!;
  await clickButton(confirm as HTMLButtonElement);
  const tmuxCalls = calls.filter((c) => c.url.includes("/api/tmux"));
  expect(tmuxCalls.length).toBe(1);
  expect(tmuxCalls[0]!.body).toMatchObject({ action: "kill", conversationId: "conversation_root" });
  expect(calls.some((c) => c.url.includes("/api/proc"))).toBe(false);
  await act(async () => root.unmount());
});

test("with the structured-hosts gate OFF a structured host falls back to the legacy /api/proc Kill", async () => {
  // Rollback (finding 1): the registry still reads structured, but the gate is
  // off, so the header resolves through legacy capabilities and Kill hits /api/proc.
  planeEnabled = true;
  currentRv = { ...rv("codex-app-server", "hosted"), structuredControlsEnabled: false };
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, pid: 77 }) } as unknown as Response); }) as typeof fetch;

  const { host, root } = await mount(file());
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(false);
  await clickButton(kill);
  const confirm = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(translate("en", "task.confirmKillYes")))!;
  await clickButton(confirm as HTMLButtonElement);
  expect(calls.filter((u) => u.includes("/api/proc")).length).toBe(1);
  expect(calls.some((u) => u.includes("/api/runtime"))).toBe(false);
  await act(async () => root.unmount());
});

test("a dead host omits the Kill control entirely (the banner owns recovery)", async () => {
  currentRv = rv("claude-broker", "dead");
  const { host, root } = await mount(file());
  expect(killBtns(host).length).toBe(0);
  await act(async () => root.unmount());
});

test("an unresolved host (plane on, no session yet) omits the Kill — no /api/proc before host evidence", async () => {
  // finding 1: a running pid alone must not enable a legacy control under the plane.
  planeEnabled = true;
  currentRv = null;
  const { host, root } = await mount(file());
  expect(killBtns(host).length).toBe(0);
  await act(async () => root.unmount());
});
