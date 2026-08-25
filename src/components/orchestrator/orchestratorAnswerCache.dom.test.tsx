import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/*
 * Switching projects must be IMMEDIATE (issue #1149 acceptance 2 and 4): the
 * seat and the incumbent are answers this tab already has for a project it has
 * already visited, so returning to it paints them in the FIRST commit and the
 * poll revalidates behind that paint. The loading state is what a project this
 * tab has never answered for gets, and nothing else.
 *
 * The panel is re-seated (remounted) on a switch, so every render below mounts
 * the probe under `key={project}` exactly as `OrchestratorDock` mounts the
 * panel — a cache that only survived because the subtree did would prove
 * nothing.
 */

const dom = new HappyWindow();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

const { resetOrchestratorSeatCacheForTests, useOrchestratorSeat } = await import("./useOrchestratorSeat");
const { resetOrchestratorIncumbentCacheForTests, useOrchestratorIncumbent } = await import("./useOrchestratorIncumbent");

/** One project's answers on the server, as the two routes report them. */
const seats = new Map<string, string>();
const models = new Map<string, string>();
const viewerMcpCwds = new Set<string>();
/** Reads issued per project, so «revalidated in the background» is a count and
    not a hope. */
let seatReads: string[];
let statusReads: string[];
const realFetch = globalThis.fetch;

function seatBody(project: string, cwd: string): unknown {
  const conversationId = seats.get(project);
  if (!conversationId) return { seat: null, pending: null, exists: true, viewerMcpRegistered: viewerMcpCwds.has(cwd) };
  return {
    seat: {
      project,
      seatEpoch: 1,
      conversationId,
      path: `/transcripts/${conversationId}.jsonl`,
      mandate: "run it",
      promptVersion: 3,
      predecessorConversationId: null,
      state: "active",
      intent: { clientRequestId: "req-aaaaaaaa", mode: "spawn", launchId: "launch-a", error: null },
    },
    pending: null,
    exists: true,
    viewerMcpRegistered: viewerMcpCwds.has(cwd),
  };
}

function statusBody(project: string): unknown {
  return {
    project,
    designated: Boolean(seats.get(project)),
    conversationId: seats.get(project) ?? null,
    engine: "claude",
    model: models.get(project) ?? null,
    context: null,
    rotation: null,
  };
}

beforeEach(() => {
  resetOrchestratorSeatCacheForTests();
  resetOrchestratorIncumbentCacheForTests();
  seats.clear();
  models.clear();
  viewerMcpCwds.clear();
  seatReads = [];
  statusReads = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const project = url.searchParams.get("project") ?? "";
    if (url.pathname === "/api/orchestrator/seat/status") {
      statusReads.push(project);
      return { ok: true, status: 200, json: async () => statusBody(project) } as Response;
    }
    seatReads.push(project);
    return { ok: true, status: 200, json: async () => seatBody(project, url.searchParams.get("cwd") ?? "") } as Response;
  }) as typeof fetch;
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  globalThis.fetch = realFetch;
});

/** Everything the panel derives its state from: the seat answer (or loading),
    the incumbent model, and the cwd-scoped Viewer MCP preflight. */
function Probe({ project, cwd }: { project: string; cwd?: string }) {
  const { status, failed } = useOrchestratorSeat(project, cwd);
  const { incumbent } = useOrchestratorIncumbent(project, Boolean(status?.seat));
  return (
    <div
      data-seat={status ? status.seat?.conversationId ?? "vacant" : failed ? "unavailable" : "loading"}
      data-model={incumbent?.model ?? "unread"}
      data-viewer-mcp={status?.viewerMcpRegistered ? "registered" : "missing"}
    />
  );
}

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

function mountProbe() {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  const probe = () => host.querySelector("div[data-seat]")!;
  return {
    /* Keyed by project and cwd, the status scope the panel opens. */
    open: (project: string, cwd?: string) => flushSync(() => root.render(<Probe key={`${project}:${cwd ?? ""}`} project={project} cwd={cwd} />)),
    seat: () => probe().getAttribute("data-seat"),
    model: () => probe().getAttribute("data-model"),
    viewerMcp: () => probe().getAttribute("data-viewer-mcp"),
  };
}

test("the Viewer MCP preflight cache is scoped by cwd inside one grouped project", async () => {
  const dock = mountProbe();
  viewerMcpCwds.add("/repo/atlas/registered");

  dock.open("atlas", "/repo/atlas/missing");
  await settle();
  expect(dock.viewerMcp()).toBe("missing");

  dock.open("atlas", "/repo/atlas/registered");
  expect(dock.seat()).toBe("loading");
  await settle();
  expect(dock.viewerMcp()).toBe("registered");

  dock.open("atlas", "/repo/atlas/missing");
  expect(dock.viewerMcp()).toBe("missing");
});

test("a project answered once repaints from the answer, and revalidates behind it", async () => {
  seats.set("atlas", "conversation_atlas");
  seats.set("borealis", "conversation_borealis");

  const dock = mountProbe();

  /* First visit is unchanged: nothing is known, so the panel loads. */
  dock.open("atlas");
  expect(dock.seat()).toBe("loading");
  await settle();
  expect(dock.seat()).toBe("conversation_atlas");
  expect(seatReads.filter((project) => project === "atlas")).toHaveLength(1);

  /* A project this tab has never answered for still loads — the cache answers
     for the project it was filled by and no other. */
  dock.open("borealis");
  expect(dock.seat()).toBe("loading");
  await settle();
  expect(dock.seat()).toBe("conversation_borealis");

  /* Back to atlas: the answer is on screen in the commit the switch produced,
     before any request could have been made, let alone answered. */
  const readsBefore = seatReads.length;
  dock.open("atlas");
  expect(dock.seat()).toBe("conversation_atlas");

  /* And the read still happens — stale WHILE it revalidates. A rotation that
     landed while the operator was away lands in place, with no loading frame
     in between. */
  seats.set("atlas", "conversation_successor");
  await settle();
  expect(seatReads.length).toBeGreaterThan(readsBefore);
  expect(seatReads.filter((project) => project === "atlas")).toHaveLength(2);
  expect(dock.seat()).toBe("conversation_successor");
});

test("the incumbent reading survives the switch too, so the header never falls back mid-conversation", async () => {
  seats.set("atlas", "conversation_atlas");
  models.set("atlas", "opus");
  seats.set("borealis", "conversation_borealis");
  models.set("borealis", "gpt-5.6");

  const dock = mountProbe();
  dock.open("atlas");
  await settle();
  expect(dock.model()).toBe("opus");

  dock.open("borealis");
  await settle();
  expect(dock.model()).toBe("gpt-5.6");

  /* The return trip: the incumbent's model is there in the same first commit
     as the seat, so the header renders complete rather than degrading to what
     the board alone knows while a 60s-cadence read catches up. */
  const readsBefore = statusReads.length;
  dock.open("atlas");
  expect(dock.seat()).toBe("conversation_atlas");
  expect(dock.model()).toBe("opus");

  models.set("atlas", "opus-successor");
  await settle();
  expect(statusReads.length).toBeGreaterThan(readsBefore);
  expect(dock.model()).toBe("opus-successor");
});

test("a failed re-read keeps the project's own last answer, never another project's", async () => {
  seats.set("atlas", "conversation_atlas");
  const dock = mountProbe();
  dock.open("atlas");
  await settle();

  /* Every read fails from here. Atlas keeps what it knows... */
  globalThis.fetch = (async () => {
    throw new Error("network dropped");
  }) as unknown as typeof fetch;
  dock.open("atlas");
  expect(dock.seat()).toBe("conversation_atlas");
  await settle();
  expect(dock.seat()).toBe("conversation_atlas");

  /* ...and a project that never answered gets no answer of anyone else's: it
     says the panel cannot be read, which is what the operator needs to see. */
  dock.open("borealis");
  expect(dock.seat()).toBe("loading");
  await settle();
  expect(dock.seat()).toBe("unavailable");
});
