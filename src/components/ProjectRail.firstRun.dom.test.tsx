import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { MOBILE_LAYOUT_QUERY, mobileLayoutViewport } from "@/lib/attention/eligibility";

import { getMobileNav } from "./mobile/mobileNav";
import { MobileProjectSheet } from "./mobile/MobileProjectSheet";
import type { MobileShellHost } from "./mobile/MobileShell";
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
  matches: query === MOBILE_LAYOUT_QUERY && mobileLayoutViewport({ width: viewportWidth, height: 844 }),
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

/* A rail row arriving into the list is flipped in; happy-dom has no Web
   Animations, and `useFlip` subscribes to the returned animation. */
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(),
  cancel() {},
  finish() {},
  addEventListener() {},
  removeEventListener() {},
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

/* The phone shell reads the runtime bus for its banner slot; keep it inert. */
setRuntimeUiEnabledForTests(false);
afterAll(() => setRuntimeUiEnabledForTests(null));

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

function railTree(extra: Partial<React.ComponentProps<typeof ProjectRail>>, beside?: React.ReactNode) {
  return (
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
    </>
  );
}

function renderRail(extra: Partial<React.ComponentProps<typeof ProjectRail>> = {}, beside?: React.ReactNode): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  act(() => root!.render(railTree(extra, beside)));
  return container as unknown as HTMLElement;
}

/** New props onto the SAME mounted rail — the catalog answering under it, not a
    remount, which is the whole difference the mount-time read could not see. */
function rerenderRail(extra: Partial<React.ComponentProps<typeof ProjectRail>> = {}, beside?: React.ReactNode) {
  act(() => root!.render(railTree(extra, beside)));
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
  /* Exactly how Viewer mounts these on a phone (mobile v2 lane 1): the rail
     is gone; the overview's shell opens the project switcher sheet the Viewer
     renders, and that sheet arrives with its create form already open on a
     first run. */
  viewportWidth = 390;
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  const host: MobileShellHost = {
    attentionCount: 0,
    arrival: null,
    renderSheet: (name, close) => name === "projects" ? (
      <MobileProjectSheet
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
        onClose={close}
      />
    ) : null,
  };
  act(() => root!.render(
    <OverviewBoard
      files={[]}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      now={2_000}
      onSelectProject={() => {}}
      onSelectFile={() => {}}
      mobileShell={host}
    />,
  ));
  const page = container as unknown as HTMLElement;
  expect(page.querySelector("[data-mobile2-project-form]")).toBeNull();

  click(page.querySelector('[data-testid="overview-create-project"]') as unknown as HTMLElement);

  /* One tap: the sheet is open AND its create form is on screen. */
  expect(page.querySelector('[data-mobile2-sheet="projects"]')).not.toBeNull();
  expect(page.querySelector("[data-mobile2-project-form]")).not.toBeNull();
  /* The labelled row still owns it — a second tap collapses the form. */
  click(page.querySelector('[data-mobile2-project-create="open"]') as unknown as HTMLElement);
  expect(page.querySelector("[data-mobile2-project-form]")).toBeNull();
  act(() => getMobileNav().home());
});

test("a desktop rail does not open the form until it is asked", () => {
  /* The phone's auto-open is scoped to the drawer it lives in: an always-on
     desktop rail must not expand a form nobody asked for — not at mount, and
     not when the catalog answers under it either. */
  const host = renderRail({ loaded: false });
  expect(form(host)).toBeNull();

  rerenderRail({ loaded: true });
  expect(form(host)).toBeNull();
});

test("a phone rail summoned before the catalog answers still opens the form itself", () => {
  /* The tap that opens the drawer can land while the catalog is still in
     flight, so the rail mounts knowing nothing yet — «no projects» is not true
     of it yet, and it was never going to be told again. It follows the
     transition instead: the first run arriving under an already-mounted rail
     opens the same form one tap bought on a loaded one (issue #1162). */
  viewportWidth = 390;
  const host = renderRail({ loaded: false });
  expect(form(host)).toBeNull();

  rerenderRail({ loaded: true });
  expect(form(host)).not.toBeNull();

  /* And the operator still owns it from there: collapsing the form must survive
     every later render of a rail that is still in the same first run. */
  click(create(host)!);
  expect(form(host)).toBeNull();
  rerenderRail({ loaded: true, now: 3_000 });
  expect(form(host)).toBeNull();
});

test("a phone rail whose catalog answers with projects opens no form", () => {
  /* The transition that opens the form is the first run specifically, not the
     catalog merely answering. */
  viewportWidth = 390;
  const host = renderRail({ loaded: false });

  rerenderRail({ loaded: true, files: [fileEntry()] });
  expect(create(host)).not.toBeNull();
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
