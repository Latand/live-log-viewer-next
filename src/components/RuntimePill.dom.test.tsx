import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSettingsCapability } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
let mobile = false;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const codexFile: FileEntry = {
  path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "codex",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
  proc: "running", pid: 10, conversationId: "conversation_runtime", model: "gpt-5.6-sol", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
};
const claudeFile: FileEntry = {
  ...codexFile,
  path: "/claude.jsonl", root: "claude-projects", name: "claude.jsonl", fmt: "claude",
  engine: "claude", conversationId: "conversation_claude", model: "sonnet", effort: "high",
};
const key = "llvAgentRuntime:conversation_runtime";

const CODEX_STRUCTURED: RuntimeSettingsCapability = { perTurnEffort: true, perTurnModel: false };
const CLAUDE_STRUCTURED: RuntimeSettingsCapability = { perTurnEffort: false, perTurnModel: false };

async function renderPill(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

const keydown = async (el: Element, key: string) => {
  await act(async () => {
    el.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

afterEach(() => {
  mobile = false;
  document.body.replaceChildren();
  localStorage.clear();
});

test("the pill face reads shortLabel · tier and opens a menu with the active tier checked", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  expect(pill.textContent).toContain("5.6-Sol · High");
  expect(pill.getAttribute("aria-haspopup")).toBe("menu");
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  expect(pill.getAttribute("aria-label")).toContain("Model and reasoning — applies to your next message");
  expect(pill.getAttribute("aria-label")).toContain("GPT-5.6-Sol");

  await click(pill);
  expect(pill.getAttribute("aria-expanded")).toBe("true");
  const menu = host.querySelector('[role="menu"][data-runtime-popover]')!;
  const tiers = [...menu.querySelectorAll('[data-runtime-row="tier"]')];
  // The sol scale: all six tiers, lowest first, standalone display names.
  expect(tiers.map((row) => row.textContent)).toEqual(["Light", "Medium", "High", "Extra High", "Max", "Ultra"]);
  const checked = tiers.filter((row) => row.getAttribute("aria-checked") === "true");
  expect(checked).toHaveLength(1);
  expect(checked[0]!.textContent).toBe("High");
  // No Apply button and no Full-access-shaped row anywhere (§13 anti-goals).
  expect(menu.textContent).not.toContain("Apply");
  expect(menu.textContent!.toLowerCase()).not.toContain("access");
  await act(async () => root.unmount());
});

test("selecting a tier persists the sparse profile, announces, and closes (auto-apply — no Apply step)", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  await click(pill);
  const ultra = [...host.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Ultra")!;
  await click(ultra);
  // Only the explicitly selected field persists (finding 4).
  expect(JSON.parse(localStorage.getItem(key + ":profile")!)).toEqual({ effort: "ultra" });
  // Desktop popover closes on selection; the face re-reads the profile.
  expect(host.querySelector("[data-runtime-popover]")).toBeNull();
  expect(pill.textContent).toContain("5.6-Sol · Ultra");
  const status = host.querySelector("[data-runtime-pill-status]")!;
  expect(status.textContent).toBe("Next message: GPT-5.6-Sol · Ultra");
  await act(async () => root.unmount());
});

test("the model drill-down swaps panels in place with a back row; codex per-turn model rows are honestly disabled", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  const submenu = [...host.querySelectorAll('[data-runtime-row="submenu"]')];
  expect(submenu.map((row) => row.getAttribute("data-runtime-value"))).toEqual(["model", "speed"]);
  await click(submenu[0]!);
  // One anchored surface — the root panel is gone, the model panel is in place.
  const modelRows = [...host.querySelectorAll('[data-runtime-row="model"]')];
  expect(modelRows.map((row) => row.textContent)).toEqual(["GPT-5.6-Sol", "GPT-5.6-Terra"]);
  expect(modelRows[0]!.getAttribute("aria-checked")).toBe("true");
  // perTurnModel is false: disabled with the reason in the accessible name.
  expect(modelRows[1]!.hasAttribute("disabled")).toBe(true);
  expect(modelRows[1]!.getAttribute("aria-label")).toContain("applies when the conversation is next resumed");
  // The back row returns to the root panel.
  await click(host.querySelector('[data-runtime-row="back"]')!);
  expect(host.querySelectorAll('[data-runtime-row="tier"]').length).toBe(6);
  await act(async () => root.unmount());
});

test("speed rows exist only for codex and lock on the structured surface (service tier is thread-level)", async () => {
  const codex = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(codex.host.querySelector("[data-runtime-pill]")!);
  const speed = [...codex.host.querySelectorAll('[data-runtime-row="submenu"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "speed")!;
  await click(speed);
  const speedRows = [...codex.host.querySelectorAll('[data-runtime-row="speed"]')];
  expect(speedRows.map((row) => row.textContent)).toEqual(["Standard", "Fast — priority tier"]);
  expect(speedRows.every((row) => row.hasAttribute("disabled"))).toBe(true);
  await act(async () => codex.root.unmount());

  // Claude has no speed concept anywhere in the popover.
  const claude = await renderPill(
    <RuntimePill file={claudeFile} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await click(claude.host.querySelector("[data-runtime-pill]")!);
  const values = [...claude.host.querySelectorAll('[data-runtime-row="submenu"]')]
    .map((row) => row.getAttribute("data-runtime-value"));
  expect(values).toEqual(["model"]);
  await act(async () => claude.root.unmount());
});

test("a claude-broker structured conversation disables the reasoning rows with the next-resume reason (phase 1)", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={claudeFile} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  const tiers = [...host.querySelectorAll('[data-runtime-row="tier"]')];
  expect(tiers).toHaveLength(5); // claude scale: low…max
  expect(tiers.every((row) => row.hasAttribute("disabled"))).toBe(true);
  expect(tiers[0]!.getAttribute("title")).toBe("applies when the conversation is next resumed");
  // A disabled row never commits.
  await click(tiers[0]!);
  expect(localStorage.getItem("llvAgentRuntime:conversation_claude:profile")).toBeNull();
  await act(async () => root.unmount());
});

test("on the resume surface a selection saves the concrete :resume profile — auto-apply is the save", async () => {
  const { host, root } = await renderPill(<RuntimePill file={codexFile} surface="resume" />);
  await click(host.querySelector("[data-runtime-pill]")!);
  const medium = [...host.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Medium")!;
  expect(medium.hasAttribute("disabled")).toBe(false);
  await click(medium);
  expect(JSON.parse(localStorage.getItem(key + ":resume")!)).toEqual({ model: "gpt-5.6-sol", effort: "medium", fast: false });
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => root.unmount());
});

test("Escape closes the popover and returns focus to the pill", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  await click(pill);
  const menu = host.querySelector("[data-runtime-popover]")!;
  await keydown(menu, "Escape");
  expect(host.querySelector("[data-runtime-popover]")).toBeNull();
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(pill);
  await act(async () => root.unmount());
});

test("at 390px the pill opens a modal sheet with 44px radio rows that stays open across selections", async () => {
  mobile = true;
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  const sheet = host.querySelector('[role="dialog"][data-runtime-sheet]')!;
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(sheet.getAttribute("aria-label")).toBe("Model and reasoning — applies to your next message");
  const sections = [...sheet.querySelectorAll('[role="radiogroup"]')];
  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Reasoning", "Model", "Speed"]);
  const rows = [...sheet.querySelectorAll("[data-runtime-sheet-row]")];
  expect(rows.every((row) => row.className.includes("min-h-11"))).toBe(true);
  // Selecting a tier commits but keeps the sheet open (model + reasoning in one visit).
  const ultra = rows.find((row) => row.textContent === "Ultra")!;
  await click(ultra);
  expect(JSON.parse(localStorage.getItem(key + ":profile")!)).toEqual({ effort: "ultra" });
  expect(host.querySelector("[data-runtime-sheet]")).not.toBeNull();
  await act(async () => root.unmount());
});

test("no pill renders for engines without a runtime dial or on surfaces outside the matrix", async () => {
  const shell: FileEntry = { ...codexFile, engine: "shell" };
  const first = await renderPill(<RuntimePill file={shell} surface="structured" />);
  expect(first.host.querySelector("[data-runtime-pill]")).toBeNull();
  await act(async () => first.root.unmount());
  const second = await renderPill(<RuntimePill file={codexFile} surface="live-subagent" />);
  expect(second.host.querySelector("[data-runtime-pill]")).toBeNull();
  await act(async () => second.root.unmount());
});
