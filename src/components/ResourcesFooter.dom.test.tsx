import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ResourceSession } from "@/lib/types";

import { CleanupPanel } from "./ResourcesFooter";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.MouseEvent,
});

const NOW = Date.parse("2026-08-26T12:00:00.000Z") / 1_000;
const hoursAgo = (hours: number) => new Date((NOW - hours * 3_600) * 1_000).toISOString();

function host(over: Partial<ResourceSession> & Pick<ResourceSession, "target">): ResourceSession {
  return {
    panePid: 4_100,
    kind: "structured",
    path: null,
    engine: "claude",
    title: "Structured lane",
    project: "live-log-viewer-next",
    activity: "idle",
    lastActiveAt: hoursAgo(6),
    cwd: "/repo/worktree",
    rssBytes: 600 * 1024 * 1024,
    swapBytes: 0,
    procCount: 3,
    model: "opus",
    role: "builder",
    conversationId: null,
    stage: "implement",
    ownership: "owned",
    seat: false,
    turnBusy: false,
    ...over,
  };
}

interface KillCall {
  url: string;
  body: { action?: string; target?: string; includeSeat?: boolean; intent?: string; idleHours?: number };
}

function stubFetch(): KillCall[] {
  const calls: KillCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return calls;
}

const mounted: Array<() => void> = [];

function mount(sessions: ResourceSession[]): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  const root: Root = createRoot(element);
  flushSync(() => {
    root.render(<CleanupPanel sessions={sessions} now={NOW} onRefresh={async () => {}} onClose={() => {}} />);
  });
  mounted.push(() => {
    flushSync(() => { root.unmount(); });
    element.remove();
  });
  return element as unknown as HTMLElement;
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  flushSync(() => {
    element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });
}

/** Bulk kills run one request at a time; let the sequence drain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonLabelled(view: HTMLElement, text: string): HTMLElement | null {
  return [...view.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) as HTMLElement ?? null;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  document.body.replaceChildren();
});

test("structured hosts get a row each, with role, stage, model and ownership", () => {
  const view = mount([
    host({ target: "structured:claude:lane" }),
    host({ target: "structured:codex:released", engine: "codex", title: "Released host", ownership: "released", role: null, stage: null, model: null }),
    host({ target: "structured:claude:orphan", title: null, ownership: "orphaned", cwd: "/repo/deleted-worktree" }),
    { target: "agents:4.0", panePid: 100, path: null, engine: "codex", title: "Legacy pane", project: null, activity: "idle", lastActiveAt: hoursAgo(6), cwd: "/repo", rssBytes: 1024, swapBytes: 0, procCount: 1 },
  ]);

  const rows = view.querySelectorAll('[data-testid="resource-host-row"]');
  expect([...rows].map((row) => row.getAttribute("data-target"))).toEqual([
    "structured:claude:lane",
    "structured:codex:released",
    "structured:claude:orphan",
  ]);
  expect(view.querySelectorAll('[data-testid="resource-pane-row"]')).toHaveLength(1);

  const lane = rows[0]!.textContent ?? "";
  expect(lane).toContain("Structured lane");
  expect(lane).toContain("builder");
  expect(lane).toContain("implement");
  expect(lane).toContain("opus");
  expect(lane).toContain("owned");
  expect(rows[1]!.textContent).toContain("released");
  expect(rows[2]!.textContent).toContain("orphaned");
  /* The empty state used to name tmux; the list is transport-neutral now. */
  expect(view.textContent).not.toContain("tmux");
});

test("the header counts hosts, idle hosts and the memory they hold", () => {
  const view = mount([
    host({ target: "structured:claude:lane" }),
    host({ target: "structured:claude:live", activity: "live", lastActiveAt: hoursAgo(0), rssBytes: 400 * 1024 * 1024 }),
  ]);

  const counts = view.querySelector('[data-testid="resources-counts"]')?.textContent ?? "";
  expect(counts).toContain("2 hosts");
  expect(counts).toContain("1 idle");
  expect(counts).toContain("1000 MiB");
});

test("an empty list says so without naming a transport", () => {
  const view = mount([]);

  expect(view.textContent).toContain("no agent sessions running");
  expect(view.textContent).not.toContain("tmux");
});

test("a per-row kill posts the host target to the structured kill endpoint", async () => {
  const calls = stubFetch();
  const view = mount([host({ target: "structured:claude:lane" })]);

  click(buttonLabelled(view, "Kill"));
  await settle();

  expect(calls).toEqual([{
    url: "/api/runtime/hosts",
    body: { action: "kill", target: "structured:claude:lane", intent: "row", includeSeat: true },
  }]);
});

test("kill idle skips the live host and the unticked orchestrator seat", async () => {
  const calls = stubFetch();
  const view = mount([
    host({ target: "structured:claude:lane" }),
    host({ target: "structured:claude:live", activity: "live", lastActiveAt: hoursAgo(0) }),
    host({ target: "structured:codex:seat", engine: "codex", seat: true }),
  ]);

  const bulk = buttonLabelled(view, "Kill idle");
  expect(bulk?.textContent).toContain("(1)");
  click(bulk);
  await settle();

  /* The threshold travels with the request: the server re-proves the idle age
     against it rather than trusting the snapshot the rail polled. */
  expect(calls.map((call) => call.body)).toEqual([
    { action: "kill", target: "structured:claude:lane", intent: "idle", includeSeat: false, idleHours: 2 },
  ]);
});

test("ticking an orchestrator seat brings it into the bulk kills", async () => {
  const calls = stubFetch();
  const view = mount([
    host({ target: "structured:claude:lane" }),
    host({ target: "structured:codex:seat", engine: "codex", seat: true }),
  ]);

  click(view.querySelector('[data-target="structured:codex:seat"] input[type="checkbox"]'));
  const bulk = buttonLabelled(view, "Kill idle");
  expect(bulk?.textContent).toContain("(2)");
  click(bulk);
  await settle();

  expect(calls.map((call) => [call.body.target, call.body.includeSeat, call.body.intent])).toEqual([
    ["structured:claude:lane", false, "idle"],
    ["structured:codex:seat", true, "idle"],
  ]);
});

test("kill all arms first, then force-kills the live hosts too but never an unticked seat", async () => {
  const calls = stubFetch();
  const view = mount([
    host({ target: "structured:claude:live", activity: "live", lastActiveAt: hoursAgo(0) }),
    host({ target: "structured:codex:seat", engine: "codex", seat: true }),
  ]);

  const nuke = buttonLabelled(view, "Kill all agents");
  expect(nuke?.textContent).toContain("(1)");
  click(nuke);
  expect(calls).toEqual([]);

  click(buttonLabelled(view, "Confirm"));
  await settle();
  expect(calls.map((call) => [call.body.target, call.body.intent])).toEqual([["structured:claude:live", "all"]]);
});
