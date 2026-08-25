import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

import { OverviewBoard } from "./OverviewBoard";
import { CREATE_PROJECT_FORM_EVENT, ProjectRail } from "./ProjectRail";

/*
 * Issue #1162, the empty rail. With no projects at all the FolderPlus button is
 * the only thing on screen that starts anything, and an icon alone never said
 * so — it carries its «Create project» label there, while a populated rail
 * keeps the compact icon. The same rail also answers the first-run overview's
 * create button by opening the form it already owns — the two are rendered
 * together here, so the pairing is proven rather than assumed.
 */

/* React needs this before `act` will drive effects — the rail subscribes to the
   overview's create request from one. */
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
});

function renderRail(extra: Partial<React.ComponentProps<typeof ProjectRail>> = {}, beside?: React.ReactNode): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  act(() =>
    root!.render(
      <>
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
        />
        {beside}
      </>,
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

test("the first-run overview's own button opens the form on the rail beside it", () => {
  /* Both surfaces, exactly as Viewer mounts them side by side on the desktop. */
  const host = renderRail({}, <OverviewBoard
    files={[]}
    projectCatalog={[]}
    pipelines={[]}
    workflows={[]}
    archivedProjects={new Set()}
    now={2_000}
    onSelectProject={() => {}}
    onSelectFile={() => {}}
  />);
  expect(form(host)).toBeNull();
  const overviewCreate = host.querySelector('[data-testid="overview-create-project"]') as unknown as HTMLElement;
  expect(overviewCreate).not.toBeNull();
  click(overviewCreate);
  expect(form(host)).not.toBeNull();
});

test("on a phone one tap on the overview's button reaches the open form", () => {
  /* Exactly how Viewer mounts these two on a phone: the rail does not exist
     until the drawer opens, so the tap has nothing to dispatch into — the rail
     it summons has to arrive with the form already open. */
  viewportWidth = 390;
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  function MobileShell() {
    const [drawerOpen, setDrawerOpen] = useState(false);
    return (
      <>
        <OverviewBoard
          files={[]}
          projectCatalog={[]}
          pipelines={[]}
          workflows={[]}
          archivedProjects={new Set()}
          now={2_000}
          onSelectProject={() => {}}
          onSelectFile={() => {}}
          onMenu={() => setDrawerOpen(true)}
        />
        {drawerOpen ? (
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
          />
        ) : null}
      </>
    );
  }
  act(() => root!.render(<MobileShell />));
  const host = container as unknown as HTMLElement;
  expect(form(host)).toBeNull();

  click(host.querySelector('[data-testid="overview-create-project"]') as unknown as HTMLElement);

  /* One tap: the drawer's rail is mounted AND its create form is on screen. */
  expect(create(host)).not.toBeNull();
  expect(form(host)).not.toBeNull();
  /* The labelled button still owns it — a second tap collapses the form. */
  click(create(host)!);
  expect(form(host)).toBeNull();
});

test("a desktop rail does not open the form until it is asked", () => {
  /* The phone's auto-open is scoped to the drawer it lives in: an always-on
     desktop rail must not expand a form nobody asked for. */
  const host = renderRail();
  expect(form(host)).toBeNull();
});

test("a rail with no create handler stays out of the request entirely", () => {
  const host = renderRail({ onCreateProject: undefined });
  act(() => {
    dom.dispatchEvent(new dom.Event(CREATE_PROJECT_FORM_EVENT));
  });
  expect(form(host)).toBeNull();
  expect(create(host)).toBeNull();
});

test("Ukrainian labels the same empty-rail button", () => {
  setLocale("uk");
  const host = renderRail();
  expect(create(host)!.textContent?.trim()).toBe(translate("uk", "rail.createProject"));
});
