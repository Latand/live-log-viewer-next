import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

import { DirectoryPicker } from "./DirectoryPicker";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const REPO = "/home/user/Projects/live-log-viewer";
const DIRS = [
  REPO,
  `${REPO}/.worktrees/fix-887`,
  `${REPO}/.worktrees/fix-902`,
  "/home/user/Projects/other-viewer/.worktrees/fix-887",
  "/home/user/Projects/notes",
];

let root: Root | null = null;
let host: ReturnType<typeof dom.document.createElement> | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  host = null;
  dom.document.body.replaceChildren();
  setLocale("en");
});

function render(value: string, onChange: (next: string) => void = () => {}, disabled = false) {
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  flushSync(() => root!.render(
    <DirectoryPicker id="pick" value={value} dirs={DIRS} disabled={disabled} ariaLabel="Agent working directory" onChange={onChange} />,
  ));
}

const trigger = () => dom.document.querySelector("[data-directory-trigger]") as unknown as HTMLButtonElement;
const search = () => dom.document.querySelector('input[role="combobox"]') as unknown as HTMLInputElement | null;
const options = () => [...dom.document.querySelectorAll('[role="option"]')] as unknown as HTMLElement[];
const optionValues = () => options().map((option) => option.getAttribute("data-directory-option"));
const activeValue = () => options().find((option) => option.getAttribute("data-directory-active") === "true")?.getAttribute("data-directory-option") ?? null;
const click = (el: Element | null) => flushSync(() => el?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
const press = (el: Element | null, key: string) => flushSync(() => el?.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event));
const type = (value: string) => {
  const input = search()!;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value } }));
};

test("the closed trigger spells out the chosen directory and its last segment", () => {
  render(`${REPO}/.worktrees/fix-887`);
  expect(trigger().getAttribute("data-directory-value")).toBe(`${REPO}/.worktrees/fix-887`);
  expect(trigger().textContent).toContain(`${REPO}/.worktrees/fix-887`);
  expect(trigger().getAttribute("aria-label")).toBe(`Agent working directory: ${REPO}/.worktrees/fix-887`);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(search()).toBeNull();
});

test("one click lists every known directory without a character being typed", () => {
  render(REPO);
  click(trigger());
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(optionValues()).toEqual(DIRS);
  /* The current directory heads the list and is marked, so relaunching from
     the same place is the first row. */
  expect(optionValues()[0]).toBe(REPO);
  expect(options()[0].getAttribute("aria-selected")).toBe("true");
  expect(options()[0].textContent).toContain("current");
});

test("similar paths are listed whole, so their tails tell them apart", () => {
  render(REPO);
  click(trigger());
  const siblings = options().filter((option) => option.getAttribute("data-directory-option")?.endsWith("fix-887"));
  expect(siblings).toHaveLength(2);
  expect(siblings[0].textContent).toContain(`${REPO}/.worktrees/fix-887`);
  expect(siblings[1].textContent).toContain("/home/user/Projects/other-viewer/.worktrees/fix-887");
  expect(siblings[0].textContent).not.toBe(siblings[1].textContent);
});

test("a filter narrows a long list on any substring, in any order", () => {
  render(REPO);
  click(trigger());
  type("viewer 902");
  expect(optionValues()).toEqual([`${REPO}/.worktrees/fix-902`]);
  type("nothing-here");
  expect(optionValues()).toEqual([]);
  expect(dom.document.querySelector('[role="listbox"]')?.textContent).toContain("nothing matches that filter");
  /* A blank filter is not a failed search: it goes back to browsing. */
  type("   ");
  expect(optionValues()).toEqual(DIRS);
});

test("a draft with nothing to suggest yet says so instead of showing an empty list", () => {
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  flushSync(() => root!.render(
    <DirectoryPicker id="pick" value="" dirs={[]} ariaLabel="Agent working directory" onChange={() => {}} />,
  ));
  click(trigger());
  expect(options()).toHaveLength(0);
  expect(dom.document.querySelector('[role="listbox"]')?.textContent).toContain("no directories known yet");
});

test("a click on a row commits that directory and closes the picker", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  click(trigger());
  click(options().find((option) => option.getAttribute("data-directory-option") === `${REPO}/.worktrees/fix-902`)!);
  expect(picks).toEqual([`${REPO}/.worktrees/fix-902`]);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

test("the keyboard alone opens, travels and commits", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  press(trigger(), "ArrowDown");
  expect(search()).not.toBeNull();
  expect(activeValue()).toBe(REPO);
  press(search(), "ArrowDown");
  press(search(), "ArrowDown");
  expect(activeValue()).toBe(`${REPO}/.worktrees/fix-902`);
  expect(search()?.getAttribute("aria-activedescendant")).toBe("pick-option-2");
  press(search(), "Home");
  expect(activeValue()).toBe(REPO);
  press(search(), "End");
  expect(activeValue()).toBe(DIRS[DIRS.length - 1]);
  press(search(), "Enter");
  expect(picks).toEqual([DIRS[DIRS.length - 1]]);
  expect(dom.document.activeElement === (trigger() as unknown as typeof dom.document.activeElement)).toBe(true);
});

test("Escape closes the picker and leaves the directory as it was", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  click(trigger());
  press(search(), "ArrowDown");
  press(search(), "Escape");
  expect(picks).toEqual([]);
  expect(trigger().getAttribute("data-directory-value")).toBe(REPO);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

test("a path that is not in the list is committed exactly as typed", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  click(trigger());
  type("/mnt/scratch/one-off checkout");
  const typed = options().at(-1)!;
  expect(typed.getAttribute("data-directory-option")).toBe("/mnt/scratch/one-off checkout");
  expect(typed.textContent).toContain("use this path");
  press(search(), "Enter");
  expect(picks).toEqual(["/mnt/scratch/one-off checkout"]);
});

/* Issue #1223: every path is a substring of its own longer siblings, so the
   typed row has to lead — otherwise Enter answers a spelled-out path with a
   lookalike, and create-project registers a project where nobody named. */
test("a typed path that is a prefix of a known one still commits what was typed", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  click(trigger());
  type(`${REPO}/.worktrees/fix-88`);
  /* Both rows are offered — the known sibling is one arrow key away — but the
     path being spelled out is the one under the highlight. */
  expect(optionValues()).toEqual([`${REPO}/.worktrees/fix-88`, `${REPO}/.worktrees/fix-887`]);
  expect(activeValue()).toBe(`${REPO}/.worktrees/fix-88`);
  press(search(), "ArrowDown");
  expect(activeValue()).toBe(`${REPO}/.worktrees/fix-887`);
  press(search(), "ArrowUp");
  press(search(), "Enter");
  expect(picks).toEqual([`${REPO}/.worktrees/fix-88`]);
});

test("Tab commits the highlighted row instead of dropping what was typed", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  click(trigger());
  type("/mnt/scratch/tabbed");
  press(search(), "Tab");
  expect(picks).toEqual(["/mnt/scratch/tabbed"]);
});

test("a filter word that matched nothing is never committed as a directory", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));
  click(trigger());
  /* A bare word is a failed filter, not a path. Committing it would hand the
     spawn route a relative name it resolves against its own directory — and
     `src` names a real one there — so Enter must close, not launch elsewhere. */
  type("src");
  expect(optionValues()).toEqual([]);
  press(search(), "Enter");
  expect(picks).toEqual([]);
  expect(trigger().getAttribute("data-directory-value")).toBe(REPO);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");

  /* Tab is the natural way to leave a failed filter, and must not commit it
     either — the escape hatch stays "type a path", as the no-match row says. */
  click(trigger());
  type("bogusword");
  press(search(), "Tab");
  expect(picks).toEqual([]);
  expect(trigger().getAttribute("data-directory-value")).toBe(REPO);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");

  /* A fragment with a slash in it is a filter too (issue #1223). Counting a
     slash as a path shape offered it as a row and led the highlight with it, so
     Enter committed a name only the server's own working directory could
     resolve — and create-project sent it on to be refused. */
  click(trigger());
  type(".worktrees/fix");
  expect(optionValues()).not.toContain(".worktrees/fix");
  expect(optionValues()).toContain(`${REPO}/.worktrees/fix-887`);
  type("scanner/nothing-here");
  expect(optionValues()).toEqual([]);
  press(search(), "Enter");
  expect(picks).toEqual([]);
  expect(trigger().getAttribute("data-directory-value")).toBe(REPO);
});

/* Issue #1223: the filter field is where a path gets spelled out, and for
   create-project it is the only place the root can be typed at all. Leaving the
   popup to reach a control it covers must not throw that path away. */
test("a path typed into the filter survives leaving the popup; a filter word and Escape do not commit", () => {
  const picks: string[] = [];
  render(REPO, (next) => picks.push(next));

  /* Closing with the trigger — the way to reach whatever the popup covers. */
  click(trigger());
  type("/mnt/scratch/dismissed");
  click(trigger());
  expect(picks).toEqual(["/mnt/scratch/dismissed"]);
  expect(search()).toBeNull();

  /* Pressing outside the control commits it too. */
  click(trigger());
  type("/mnt/scratch/pressed-away");
  flushSync(() => dom.document.body.dispatchEvent(new dom.Event("pointerdown", { bubbles: true })));
  expect(picks).toEqual(["/mnt/scratch/dismissed", "/mnt/scratch/pressed-away"]);
  expect(search()).toBeNull();

  /* A bare word is a failed filter, not a directory, so leaving on one still
     commits nothing — the same line Enter and Tab already hold. */
  click(trigger());
  type("nothing-here");
  click(trigger());
  expect(picks).toEqual(["/mnt/scratch/dismissed", "/mnt/scratch/pressed-away"]);

  /* Escape reverts even a path: that is what Escape is for. */
  click(trigger());
  type("/mnt/scratch/escaped");
  press(search(), "Escape");
  expect(picks).toEqual(["/mnt/scratch/dismissed", "/mnt/scratch/pressed-away"]);
});

test("a launch freezes the control and cannot leave a popup open over it", () => {
  render(REPO);
  click(trigger());
  expect(search()).not.toBeNull();
  flushSync(() => root!.render(
    <DirectoryPicker id="pick" value={REPO} dirs={DIRS} disabled ariaLabel="Agent working directory" onChange={() => {}} />,
  ));
  expect(search()).toBeNull();
  expect(trigger().disabled).toBe(true);
});

test("an empty directory reads as empty rather than as a blank control", () => {
  render("");
  expect(trigger().textContent).toContain("no directory chosen");
  expect(trigger().getAttribute("aria-label")).toBe("Agent working directory: no directory chosen");
  setLocale("uk");
  flushSync(() => root!.render(
    <DirectoryPicker id="pick" value="" dirs={DIRS} ariaLabel="Робоча директорія агента" onChange={() => {}} />,
  ));
  expect(trigger().textContent).toContain("директорію не вибрано");
});

/* Issue #1223: create-project's suggestions come from the filesystem, so the
   caller has to hear where the operator is pointing and be able to open the
   list itself when it refuses what was typed. */
test("the filter text is reported as it changes, so a caller can widen the list", () => {
  const queries: Array<[string, boolean]> = [];
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  flushSync(() => root!.render(
    <DirectoryPicker
      id="pick"
      value={REPO}
      dirs={DIRS}
      ariaLabel="Root directory"
      onQueryChange={(query, typed) => queries.push([query, typed])}
      onChange={() => {}}
    />,
  ));
  click(trigger());
  /* Opening reports the current value, marked as not typed: a caller reading
     the two alike would answer "open the list" with the one path already
     chosen instead of listing what is around it. */
  expect(queries).toEqual([[REPO, false]]);
  type("/home/user/Projects/n");
  expect(queries).toEqual([[REPO, false], ["/home/user/Projects/n", true]]);
});

test("an open signal from the caller opens the list on the value already held", () => {
  const renderWith = (openSignal: number, disabled = false) => flushSync(() => root!.render(
    <DirectoryPicker
      id="pick"
      value={REPO}
      dirs={DIRS}
      disabled={disabled}
      ariaLabel="Root directory"
      openSignal={openSignal}
      onChange={() => {}}
    />,
  ));
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  renderWith(0);
  expect(search()).toBeNull();

  renderWith(1);
  expect(search()).not.toBeNull();
  expect(optionValues()).toEqual(DIRS);

  /* A signal that has not moved leaves an operator-closed popup closed. */
  press(search(), "Escape");
  renderWith(1);
  expect(search()).toBeNull();

  /* A frozen control still refuses to open. */
  renderWith(2, true);
  expect(search()).toBeNull();
});
