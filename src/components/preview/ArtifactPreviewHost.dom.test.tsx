import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";

import { ArtifactPreviewHost } from "./ArtifactPreviewHost";
import { openArtifactPreview } from "./previewBus";

installActEnv();

const dom = new Window();
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
