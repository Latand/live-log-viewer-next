import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { AttachTerminalDialog } from "./AttachTerminalDialog";

/* Finding 3: the Terminal dialog must fetch the *live* tmux attach command for a
   running pane and the *resume* command otherwise — never a resume command for a
   conversation still attachable in its pane. */

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const file: FileEntry = {
  path: "/c.jsonl", root: "claude-projects", name: "c.jsonl", project: "viewer", title: "c",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
  activity: "live", proc: "running", pid: 12, model: "sonnet", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; document.body.replaceChildren(); });

function mount(mode: "live" | "resume"): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<AttachTerminalDialog file={file} mode={mode} onClose={() => {}} />));
  return { host, root };
}

test("live mode requests the tmux attach endpoint and renders the read-only variant", async () => {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ attach: { target: "%12", command: "tmux attach -t %12", readOnlyCommand: "tmux attach -r -t %12" } }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = mount("live");
  await new Promise((r) => setTimeout(r, 0));
  expect(urls.some((u) => u.includes("/api/tmux") && u.includes("attach=1"))).toBe(true);
  expect(urls.some((u) => u.includes("/api/attach-command"))).toBe(false);
  expect(host.textContent).toContain("tmux attach -r -t %12");
  flushSync(() => root.unmount());
});

test("resume mode requests the attach-command endpoint", async () => {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ engine: "claude", accountId: "d", accountLabel: "D", cwd: "/x", command: "claude --resume 1", fullCommand: "cd '/x' && claude --resume 1" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = mount("resume");
  await new Promise((r) => setTimeout(r, 0));
  expect(urls.some((u) => u.includes("/api/attach-command"))).toBe(true);
  expect(urls.some((u) => u.includes("attach=1"))).toBe(false);
  flushSync(() => root.unmount());
});
