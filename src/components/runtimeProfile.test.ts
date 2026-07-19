import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { clampEffortToScale } from "@/lib/agent/efforts";
import type { FileEntry } from "@/lib/types";

import {
  adoptRuntimeProfile,
  defaults,
  effectiveProfile,
  readProfile,
  readResumeDraft,
  savedResumeProfile,
  sendRuntimeFrom,
  writeProfile,
  writeResumeProfile,
} from "./runtimeProfile";

const dom = new Window();
Object.assign(globalThis, { localStorage: dom.localStorage });

const file: FileEntry = {
  path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "codex",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
  proc: "running", pid: 10, conversationId: "conversation_runtime", model: "gpt-5.6-sol", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
};
const claudeFile: FileEntry = {
  ...file,
  path: "/claude.jsonl", root: "claude-projects", name: "claude.jsonl", fmt: "claude",
  engine: "claude", conversationId: "conversation_claude", model: "sonnet",
};
const key = "llvAgentRuntime:conversation_runtime";

afterEach(() => {
  localStorage.clear();
});

test("savedResumeProfile is null without saved state, so resume sends zero overrides (finding 4)", () => {
  // No saved profile — display defaults must NOT leak into the send as overrides.
  expect(savedResumeProfile(file)).toBeNull();
  // …but the picker still needs a concrete draft to display.
  expect(readResumeDraft(file).model).toBe("gpt-5.6-sol");
});

test("savedResumeProfile returns the applied profile once one is explicitly saved (finding 4)", () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  const saved = savedResumeProfile(file);
  expect(saved?.model).toBe("gpt-5.6-sol");
  expect(saved?.effort).toBe("medium");
});

test("readResumeDraft clamps an out-of-range persisted effort back to the file default", () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "not-a-real-effort", fast: false }));
  const draft = readResumeDraft(file);
  expect(draft.model).toBe("gpt-5.6-sol");
  expect(draft.effort).toBe("high"); // the file's own effort, since the stored one is invalid
});

test("writeResumeProfile materializes a concrete draft on the :resume key (auto-apply IS the save)", () => {
  const written = writeResumeProfile(file, { effort: "medium" });
  expect(written).toEqual({ model: "gpt-5.6-sol", effort: "medium", fast: false });
  expect(savedResumeProfile(file)?.effort).toBe("medium");
  // Never touches the live-runtime key.
  expect(localStorage.getItem(key)).toBeNull();
});

test("writeProfile persists only explicitly selected fields (issue #241 finding 4)", () => {
  writeProfile(file, { effort: "ultra" });
  expect(readProfile(file)).toEqual({ effort: "ultra" });
  // The send override mirrors the sparse profile — no synthesized model rides.
  expect(sendRuntimeFrom(file)).toEqual({ effort: "ultra" });
  // Nothing selected ⇒ nothing rides the send at all.
  localStorage.clear();
  expect(sendRuntimeFrom(file)).toBeUndefined();
});

test("a model switch keeps an effort the new scale supports and clamps one it doesn't (§4.3)", () => {
  writeProfile(file, { effort: "ultra" });        // sol supports ultra
  writeProfile(file, { model: "gpt-5.6-terra" }); // terra shares the six-tier scale
  expect(readProfile(file)).toEqual({ model: "gpt-5.6-terra", effort: "ultra" });
  // The clamp itself: a plain codex model tops out at xhigh, so ultra drops to
  // the nearest end of the target scale (and an in-scale tier is untouched).
  expect(clampEffortToScale("codex", "gpt-5.5", "ultra")).toBe("xhigh");
  expect(clampEffortToScale("codex", "gpt-5.5", "medium")).toBe("medium");
  expect(clampEffortToScale("codex", "gpt-5.5", "unknown-tier")).toBe("low");
  expect(clampEffortToScale("shell", null, "high")).toBeNull();
});

test("effectiveProfile resolves persisted selection over the observed runtime", () => {
  expect(effectiveProfile(file)).toEqual({ model: "gpt-5.6-sol", effort: "high", fast: false });
  writeProfile(file, { effort: "ultra", fast: true });
  expect(effectiveProfile(file)).toEqual({ model: "gpt-5.6-sol", effort: "ultra", fast: true });
});

test("fast never persists for a non-codex engine", () => {
  writeProfile(claudeFile, { effort: "max", fast: true });
  expect(readProfile(claudeFile)).toEqual({ effort: "max" });
  expect(writeResumeProfile(claudeFile, { effort: "max" }).fast).toBe(false);
});

test("adoptRuntimeProfile moves profile/resume/draft records across an identity rotation, existing records winning", () => {
  localStorage.setItem("llvAgentRuntime:prov-1:profile", JSON.stringify({ effort: "ultra" }));
  localStorage.setItem("llvAgentRuntime:prov-1:resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "low", fast: false }));
  localStorage.setItem("llvAgentRuntime:canon-1:resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  adoptRuntimeProfile("prov-1", "canon-1");
  expect(localStorage.getItem("llvAgentRuntime:canon-1:profile")).toContain("ultra");
  // A record already filed under the new identity always wins.
  expect(localStorage.getItem("llvAgentRuntime:canon-1:resume")).toContain("medium");
  expect(localStorage.getItem("llvAgentRuntime:prov-1:profile")).toBeNull();
  expect(localStorage.getItem("llvAgentRuntime:prov-1:resume")).toBeNull();
});

test("adoptRuntimeProfile carries the live reconfigure :phase so pending/confirming convergence survives id rotation (#405)", () => {
  localStorage.setItem("llvAgentRuntime:prov-2", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  localStorage.setItem("llvAgentRuntime:prov-2:phase", "confirming");
  localStorage.setItem("llvAgentRuntime:prov-2:phase:operation", "reconfigure-prov-2");
  adoptRuntimeProfile("prov-2", "canon-2");
  expect(localStorage.getItem("llvAgentRuntime:canon-2:phase")).toBe("confirming");
  expect(localStorage.getItem("llvAgentRuntime:canon-2:phase:operation")).toBe("reconfigure-prov-2");
  expect(localStorage.getItem("llvAgentRuntime:canon-2")).toContain("medium");
  expect(localStorage.getItem("llvAgentRuntime:prov-2:phase")).toBeNull();
  expect(localStorage.getItem("llvAgentRuntime:prov-2:phase:operation")).toBeNull();
  // A phase already filed under the canonical id wins — a stale provisional
  // marker never regresses an adopted conversation's convergence state.
  localStorage.setItem("llvAgentRuntime:prov-3:phase", "pending");
  localStorage.setItem("llvAgentRuntime:canon-3:phase", "confirming");
  adoptRuntimeProfile("prov-3", "canon-3");
  expect(localStorage.getItem("llvAgentRuntime:canon-3:phase")).toBe("confirming");
  expect(localStorage.getItem("llvAgentRuntime:prov-3:phase")).toBeNull();
});

test("defaults synthesize a catalog model and lowest in-scale effort for unknown observed runtimes", () => {
  const unknown: FileEntry = { ...file, model: "gpt-9-experimental", effort: "warp" };
  expect(defaults(unknown)).toEqual({ model: "gpt-5.6-sol", effort: "low", fast: false });
});
