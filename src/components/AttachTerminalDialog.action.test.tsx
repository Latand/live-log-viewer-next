import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AttachTerminalDialog } from "./AttachTerminalDialog";

/* Finding 3: the Terminal dialog must fetch the *live* tmux attach command for a
   running pane and the *resume* command otherwise — never a resume command for a
   conversation still attachable in its pane. Finding 4: the secondary viewer-pane
   action must surface a failure rather than appear to complete. */

const dom = new Window();
useActEnv();
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

async function mount(mode: "live" | "resume"): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  // The dialog fetches its command on mount; settle that microtask inside act so
  // the loading→loaded update is flushed without an out-of-act warning.
  await act(async () => {
    root.render(<AttachTerminalDialog file={file} mode={mode} onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

test("live mode requests the tmux attach endpoint and renders the read-only variant", async () => {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ attach: { target: "%12", command: "tmux attach -t %12", readOnlyCommand: "tmux attach -r -t %12" } }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount("live");
  expect(urls.some((u) => u.includes("/api/tmux") && u.includes("attach=1"))).toBe(true);
  expect(urls.some((u) => u.includes("/api/attach-command"))).toBe(false);
  expect(host.textContent).toContain("tmux attach -r -t %12");
  await act(async () => root.unmount());
});

test("resume mode requests the attach-command endpoint", async () => {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ engine: "claude", accountId: "d", accountLabel: "D", cwd: "/x", command: "claude --resume 1", cdCommand: "cd '/x'", fullCommand: "cd '/x' && claude --resume 1" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount("resume");
  expect(urls.some((u) => u.includes("/api/attach-command"))).toBe(true);
  expect(urls.some((u) => u.includes("attach=1"))).toBe(false);
  await act(async () => root.unmount());
});

test("a failed viewer-pane action surfaces the error instead of silently completing", async () => {
  const responses: Record<string, Response> = {};
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("attach=1")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ attach: { target: "%12", command: "tmux attach -t %12", readOnlyCommand: "tmux attach -r -t %12" } }) } as unknown as Response);
    }
    // the POST viewer-pane action fails
    void init;
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "tmux endpoint down" }) } as unknown as Response);
  }) as typeof fetch;
  void responses;

  const { host, root } = await mount("live");
  const secondary = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(translate("en", "attach.secondaryViewer")))!;
  await click(secondary as HTMLButtonElement);
  const alerts = [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "");
  expect(alerts.some((text) => text.includes("tmux endpoint down"))).toBe(true);
  await act(async () => root.unmount());
});
