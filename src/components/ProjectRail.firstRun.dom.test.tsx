import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

import { ProjectRail } from "./ProjectRail";

/*
 * Issue #1162, the empty rail. With no projects at all the FolderPlus button is
 * the only thing on screen that starts anything, and an icon alone never said
 * so — it carries its «Create project» label there, while a populated rail
 * keeps the compact icon. The same rail also answers the first-run overview's
 * create button by opening the form it already owns, including when it mounts
 * a moment later behind the phone drawer.
 */

/* React needs this before `act` will drive effects — the rail claims a pending
   create request from one. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new Window({ url: "http://localhost/" });

let viewportWidth = 1280;
const matchMediaStub = (query: string) => ({
  matches: query.includes("max-width") && viewportWidth <= 767,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false;
  },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;

Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
});

/* The rail's footers and header controls poll APIs on mount; a failed response
   leaves each of them in its own empty state. */
globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;

const { consumePendingProjectCreateForm, requestProjectCreateForm } = await import("@/lib/projects/openCreateForm");

function fileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "atlas",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    ...overrides,
  } as FileEntry;
}

const createProject = async (): Promise<CreateProjectOutcome> => ({ ok: true, project: "atlas" });

let root: Root | null = null;
function unmount() {
  if (root) act(() => root?.unmount());
  root = null;
  dom.document.body.replaceChildren();
}

afterEach(async () => {
  /* The rail's footers resolve their own failed fetches after the assertions;
     settle them inside act so React never reports an unwrapped update. */
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  unmount();
  setLocale("en");
  viewportWidth = 1280;
  consumePendingProjectCreateForm();
});

function renderRail(extra: Partial<React.ComponentProps<typeof ProjectRail>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  act(() =>
    root!.render(
      <ProjectRail
        files={[]}
        projectCatalog={[]}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        selected="__overview__"
        loaded
        now={2_000}
        onSelect={() => {}}
        onCreateProject={createProject}
        {...extra}
      />,
    ),
  );
  return container as unknown as HTMLElement;
}

const create = (host: HTMLElement) => host.querySelector('[data-testid="rail-create-project"]') as unknown as HTMLElement | null;
const form = (host: HTMLElement) => host.querySelector("form") as unknown as HTMLElement | null;
function click(node: HTMLElement) {
  act(() => node.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

/** Type into the rail's controlled filter through React's own onChange — a bare
    `value =` assignment is invisible to a controlled input. */
function typeFilter(host: HTMLElement, value: string) {
  const input = host.querySelector("input") as unknown as HTMLInputElement;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  act(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    props.onChange({ target: input, currentTarget: input });
  });
}

test("an empty rail's create button carries its text label", () => {
  const host = renderRail();
  const button = create(host)!;
  expect(button).not.toBeNull();
  expect(button.textContent?.trim()).toBe(en["rail.createProject"]);
  /* Still the same control it always was — one click opens the form. */
  click(button);
  expect(form(host)).not.toBeNull();
});

test("a populated rail keeps the icon-only button", () => {
  const host = renderRail({ files: [fileEntry()] });
  const button = create(host)!;
  expect(button).not.toBeNull();
  expect(button.textContent?.trim()).toBe("");
  /* The label lives on for assistive tech and the tooltip either way. */
  expect(button.getAttribute("aria-label")).toBe(en["rail.createProject"]);
});

test("a rail that has not loaded, or whose catalog failed, is not treated as a first run", () => {
  const loading = renderRail({ loaded: false });
  expect(create(loading)!.textContent?.trim()).toBe("");
  unmount();

  const failed = renderRail({ catalogFailures: 3 });
  expect(create(failed)!.textContent?.trim()).toBe("");
  expect(failed.querySelector('[data-catalog-error="true"]')).not.toBeNull();
});

test("«Nothing found» answers a filter query, never an installation with no projects", () => {
  const host = renderRail();
  expect(host.textContent).not.toContain(en["common.nothingFound"]);

  typeFilter(host, "zzz");
  expect(host.textContent).toContain(en["common.nothingFound"]);
});

test("the overview's create request opens the form on the mounted rail", () => {
  const host = renderRail();
  expect(form(host)).toBeNull();
  act(() => requestProjectCreateForm());
  expect(form(host)).not.toBeNull();
});

test("a rail mounting behind the phone drawer claims the request dispatched just before it", () => {
  viewportWidth = 390;
  requestProjectCreateForm();
  const host = renderRail();
  expect(form(host)).not.toBeNull();
  /* Claimed once: a rail that mounts later still starts closed. */
  unmount();
  expect(form(renderRail())).toBeNull();
});

test("Ukrainian labels the same empty-rail button", () => {
  setLocale("uk");
  const host = renderRail();
  expect(create(host)!.textContent?.trim()).toBe(translate("uk", "rail.createProject"));
});
