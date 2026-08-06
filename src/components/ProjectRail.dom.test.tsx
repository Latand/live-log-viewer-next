import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { ProjectRail } from "./ProjectRail";

/* Presentation names on the rail (issue #345): the leading-dash canonical key
   `-agents-tools-live-log-viewer-next` must render as `live-log-viewer-next`
   while selection and filtering keep operating on the canonical key. Covered
   on the desktop rail and the 390px drawer, in English and Ukrainian. */

const dom = new Window({ url: "http://localhost/" });

/* The rail's breakpoint is `(max-width: 767px)` through useIsMobile; useFlip
   reads the bare `matchMedia` global for reduced-motion. One switchable stub
   serves both. */
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

/* The rail's footers (resources, limits) and header controls poll APIs on
   mount; both tolerate a failed response and stay in their empty states. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "-agents-tools-live-log-viewer-next",
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
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

/* One project key reached from a live worktree checkout and from a deleted
   one: the scanner resolves both cwds to the parent repo, so the rail sees a
   single canonical key. A second, plain-named project rides along. */
const files: FileEntry[] = [
  fileEntry({ path: "/sessions/live-worktree.jsonl", cwd: "/home/user/.agents/tools/live-log-viewer-next/.worktrees/wt-a" }),
  fileEntry({ path: "/sessions/deleted-worktree.jsonl", cwd: "/home/user/.agents/tools/live-log-viewer-next/.worktrees/wt-gone" }),
  fileEntry({ path: "/sessions/plain.jsonl", project: "CelestiaCompose" }),
];

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  dom.document.body.replaceChildren();
  setLocale("en");
  viewportWidth = 1280;
});

function renderRail(
  onSelect: (project: string) => void = () => {},
  extra: Partial<React.ComponentProps<typeof ProjectRail>> = {},
): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  flushSync(() =>
    root!.render(
      <ProjectRail
        files={files}
        projectCatalog={[]}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        selected="-agents-tools-live-log-viewer-next"
        loaded
        now={2_000}
        onSelect={onSelect}
        {...extra}
      />,
    ),
  );
  return container as unknown as HTMLElement;
}

function railRows(container: HTMLElement): HTMLElement[] {
  /* Project rows only: the crown toggles are icon-only buttons in the same
     nav, so anything without visible text is a control, not a row. */
  return ([...container.querySelectorAll("nav button")] as HTMLElement[])
    .filter((button) => Boolean(button.textContent?.trim()));
}

const click = () => new dom.MouseEvent("click", { bubbles: true }) as unknown as Event;

test("desktop rail shows the display name, never the leading-dash key, and selects by canonical key", () => {
  const selections: string[] = [];
  const container = renderRail((project) => selections.push(project));
  const rows = railRows(container);
  const viewerRow = rows.find((row) => row.textContent?.includes("live-log-viewer-next"));
  expect(viewerRow).toBeDefined();
  expect(viewerRow!.textContent).not.toContain("-agents-tools-live-log-viewer-next");
  /* The two worktree-derived sessions (one live, one deleted checkout) group
     into this single row — no lookalike neighbor exists. */
  expect(rows.filter((row) => row.textContent?.includes("live-log-viewer-next"))).toHaveLength(1);
  expect(rows.find((row) => row.textContent?.includes("CelestiaCompose"))).toBeDefined();

  viewerRow!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(selections).toEqual(["-agents-tools-live-log-viewer-next"]);
});

test("the filter input is present; its matching predicate is covered in displayNames.test.ts", () => {
  const container = renderRail();
  expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Filter projects…");
});

test("390px drawer in Ukrainian keeps the display name and the localized landmarks", () => {
  viewportWidth = 390;
  setLocale("uk");
  const container = renderRail();
  const nav = container.querySelector("nav");
  expect(nav?.getAttribute("aria-label")).toBe("Проєкти");
  expect(container.textContent).toContain("Логи агентів");
  const rows = railRows(container);
  const viewerRow = rows.find((row) => row.textContent?.includes("live-log-viewer-next"));
  expect(viewerRow).toBeDefined();
  expect(viewerRow!.textContent).not.toContain("-agents-tools-live-log-viewer-next");
  /* Touch target: mobile rows carry the 44px min-height class. */
  expect(viewerRow!.className).toContain("min-h-11");
});

test("390px drawer in English mirrors the Ukrainian structure", () => {
  viewportWidth = 390;
  const container = renderRail();
  expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Projects");
  const viewerRow = railRows(container).find((row) => row.textContent?.includes("live-log-viewer-next"));
  expect(viewerRow).toBeDefined();
  expect(viewerRow!.className).toContain("min-h-11");
});

/* Crown + pin (operator request): a crowned project floats into the pinned top
   section with a lit crown marker; the per-row toggle crowns and uncrowns. */
test("crowned projects pin to the top section with a crown marker and a working toggle", () => {
  const toggles: Array<[string, boolean]> = [];
  const container = renderRail(() => {}, {
    crownedProjects: new Set(["CelestiaCompose"]),
    onToggleCrown: (project, crowned) => toggles.push([project, crowned]),
  });
  const rows = railRows(container);
  const labels = rows.map((row) => row.textContent ?? "");
  const pinnedIndex = labels.findIndex((label) => label.includes("CelestiaCompose"));
  const regularIndex = labels.findIndex((label) => label.includes("live-log-viewer-next"));
  /* Uncrowned, CelestiaCompose sorts after the viewer project (same recency
     bucket, lexicographic tie-break); the crown must float it above. */
  expect(pinnedIndex).toBeGreaterThan(-1);
  expect(pinnedIndex).toBeLessThan(regularIndex);
  expect(rows[pinnedIndex]!.querySelector('[data-testid="crown-marker"]')).not.toBeNull();
  expect(rows[regularIndex]!.querySelector('[data-testid="crown-marker"]')).toBeNull();

  const uncrown = container.querySelector('button[aria-label="Remove crown"]');
  const crown = container.querySelector('button[aria-label="Crown — pin to top"]');
  expect(uncrown).not.toBeNull();
  expect(crown).not.toBeNull();
  flushSync(() => uncrown!.dispatchEvent(click()));
  flushSync(() => crown!.dispatchEvent(click()));
  expect(toggles).toEqual([
    ["CelestiaCompose", false],
    ["-agents-tools-live-log-viewer-next", true],
  ]);
});

test("create-project flow: submit, duplicate refusal message, then success selects the project", async () => {
  const selections: string[] = [];
  const creations: Array<[string, string]> = [];
  let outcome: CreateProjectOutcome = { ok: false, code: "DUPLICATE_PROJECT" };
  const container = renderRail((project) => selections.push(project), {
    onCreateProject: async (name, root) => {
      creations.push([name, root]);
      return outcome;
    },
  });
  const open = container.querySelector('button[aria-label="Create project"]');
  expect(open).not.toBeNull();
  flushSync(() => open!.dispatchEvent(click()));
  const form = container.querySelector("form")!;
  const inputs = [...form.querySelectorAll("input")] as HTMLInputElement[];
  expect(inputs).toHaveLength(2);
  const type = (input: HTMLInputElement, value: string) => {
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!
      .onChange({ target: { value } });
  };
  flushSync(() => {
    type(inputs[0]!, "Fresh Project");
    type(inputs[1]!, "/data/projects/fresh");
  });
  const submit = () =>
    form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);

  flushSync(submit);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(creations).toEqual([["Fresh Project", "/data/projects/fresh"]]);
  expect(container.textContent).toContain("This project already exists");
  expect(selections).toEqual([]);

  outcome = { ok: true, project: "dir-0123456789abcdef0123456789abcdef" };
  flushSync(submit);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(selections).toEqual(["dir-0123456789abcdef0123456789abcdef"]);
  /* Success closes the form; only the filter input remains. */
  expect(container.querySelector("form")).toBeNull();
});

/* Restore the real fetch for any later test file sharing this process. */
afterAll(() => {
  globalThis.fetch = realFetch;
});
