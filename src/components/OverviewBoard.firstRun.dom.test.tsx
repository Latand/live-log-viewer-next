import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import type { FileEntry } from "@/lib/types";

import { OverviewBoard } from "./OverviewBoard";

/*
 * Issue #1162, the zero-project overview. A first run used to answer with one
 * dead sentence («No logs yet») and no way forward. It now names where sessions
 * come from, offers the create button the rail's form already backs, and says
 * that running an agent in any repo works too — in both locales, and without
 * inventing a second creation path.
 */

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
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
});

const { consumePendingProjectCreateForm, onProjectCreateFormRequest } = await import("@/lib/projects/openCreateForm");

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

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  dom.document.body.replaceChildren();
  setLocale("en");
  viewportWidth = 1280;
  /* Drop any latched create request so it cannot leak into the next case. */
  consumePendingProjectCreateForm();
});

function renderBoard(extra: Partial<React.ComponentProps<typeof OverviewBoard>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  flushSync(() =>
    root!.render(
      <OverviewBoard
        files={[]}
        projectCatalog={[]}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        now={2_000}
        onSelectProject={() => {}}
        onSelectFile={() => {}}
        {...extra}
      />,
    ),
  );
  return container as unknown as HTMLElement;
}

const panel = (host: HTMLElement) => host.querySelector('[data-testid="overview-first-run"]') as unknown as HTMLElement | null;
const createButton = (host: HTMLElement) => host.querySelector('[data-testid="overview-create-project"]') as unknown as HTMLElement | null;
const click = () => new dom.MouseEvent("click", { bubbles: true }) as unknown as Event;

test("zero projects: a title, where sessions come from, a labelled create button and the secondary route", () => {
  const host = renderBoard();
  const first = panel(host);
  expect(first).not.toBeNull();
  expect(first!.textContent).toContain(en["overview.firstRunTitle"]);
  expect(first!.textContent).toContain(en["overview.firstRunBody"]);
  expect(first!.textContent).toContain(en["overview.firstRunElsewhere"]);
  /* The button is labelled in text, not by an icon alone, and is a real 44px
     target on a finger. */
  const button = createButton(host)!;
  expect(button).not.toBeNull();
  expect(button.textContent).toContain(en["overview.firstRunCreate"]);
  expect(button.className).toContain("min-h-11");
  /* Both scanner roots are named, so the operator can tell whether the viewer
     is looking where their sessions actually land. */
  expect(first!.textContent).toContain("~/.claude/projects");
  expect(first!.textContent).toContain("~/.codex/sessions");
});

test("the retired «No logs yet» copy is gone from the dictionaries and the board", () => {
  const host = renderBoard();
  expect(host.textContent).not.toContain("No logs yet");
  expect(Object.keys(en)).not.toContain("overview.empty");
  expect(Object.keys(uk)).not.toContain("overview.empty");
});

test("the create button asks the rail to open the form it already owns", () => {
  const requests: number[] = [];
  const stop = onProjectCreateFormRequest(() => requests.push(1));
  const host = renderBoard();
  flushSync(() => createButton(host)!.dispatchEvent(click()));
  stop();
  expect(requests).toHaveLength(1);
  /* …and the request is also latched, so a rail that mounts a moment later
     (the phone drawer) still claims it. */
  expect(consumePendingProjectCreateForm()).toBe(true);
  expect(consumePendingProjectCreateForm()).toBe(false);
});

test("on a phone the same button opens the drawer the form lives in first", () => {
  viewportWidth = 390;
  const opened: string[] = [];
  const host = renderBoard({ onMenu: () => opened.push("drawer") });
  flushSync(() => createButton(host)!.dispatchEvent(click()));
  expect(opened).toEqual(["drawer"]);
  expect(consumePendingProjectCreateForm()).toBe(true);
});

test("a board with projects on it renders cards, never the first-run panel", () => {
  const host = renderBoard({ files: [fileEntry()] });
  expect(panel(host)).toBeNull();
  expect(createButton(host)).toBeNull();
  expect(host.querySelector('[data-testid="overview-card"]')).not.toBeNull();
});

test("an unreachable catalog keeps its failure notice instead of the first-run panel", () => {
  const host = renderBoard({ catalogFailures: 2 });
  expect(panel(host)).toBeNull();
  expect(host.querySelector('[data-catalog-error="true"]')).not.toBeNull();
});

test("Ukrainian carries the same four lines", () => {
  setLocale("uk");
  const host = renderBoard();
  const first = panel(host)!;
  expect(first.textContent).toContain(translate("uk", "overview.firstRunTitle"));
  expect(first.textContent).toContain(translate("uk", "overview.firstRunBody"));
  expect(first.textContent).toContain(translate("uk", "overview.firstRunElsewhere"));
  expect(createButton(host)!.textContent).toContain(translate("uk", "overview.firstRunCreate"));
});
