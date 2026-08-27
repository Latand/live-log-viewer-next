import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { CreateProjectOutcome } from "@/hooks/useProjectCuration";
import { getLocale, setLocale, translate } from "@/lib/i18n";
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
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
});

/* The rail's footers (resources, limits) and header controls poll APIs on
   mount; both tolerate a failed response and stay in their empty states. The
   create form's directory suggestions are the one answered request — they are
   what the root picker lists (issue #1223). */
const realFetch = globalThis.fetch;
let suggestedDirs: string[] = [];
let suggestionQueries: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  if (url.startsWith("/api/projects/directories")) {
    suggestionQueries.push(new URL(url, "http://localhost").searchParams.get("q") ?? "");
    return { ok: true, status: 200, json: async () => ({ dirs: suggestedDirs }) };
  }
  return { ok: false, status: 503, json: async () => ({}) };
}) as unknown as typeof fetch;

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
  suggestedDirs = [];
  suggestionQueries = [];
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

/* Create-project shares one shape across the tests below: a rail with the
   suggestion source answering, the form open, and the picker driven the way an
   operator drives it — open the list, click a row, or type a path into the
   filter field. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const type = (input: HTMLInputElement, value: string) => {
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!
    .onChange({ target: { value } });
};
const press = (element: Element | null, key: string) =>
  flushSync(() => element?.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event));

function createForm(container: HTMLElement) {
  const query = <T extends Element>(selector: string) => container.querySelector(selector) as unknown as T | null;
  const trigger = () => query<HTMLElement>("[data-directory-trigger]")!;
  const filter = () => query<HTMLInputElement>('input[role="combobox"]');
  return {
    form: () => query<HTMLFormElement>("form")!,
    formPresent: () => query<HTMLFormElement>("form") !== null,
    nameInput: () => ([...container.querySelectorAll("form input")] as unknown as HTMLInputElement[])[0]!,
    trigger,
    filter,
    chosenRoot: () => trigger().getAttribute("data-directory-value"),
    pickerOpen: () => query<HTMLElement>('[data-directory-picker="open"]') !== null,
    optionValues: () => ([...container.querySelectorAll("[data-directory-option]")] as unknown as HTMLElement[])
      .map((option) => option.getAttribute("data-directory-option")),
    openPicker: () => flushSync(() => trigger().dispatchEvent(click())),
    pick: (dir: string) => flushSync(() =>
      (container.querySelector(`[data-directory-option="${dir}"]`) as unknown as HTMLElement).dispatchEvent(click())),
    typePath: (value: string) => {
      flushSync(() => type(filter()!, value));
      press(filter(), "Enter");
    },
    submit: () => flushSync(() =>
      query<HTMLFormElement>("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event)),
    offerButton: () => ([...container.querySelectorAll("button")] as unknown as HTMLElement[])
      .find((button) => button.textContent === "Create directory and project"),
  };
}

async function openCreateForm(
  onCreateProject: (name: string, root: string, options?: { createRoot?: boolean }) => Promise<CreateProjectOutcome>,
  onSelect: (project: string) => void = () => {},
): Promise<ReturnType<typeof createForm>> {
  const container = renderRail(onSelect, { onCreateProject });
  const open = container.querySelector(`button[aria-label="${translate(getLocale(), "rail.createProject")}"]`)!;
  flushSync(() => open.dispatchEvent(click()));
  await settle();
  return createForm(container);
}

/* Issue #1223: the root field was a bare text input demanding a typed absolute
   path. It is a picker over real directory suggestions, and choosing one names
   the project — so the usual path is pick, then confirm. */
test("create-project: the root is picked from real suggestions, and the chosen directory names the project", async () => {
  suggestedDirs = ["/data/projects/fresh-idea", "/data/projects/older-idea"];
  const creations: Array<[string, string]> = [];
  const ui = await openCreateForm(async (name, root) => {
    creations.push([name, root]);
    return { ok: true, project: "dir-0123456789abcdef0123456789abcdef" };
  });

  /* One text field remains — the name. The root is the picker. */
  expect(ui.form().querySelectorAll("input")).toHaveLength(1);
  expect(ui.trigger()).not.toBeNull();
  expect(suggestionQueries).toEqual([""]);

  ui.openPicker();
  expect(ui.optionValues()).toEqual(suggestedDirs);
  ui.pick("/data/projects/fresh-idea");
  expect(ui.chosenRoot()).toBe("/data/projects/fresh-idea");
  /* The name arrives with it, still editable. */
  expect(ui.nameInput().value).toBe("fresh-idea");

  ui.submit();
  await settle();
  expect(creations).toEqual([["fresh-idea", "/data/projects/fresh-idea"]]);
});

test("create-project: a typed name of their own survives choosing a directory", async () => {
  suggestedDirs = ["/data/projects/fresh-idea"];
  const creations: Array<[string, string]> = [];
  const ui = await openCreateForm(async (name, root) => {
    creations.push([name, root]);
    return { ok: true, project: "dir-0123456789abcdef0123456789abcdef" };
  });
  flushSync(() => type(ui.nameInput(), "Operator's own name"));
  ui.openPicker();
  ui.pick("/data/projects/fresh-idea");
  expect(ui.nameInput().value).toBe("Operator's own name");
  ui.submit();
  await settle();
  expect(creations).toEqual([["Operator's own name", "/data/projects/fresh-idea"]]);
});

test("create-project: typing a path stays possible, and points the suggestions at that directory", async () => {
  suggestedDirs = ["/data/projects/fresh-idea"];
  const ui = await openCreateForm(async () => ({ ok: true, project: "dir-0123456789abcdef0123456789abcdef" }));
  ui.openPicker();
  ui.typePath("/data/elsewhere/hand-typed");
  expect(ui.chosenRoot()).toBe("/data/elsewhere/hand-typed");
  /* Suggestions follow the directory being spelled out, and refining a name
     inside it does not ask the server again. */
  expect(suggestionQueries).toEqual(["", "/data/elsewhere/"]);
});

test("create-project: a typed path that a suggestion begins with is not swapped for it", async () => {
  /* The directory create-project is for does not exist yet, so it is routinely
     a prefix of one that does (`api` beside `api-old`). Committing the
     suggestion instead would name the project from the wrong basename and
     register it where nobody typed (issue #1223). */
  suggestedDirs = ["/data/projects/api-old"];
  const creations: Array<[string, string]> = [];
  const ui = await openCreateForm(async (name, root) => {
    creations.push([name, root]);
    return { ok: true, project: "dir-0123456789abcdef0123456789abcdef" };
  });
  ui.openPicker();
  ui.typePath("/data/projects/api");
  expect(ui.chosenRoot()).toBe("/data/projects/api");
  expect(ui.nameInput().value).toBe("api");
  ui.submit();
  await settle();
  expect(creations).toEqual([["api", "/data/projects/api"]]);
});

/* The three outcomes, told apart. First: a path that was never made absolute
   says exactly that and answers with the completion. */
async function refuseRelativeRoot(expectedMessage: string) {
  suggestedDirs = ["/data/projects/fresh-idea"];
  const creations: string[] = [];
  const ui = await openCreateForm(async (_name, root) => {
    creations.push(root);
    return { ok: false, code: "MISSING_DIRECTORY" };
  });
  ui.openPicker();
  ui.typePath("notes/relative-idea");
  expect(ui.chosenRoot()).toBe("notes/relative-idea");
  ui.submit();
  await settle();

  expect(creations).toEqual([]);
  expect(ui.form().textContent).toContain(expectedMessage);
  /* The completion is offered rather than a rejection: the list is open on the
     suggestions, one click from a real path. */
  expect(ui.pickerOpen()).toBe(true);
  expect(ui.optionValues()).toContain("/data/projects/fresh-idea");
  expect(ui.offerButton()).toBeUndefined();
}

test("create-project: a root that is not a full path says so and opens the completion", async () => {
  await refuseRelativeRoot("A full path is required");
});

test("create-project: the same refusal reads in Ukrainian", async () => {
  setLocale("uk");
  await refuseRelativeRoot("Потрібен повний шлях");
});

/* Second outcome (issue #1122, reworded by #1223): an absolute path that is
   absent is recoverable, named in the message, and offers to be created — the
   same position the pipeline preflight already takes. */
test("create-project: a missing directory names the path and offers mkdir-and-create", async () => {
  suggestedDirs = ["/data/projects/fresh-idea"];
  const selections: string[] = [];
  const creations: Array<[string, string, boolean]> = [];
  let outcome: CreateProjectOutcome = { ok: false, code: "MISSING_DIRECTORY" };
  const ui = await openCreateForm(async (name, root, options) => {
    creations.push([name, root, options?.createRoot === true]);
    return outcome;
  }, (project) => selections.push(project));
  ui.openPicker();
  ui.typePath("/data/projects/not-there-yet");
  ui.submit();
  await settle();
  expect(creations).toEqual([["not-there-yet", "/data/projects/not-there-yet", false]]);
  expect(ui.form().textContent).toContain("The directory does not exist: /data/projects/not-there-yet");
  expect(ui.offerButton()).toBeDefined();

  /* Choosing another root retracts the offer — it was made for that path. */
  ui.openPicker();
  ui.pick("/data/projects/fresh-idea");
  expect(ui.offerButton()).toBeUndefined();
  ui.submit();
  await settle();
  expect(ui.offerButton()).toBeDefined();

  /* The offered action resubmits with the mkdir opt-in; a failed mkdir reads
     back its cause and retracts the offer. */
  outcome = { ok: false, code: "MKDIR_FAILED", message: "EACCES: permission denied, mkdir '/data/projects/fresh-idea'" };
  flushSync(() => ui.offerButton()!.dispatchEvent(click()));
  await settle();
  expect(creations[creations.length - 1]).toEqual(["fresh-idea", "/data/projects/fresh-idea", true]);
  expect(ui.form().textContent).toContain("Couldn't create the directory");
  expect(ui.form().textContent).toContain("EACCES");
  expect(ui.offerButton()).toBeUndefined();
  expect(selections).toEqual([]);

  /* Success through the offer selects the project and closes the form. */
  outcome = { ok: false, code: "MISSING_DIRECTORY" };
  ui.submit();
  await settle();
  outcome = { ok: true, project: "dir-0123456789abcdef0123456789abcdef" };
  flushSync(() => ui.offerButton()!.dispatchEvent(click()));
  await settle();
  expect(selections).toEqual(["dir-0123456789abcdef0123456789abcdef"]);
  expect(ui.formPresent()).toBe(false);
});

/* Third outcome: an absolute directory that already carries a project keeps
   the duplicate message, and a success closes the form onto the new project. */
test("create-project: a duplicate keeps its own message, then a success selects the project", async () => {
  suggestedDirs = ["/data/projects/fresh-idea"];
  const selections: string[] = [];
  const creations: Array<[string, string]> = [];
  let outcome: CreateProjectOutcome = { ok: false, code: "DUPLICATE_PROJECT" };
  const ui = await openCreateForm(async (name, root) => {
    creations.push([name, root]);
    return outcome;
  }, (project) => selections.push(project));
  ui.openPicker();
  ui.pick("/data/projects/fresh-idea");
  ui.submit();
  await settle();
  expect(creations).toEqual([["fresh-idea", "/data/projects/fresh-idea"]]);
  expect(ui.form().textContent).toContain("This project already exists");
  expect(ui.form().textContent).not.toContain("Directory not found");
  expect(selections).toEqual([]);

  outcome = { ok: true, project: "dir-0123456789abcdef0123456789abcdef" };
  ui.submit();
  await settle();
  expect(selections).toEqual(["dir-0123456789abcdef0123456789abcdef"]);
});

/* A root outside the directories the viewer knows is refused in its own words
   (issue #1223) — the bound the suggestions honour is the bound creation has. */
test("create-project: a root outside the known areas is refused in its own words", async () => {
  suggestedDirs = ["/data/projects/fresh-idea"];
  const ui = await openCreateForm(async () => ({ ok: false, code: "OUTSIDE_ROOTS" }));
  ui.openPicker();
  ui.typePath("/somewhere/else/entirely");
  ui.submit();
  await settle();
  expect(ui.form().textContent).toContain("outside the known project directories");
});

/* Restore the real fetch for any later test file sharing this process. */
afterAll(() => {
  globalThis.fetch = realFetch;
});
