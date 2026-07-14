import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";

import { attachModeFor, capabilitiesFor, stripHasVisibleControls, surfaceFor, type ControlName, type StripSurface } from "./agentCapabilities";

/**
 * Every cell of the design §4 capability matrix, asserted against the pure
 * `capabilitiesFor` / `surfaceFor` functions. A control that can *never* apply
 * to a surface is `hidden`; one temporarily unavailable is `disabled` with a
 * reason key.
 */

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/claude.jsonl", root: "claude-projects", name: "c.jsonl", project: "viewer", title: "c",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity: "idle", proc: null, pid: null, model: "sonnet", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
    ...overrides,
  } as FileEntry;
}

/** Minimal runtime view — `capabilitiesFor` reads only `legacy` + host fields. */
function rv(hostKind: HostKind, host: HostAxis, legacy = false): RuntimeSessionView {
  return {
    session: { hostKind, host } as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"],
    attentions: [],
    receipts: [],
    legacy,
  };
}

const state = (name: ControlName, f: FileEntry, view: RuntimeSessionView | null) => capabilitiesFor(f, view).controls[name].state;
const reason = (name: ControlName, f: FileEntry, view: RuntimeSessionView | null) => {
  const cap = capabilitiesFor(f, view).controls[name];
  return cap.state === "disabled" ? cap.reason : null;
};
const note = (name: ControlName, f: FileEntry, view: RuntimeSessionView | null) => {
  const cap = capabilitiesFor(f, view).controls[name];
  return cap.state === "enabled" ? cap.note ?? null : null;
};

/* ------------------------------ surface classification ------------------------------ */

test("surfaceFor prioritizes shell, then dead, then structured, then running", () => {
  expect(surfaceFor(file({ engine: "shell", proc: "running" }), rv("codex-app-server", "hosted"))).toBe<StripSurface>("shell");
  // dead wins over structured even when the host kind is structured
  expect(surfaceFor(file({ proc: "running" }), rv("claude-broker", "dead"))).toBe<StripSurface>("dead");
  expect(surfaceFor(file({ proc: "running" }), rv("codex-app-server", "hosted"))).toBe<StripSurface>("structured");
  expect(surfaceFor(file({ proc: "running", parent: null }), null)).toBe<StripSurface>("live-root");
  expect(surfaceFor(file({ proc: "running", parent: "/root.jsonl" }), null)).toBe<StripSurface>("live-subagent");
  expect(surfaceFor(file({ proc: "running", kind: "subagent" }), null)).toBe<StripSurface>("live-subagent");
  expect(surfaceFor(file({ proc: null }), null)).toBe<StripSurface>("resume");
  expect(surfaceFor(file({ proc: null, kind: "subagent" }), null)).toBe<StripSurface>("inert");
});

test("an unhosted axis is treated as dead recovery", () => {
  expect(surfaceFor(file({ proc: "running" }), rv("claude-broker", "unhosted"))).toBe<StripSurface>("dead");
});

test("a tmux-legacy session never counts as a structured host", () => {
  expect(surfaceFor(file({ proc: "running" }), rv("tmux-legacy", "hosted", true))).toBe<StripSurface>("live-root");
});

/* ------------------------------ §4 matrix rows ------------------------------ */

test("live-root: every control enabled", () => {
  const f = file({ proc: "running" });
  for (const c of ["stop", "compact", "runtime", "kill", "terminal", "images", "send"] as ControlName[]) {
    expect(state(c, f, null)).toBe("enabled");
  }
});

test("live-subagent: stop enabled (root-interrupt note), compact disabled, runtime hidden, kill enabled", () => {
  const f = file({ proc: "running", parent: "/root.jsonl" });
  // Stop is a real capability on a subagent — ESC lands in the root pane.
  expect(state("stop", f, null)).toBe("enabled");
  expect(note("stop", f, null)).toBe("strip.stopSubagent");
  expect(reason("compact", f, null)).toBe("strip.compactSubagent");
  expect(state("runtime", f, null)).toBe("hidden");
  expect(state("kill", f, null)).toBe("enabled");
  expect(state("terminal", f, null)).toBe("enabled");
  expect(state("images", f, null)).toBe("enabled");
});

test("structured: stop+terminal enabled, compact/runtime/kill await #240, images await #239", () => {
  const f = file({ proc: "running" });
  const view = rv("codex-app-server", "hosted");
  expect(state("stop", f, view)).toBe("enabled");
  expect(state("terminal", f, view)).toBe("enabled");
  expect(reason("compact", f, view)).toBe("strip.awaits240");
  expect(reason("runtime", f, view)).toBe("strip.awaits240");
  expect(reason("kill", f, view)).toBe("strip.awaits240");
  expect(reason("images", f, view)).toBe("strip.imagesStructured");
  expect(state("send", f, view)).toBe("enabled");
});

test("resume: runtime picks the on-resume profile, stop/compact/kill hidden", () => {
  const f = file({ proc: null });
  expect(state("stop", f, null)).toBe("hidden");
  expect(state("compact", f, null)).toBe("hidden");
  expect(state("runtime", f, null)).toBe("enabled");
  expect(state("kill", f, null)).toBe("hidden");
  expect(state("terminal", f, null)).toBe("enabled");
  expect(state("images", f, null)).toBe("enabled");
  expect(state("send", f, null)).toBe("enabled");
});

test("dead: only terminal (the escape hatch) survives; send is disabled, not attempted", () => {
  const f = file({ proc: "running" });
  const view = rv("claude-broker", "dead");
  expect(state("terminal", f, view)).toBe("enabled");
  expect(reason("send", f, view)).toBe("deadHost.sendBlocked");
  for (const c of ["stop", "compact", "runtime", "kill", "images"] as ControlName[]) {
    expect(state(c, f, view)).toBe("hidden");
  }
});

test("shell: only Kill applies", () => {
  const f = file({ engine: "shell", proc: "running", root: "shell-tasks" as FileEntry["root"] });
  expect(state("kill", f, null)).toBe("enabled");
  for (const c of ["stop", "compact", "runtime", "terminal", "images", "send"] as ControlName[]) {
    expect(state(c, f, null)).toBe("hidden");
  }
});

test("inert: a finished non-resumable subagent still offers a terminal iff resumable", () => {
  const subagent = file({ proc: null, kind: "subagent" });
  expect(state("terminal", subagent, null)).toBe("hidden");
  // a finished codex session is resumable → the terminal command is still composable
  const resumable = file({ proc: null, engine: "codex", root: "codex-sessions", kind: "session" });
  expect(surfaceFor(resumable, null)).toBe<StripSurface>("resume");
});

/* ------------------------------ attach mode (§6, finding 3) ------------------------------ */

test("attachModeFor picks live tmux attach for running panes and resume for everything else", () => {
  // a live tmux root/subagent attaches to the running pane (root pane for a child)
  expect(attachModeFor(file({ proc: "running" }), null)).toBe("live");
  expect(attachModeFor(file({ proc: "running", parent: "/root.jsonl" }), null)).toBe("live");
  expect(attachModeFor(file({ engine: "codex", root: "codex-sessions", proc: "running" }), null)).toBe("live");
  // structured, finished, and dead hosts all resume in a fresh window
  expect(attachModeFor(file({ proc: "running" }), rv("codex-app-server", "hosted"))).toBe("resume");
  expect(attachModeFor(file({ proc: null, engine: "codex", root: "codex-sessions" }), null)).toBe("resume");
  expect(attachModeFor(file({ proc: "running" }), rv("claude-broker", "dead"))).toBe("resume");
});

/* ------------------------------ visibility helper ------------------------------ */

test("stripHasVisibleControls is false only when every control is hidden", () => {
  expect(stripHasVisibleControls(capabilitiesFor(file({ proc: "running" }), null))).toBe(true);
  // a finished, non-resumable subagent: terminal hidden + everything else hidden
  expect(stripHasVisibleControls(capabilitiesFor(file({ proc: null, kind: "subagent" }), null))).toBe(false);
});
