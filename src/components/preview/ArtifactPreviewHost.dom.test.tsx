import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { formatArtifactFragment } from "@/lib/artifact/fragment";
import { setLocale } from "@/lib/i18n";

import { setLeftShellInset } from "../shellLayout";
import { ArtifactPreviewHost, roomForSheet } from "./ArtifactPreviewHost";
import { artifactMetaUrl } from "./artifactResource";
import { openArtifactPreview } from "./previewBus";

installActEnv();

/* A real http URL so the fragment-routing tests can read and write
   location.hash and history entries like a served page. */
const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

type Route = { status: number; body: string | object; headers?: Record<string, string> };
let fetchLog: { url: string; headers: Record<string, string> }[] = [];
let routes: ((url: URL, headers: Record<string, string>) => Route | null)[] = [];

function respond(route: Route): Response {
  const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
  return new Response(body, { status: route.status, headers: route.headers });
}

(globalThis as { fetch: unknown }).fetch = (input: string | URL, init?: { headers?: Record<string, string> }) => {
  const url = new URL(String(input), "http://127.0.0.1:8898");
  const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  fetchLog.push({ url: url.pathname + url.search, headers });
  for (const route of routes) {
    const hit = route(url, headers);
    if (hit) return Promise.resolve(respond(hit));
  }
  return Promise.resolve(respond({ status: 404, body: { error: "file not found", code: "not-found" } }));
};

const TEXT_PATH = "~/fixtures/report/build.log";
const TEXT_BODY = "first line\nsecond line\nthird line with needle\n";

function textRoutes(): void {
  routes = [
    (url, headers) => {
      if (!url.pathname.startsWith("/api/artifact")) return null;
      if (url.searchParams.get("path") !== TEXT_PATH) return null;
      if (url.searchParams.get("mode") === "meta") {
        return {
          status: 200,
          body: { name: "build.log", kind: "text", mime: "text/plain; charset=utf-8", size: TEXT_BODY.length, etag: '"e1"' },
        };
      }
      const range = headers["range"];
      const match = range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = match ? Number(match[1]) : 0;
      const end = match ? Math.min(Number(match[2]), TEXT_BODY.length - 1) : TEXT_BODY.length - 1;
      return {
        status: match ? 206 : 200,
        body: TEXT_BODY.slice(start, end + 1),
        headers: { "content-range": `bytes ${start}-${end}/${TEXT_BODY.length}`, etag: '"e1"' },
      };
    },
  ];
}

let root: Root | null = null;
let host: ReturnType<typeof dom.document.createElement> | null = null;

beforeEach(() => {
  setLocale("en");
  fetchLog = [];
  routes = [];
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
  /* The shared window carries its URL across tests: strip any fragment a
     fragment-routing test left behind so later tests start hash-free, and
     drain the async hashchange happy-dom schedules for every fragment
     mutation (the strip here, a close's replaceState inside a test) so no
     stray event fires into the next test outside act. */
  dom.history.replaceState(null, "", dom.location.pathname);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function render(mobile = false): Promise<void> {
  await act(async () => {
    root!.render(<ArtifactPreviewHost mobile={mobile} />);
  });
}

function surface(): HTMLElement | null {
  return dom.document.querySelector("[data-artifact-preview]") as unknown as HTMLElement | null;
}

test("renders nothing until a preview opens, then shows title, size and bounded text", async () => {
  textRoutes();
  await render();
  expect(surface()).toBeNull();

  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();

  const sheet = surface();
  expect(sheet).not.toBeNull();
  expect(sheet!.getAttribute("data-artifact-state")).toBe("ready");
  expect(sheet!.getAttribute("data-artifact-kind")).toBe("text");
  const text = sheet!.textContent!;
  expect(text).toContain("build.log");
  expect(text).toContain("second line");
  /* line numbers are rendered in a dedicated gutter */
  expect(sheet!.querySelector("[data-line-number]")).not.toBeNull();
  /* only the artifact route was touched: no snapshot, scan or transcript fetch */
  expect(fetchLog.length).toBeGreaterThan(0);
  for (const call of fetchLog) expect(call.url.startsWith("/api/artifact")).toBe(true);
  /* content requests are bounded byte ranges */
  const contentCalls = fetchLog.filter((call) => !call.url.includes("mode=meta"));
  expect(contentCalls.every((call) => /^bytes=\d+-\d+$/.test(call.headers["range"] ?? ""))).toBe(true);
});

test("search reports matches within the loaded content", async () => {
  textRoutes();
  await render();
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();

  const input = surface()!.querySelector("input[type='search']") as unknown as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    input.value = "needle";
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(surface()!.textContent).toContain("1/1");
});

test("missing, denied and oversized artifacts show explicit states", async () => {
  await render();

  routes = [() => ({ status: 404, body: { error: "file not found", code: "not-found" } })];
  await act(async () => openArtifactPreview("~/fixtures/gone.md"));
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("missing");

  routes = [() => ({ status: 403, body: { error: "path not allowed", code: "access-denied" } })];
  await act(async () => openArtifactPreview("~/fixtures/denied.md"));
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("denied");

  routes = [() => ({ status: 413, body: { error: "artifact exceeds the configured byte bound", code: "too-large" } })];
  await act(async () => openArtifactPreview("~/fixtures/huge.md"));
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("oversized");
});

test("a stale validator mid-read surfaces the changed state", async () => {
  routes = [
    (url) => url.searchParams.get("mode") === "meta"
      ? { status: 200, body: { name: "live.log", kind: "text", mime: "text/plain; charset=utf-8", size: 10, etag: '"old"' } }
      : { status: 412, body: { error: "file changed since the preview opened", code: "changed" } },
  ];
  await render();
  await act(async () => openArtifactPreview("~/fixtures/live.log"));
  await flush();
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("changed");
});

test("escape closes the preview, restores opener focus and never touches history", async () => {
  textRoutes();
  const opener = dom.document.createElement("button");
  dom.document.body.appendChild(opener);
  (opener as unknown as HTMLElement).focus();

  await render();
  const hashBefore = dom.location.hash;
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();
  expect(surface()).not.toBeNull();

  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });
  expect(surface()).toBeNull();
  expect(dom.location.hash).toBe(hashBefore);
  expect(dom.document.activeElement).toBe(opener);
});

test("switching artifacts reuses the same sheet element", async () => {
  textRoutes();
  await render();
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();
  const first = surface();

  routes = [
    (url) => url.searchParams.get("mode") === "meta"
      ? { status: 200, body: { name: "other.md", kind: "text", mime: "text/plain; charset=utf-8", size: 4, etag: '"e2"' } }
      : { status: 206, body: "# hi", headers: { "content-range": "bytes 0-3/4", etag: '"e2"' } },
  ];
  await act(async () => openArtifactPreview("~/fixtures/other.md"));
  await flush();
  await flush();
  expect(surface()).toBe(first);
  expect(surface()!.textContent).toContain("other.md");
});

test("search walks every occurrence: a multi-hit line counts per occurrence and wrap reaches all", async () => {
  const OCC_PATH = "~/fixtures/occurrences.log";
  const OCC_BODY = "alpha needle beta needle\nplain line\nneedle end\n";
  routes = [
    (url) => {
      if (url.searchParams.get("path") !== OCC_PATH) return null;
      if (url.searchParams.get("mode") === "meta") {
        return {
          status: 200,
          body: { name: "occurrences.log", kind: "text", mime: "text/plain; charset=utf-8", size: OCC_BODY.length, etag: '"o1"' },
        };
      }
      return {
        status: 206,
        body: OCC_BODY,
        headers: { "content-range": `bytes 0-${OCC_BODY.length - 1}/${OCC_BODY.length}`, etag: '"o1"' },
      };
    },
  ];
  await render();
  await act(async () => openArtifactPreview(OCC_PATH));
  await flush();
  await flush();

  const input = surface()!.querySelector("input[type='search']") as unknown as HTMLInputElement;
  await act(async () => {
    input.value = "needle";
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  const counter = () => surface()!.querySelector("[data-preview-matches]")!.textContent;
  /* three occurrences across two lines: two on line 0, one on line 2 */
  expect(counter()).toBe("1/3");

  const next = surface()!.querySelector('[aria-label="Next match"]') as unknown as HTMLElement;
  const prev = surface()!.querySelector('[aria-label="Previous match"]') as unknown as HTMLElement;
  await act(async () => next.click());
  expect(counter()).toBe("2/3");
  await act(async () => next.click());
  expect(counter()).toBe("3/3");
  await act(async () => next.click());
  expect(counter()).toBe("1/3");
  await act(async () => prev.click());
  expect(counter()).toBe("3/3");
});

const IMG_PATH = "~/fixtures/shot.png";

function imageRoute(contentStatus: number) {
  return (url: URL): Route | null => {
    if (url.searchParams.get("path") !== IMG_PATH) return null;
    if (url.searchParams.get("mode") === "meta") {
      return {
        status: 200,
        body: { name: "shot.png", kind: "image", mime: "image/png", size: 4, etag: '"i1"' },
      };
    }
    if (contentStatus === 413) return { status: 413, body: { error: "artifact exceeds the configured byte bound", code: "too-large" } };
    return { status: 200, body: "PNG!", headers: { etag: '"i1"' } };
  };
}

test("image bytes load through a validator-bound fetch into an object url", async () => {
  routes = [imageRoute(200)];
  await render();
  await act(async () => openArtifactPreview(IMG_PATH));
  await flush();
  await flush();
  await flush();

  expect(surface()!.getAttribute("data-artifact-state")).toBe("ready");
  const img = surface()!.querySelector("img");
  expect(img).not.toBeNull();
  expect((img!.getAttribute("src") ?? "").startsWith("blob:")).toBe(true);
  const content = fetchLog.filter((call) => !call.url.includes("mode=meta"));
  expect(content.length).toBe(1);
  expect(content[0].headers["if-match"]).toBe('"i1"');
});

test("an image over the byte bound shows the explicit oversized state", async () => {
  routes = [imageRoute(413)];
  await render();
  await act(async () => openArtifactPreview(IMG_PATH));
  await flush();
  await flush();
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("oversized");
});

test("mobile pane controls carry the 44px touch-target sizing", async () => {
  textRoutes();
  routes.push(imageRoute(200));
  await render(true);
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();

  const sheet = surface()!;
  const input = sheet.querySelector("input[type='search']")!;
  expect(input.className).toContain("h-11");
  await act(async () => {
    (input as unknown as HTMLInputElement).value = "needle";
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  for (const label of ["Previous match", "Next match", "Wrap lines"]) {
    expect(sheet.querySelector(`[aria-label="${label}"]`)!.className).toContain("h-11 w-11");
  }

  await act(async () => openArtifactPreview(IMG_PATH));
  await flush();
  await flush();
  await flush();
  for (const label of ["Zoom out", "Zoom in", "Fit to pane"]) {
    expect(surface()!.querySelector(`[aria-label="${label}"]`)!.className).toContain("h-11 w-11");
  }
});

/* ── #884: the #a= fragment is the preview's own URL entry point ──────── */

/** Set the fragment and drain the hashchange happy-dom schedules on a later
    task, all inside act — no event may leak across act boundaries or into
    the next test. */
async function setHash(hash: string): Promise<void> {
  await act(async () => {
    dom.history.replaceState(null, "", hash || dom.location.pathname);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const navigateHash = setHash;

test("a pasted #a= URL opens the preview on load through the same /api/artifact authorization a click uses", async () => {
  textRoutes();
  await setHash(formatArtifactFragment(TEXT_PATH));
  await render();
  await flush();
  await flush();

  const sheet = surface();
  expect(sheet).not.toBeNull();
  expect(sheet!.getAttribute("data-artifact-state")).toBe("ready");
  expect(sheet!.textContent).toContain("build.log");
  /* The security invariant: the fragment funnels into the exact request a
     clicked link issues — no other read path exists. */
  expect(fetchLog[0].url).toBe(artifactMetaUrl(TEXT_PATH));
  for (const call of fetchLog) expect(call.url.startsWith("/api/artifact")).toBe(true);
});

test("fragment-named unsupported, out-of-root and missing paths land on the explicit states — never a silent redirect", async () => {
  routes = [() => ({ status: 415, body: { error: "not a previewable artifact type", code: "unsupported" } })];
  await setHash(formatArtifactFragment("~/checkouts/session.jsonl"));
  await render();
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("unsupported");

  routes = [() => ({ status: 403, body: { error: "path is outside the allowed roots", code: "access-denied" } })];
  await navigateHash(formatArtifactFragment("/outside/secret.md"));
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("denied");

  routes = [];
  await navigateHash(formatArtifactFragment("~/checkouts/gone.png"));
  await flush();
  expect(surface()!.getAttribute("data-artifact-state")).toBe("missing");
});

test("navigating the hash off the artifact fragment closes a fragment-opened preview; a click-opened one stays", async () => {
  textRoutes();
  await setHash(formatArtifactFragment(TEXT_PATH));
  await render();
  await flush();
  await flush();
  expect(surface()).not.toBeNull();

  await navigateHash("#p=board");
  expect(surface()).toBeNull();

  /* A click-opened preview is pure same-document state (#875): hash
     navigation elsewhere in the app must not tear it down. */
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();
  expect(surface()).not.toBeNull();
  await navigateHash("#p=elsewhere");
  expect(surface()).not.toBeNull();
});

test("closing a fragment-opened preview strips the fragment in place: no new history entry, no resurrect on reload", async () => {
  textRoutes();
  await setHash(formatArtifactFragment(TEXT_PATH));
  await render();
  await flush();
  await flush();
  expect(surface()).not.toBeNull();

  const length = dom.history.length;
  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    /* Drain the async hashchange the strip's replaceState schedules, inside
       this act: the closed host must shrug it off (no reopen, no throw). */
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(surface()).toBeNull();
  expect(dom.location.hash).toBe("");
  expect(dom.history.length).toBe(length);
});

test("closing a click-opened preview leaves a foreign hash untouched", async () => {
  textRoutes();
  await setHash("#p=board");
  await render();
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();
  expect(surface()).not.toBeNull();

  await act(async () => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });
  expect(surface()).toBeNull();
  expect(dom.location.hash).toBe("#p=board");
});

test("the desktop sheet yields to the orchestrator dock so the board keeps its 320px (#977)", async () => {
  textRoutes();
  await render();
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();

  /* Nothing docked: the sheet budgets only the board's floor, as before —
     560 of a 1440px viewport, and the board gets the rest. */
  expect(surface()!.getAttribute("data-artifact-preview-inset")).toBe("0");
  expect(roomForSheet(1_440, 0)).toBe(1_120);

  /* The dock opens beside the rail (248 + 440 at its default). The sheet is
     fixed to the right edge and cannot see it in layout, so it reads the
     published inset — the one number its own clamp was missing. */
  await act(async () => setLeftShellInset(248 + 440));
  expect(surface()!.getAttribute("data-artifact-preview-inset")).toBe("688");
  /* At 1440 its remembered 560 yields to 432, and the board lands exactly on
     its 320px floor instead of the 192 it used to get. */
  expect(roomForSheet(1_440, 688)).toBe(432);
  expect(1_440 - 688 - Math.min(560, roomForSheet(1_440, 688))).toBe(320);
  /* Wider screens need no yielding: the remembered width survives. */
  expect(roomForSheet(1_920, 688)).toBeGreaterThan(560);
  /* And never below the sheet's own minimum, whatever the inset claims. */
  expect(roomForSheet(1_280, 900)).toBe(380);

  await act(async () => setLeftShellInset(0));
  expect(surface()!.getAttribute("data-artifact-preview-inset")).toBe("0");
});

test("the mobile sheet ignores the dock — it is fullscreen and nothing is docked beside it", async () => {
  textRoutes();
  await render(true);
  await act(async () => setLeftShellInset(248 + 440));
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();
  expect(surface()!.style.width).toBe("");
  expect(surface()!.getAttribute("data-artifact-preview-inset")).toBeNull();
  await act(async () => setLeftShellInset(0));
});

test("the mobile sheet is a labelled full-height dialog", async () => {
  textRoutes();
  await render(true);
  await act(async () => openArtifactPreview(TEXT_PATH));
  await flush();
  await flush();
  const sheet = surface()!;
  expect(sheet.getAttribute("role")).toBe("dialog");
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(sheet.getAttribute("aria-label")).toContain("build.log");
  expect(sheet.className).toContain("inset-0");
});
