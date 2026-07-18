import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

import { attachModeFor, capabilitiesFor, rootHostFrom, stripHasVisibleControls, surfaceFor, type ControlName, type StripSurface } from "./agentCapabilities";

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

/** The negotiated per-session image capability object, as the host advertises it. */
function imageCap(supported: boolean): RuntimeImageCapability {
  return {
    supported,
    reason: supported ? null : "Structured image protocol is unavailable for this host.",
    formats: ["image/png"],
    maxImages: 16,
    maxRawBytesPerImage: 1_000_000,
    maxEncodedBytesPerRequest: 4_000_000,
  };
}

/** Minimal runtime view — `capabilitiesFor` reads `legacy`, host fields and the
    negotiated image capability. */
function rv(hostKind: HostKind, host: HostAxis, legacy = false, imageInput?: RuntimeImageCapability): RuntimeSessionView {
  return {
    session: { hostKind, host, capabilities: { steer: true, structuredAttention: true, ...(imageInput ? { imageInput } : {}) } } as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"],
    attentions: [],
    receipts: [],
    legacy,
    structuredControlsEnabled: true,
  };
}

/** Same view with the structured-hosts rollback flag OFF. */
function rvGateOff(hostKind: HostKind, host: HostAxis): RuntimeSessionView {
  return { ...rv(hostKind, host), structuredControlsEnabled: false };
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

/* ------------------- finding 1: unresolved host fails safe ------------------- */

test("a running conversation with no runtime session under the plane is unresolved — zero legacy controls", () => {
  // The plane is authoritative but no session has arrived: a running pid must NOT
  // be read as a live tmux pane (it could be a structured/dead host).
  const f = file({ proc: "running" });
  expect(surfaceFor(f, null, { runtimeEnabled: true })).toBe<StripSurface>("unresolved");
  const caps = capabilitiesFor(f, null, { runtimeEnabled: true });
  for (const c of ["stop", "compact", "runtime", "kill", "terminal", "images"] as ControlName[]) {
    expect(caps.controls[c].state).toBe("hidden");
  }
  // send is disabled (not silently enabled) so the composer blocks its POST
  expect(caps.controls.send.state).toBe("disabled");
  expect(caps.controls.send.state === "disabled" && caps.controls.send.reason).toBe("strip.resolving");
  // and the strip itself renders nothing
  expect(stripHasVisibleControls(caps)).toBe(false);
});

test("affirmative legacy-tmux evidence resolves a running pane to live-root even under the plane", () => {
  expect(surfaceFor(file({ proc: "running" }), rv("tmux-legacy", "hosted", true), { runtimeEnabled: true })).toBe<StripSurface>("live-root");
});

test("hydrated structured and dead hosts resolve to their rows under the plane", () => {
  expect(surfaceFor(file({ proc: "running" }), rv("codex-app-server", "hosted"), { runtimeEnabled: true })).toBe<StripSurface>("structured");
  expect(surfaceFor(file({ proc: "running" }), rv("claude-broker", "dead"), { runtimeEnabled: true })).toBe<StripSurface>("dead");
});

test("a finished (proc-null) conversation stays resume under the plane — not unresolved", () => {
  const finished = file({ proc: null, engine: "codex", root: "codex-sessions" });
  expect(surfaceFor(finished, null, { runtimeEnabled: true })).toBe<StripSurface>("resume");
});

/* ------------------- finding 1: structured-hosts rollback gate ------------------- */

test("with the gate OFF a structured host resolves through legacy — never the structured row", () => {
  // The registry still carries structured state, but LLV_STRUCTURED_HOSTS is off:
  // classification must fall back to file.proc, so a running pane reads as
  // live-root and no structured control (or /api/runtime request) is offered.
  const f = file({ proc: "running" });
  expect(surfaceFor(f, rvGateOff("codex-app-server", "hosted"), { runtimeEnabled: true })).toBe<StripSurface>("live-root");
  const caps = capabilitiesFor(f, rvGateOff("codex-app-server", "hosted"), { runtimeEnabled: true });
  for (const c of ["stop", "compact", "runtime", "kill", "terminal", "images", "send"] as ControlName[]) {
    expect(caps.controls[c].state).toBe("enabled"); // the full legacy live-root row
  }
});

test("with the gate OFF a dead structured host resolves through legacy, not the dead banner", () => {
  const f = file({ proc: "running" });
  expect(surfaceFor(f, rvGateOff("claude-broker", "dead"), { runtimeEnabled: true })).toBe<StripSurface>("live-root");
  // and a finished one is resume, never dead
  expect(surfaceFor(file({ proc: null }), rvGateOff("claude-broker", "dead"), { runtimeEnabled: true })).toBe<StripSurface>("resume");
});

test("rootHostFrom honors the gate: a flag-off structured root reports structured=false (legacy routing)", () => {
  expect(rootHostFrom(rv("claude-broker", "hosted"))).toEqual({ liveness: "live", structured: true, imageInput: null });
  expect(rootHostFrom(rvGateOff("claude-broker", "hosted"))).toEqual({ liveness: "live", structured: false, imageInput: null });
});

test("rootHostFrom surfaces a structured root's negotiated image capability", () => {
  const cap = imageCap(true);
  expect(rootHostFrom(rv("claude-broker", "hosted", false, cap))).toEqual({ liveness: "live", structured: true, imageInput: cap });
});

test("with the gate OFF a scanner-shaped subagent under a structured root takes the legacy live-subagent row", () => {
  // The hook derives the root host with the gate honored, so a flag-off structured
  // root reads as a legacy root: its child gets tmux routing (Kill → /api/proc),
  // never the structured-subagent row.
  const c = file({ proc: null, pid: null, kind: "subagent", parent: "/root.jsonl" });
  expect(surfaceFor(c, null, { runtimeEnabled: true, root: { liveness: "live", structured: false } })).toBe<StripSurface>("live-subagent");
});

/* ------------------- finding 2: scanner-shaped subagents ------------------- */

const child = () => file({ proc: null, pid: null, kind: "subagent", parent: "/root.jsonl" });

test("a scanner-shaped subagent under a live TMUX root gets the legacy live-subagent row", () => {
  const c = child();
  expect(surfaceFor(c, null, { runtimeEnabled: true, root: { liveness: "live", structured: false } })).toBe<StripSurface>("live-subagent");
  const caps = capabilitiesFor(c, null, { runtimeEnabled: true, root: { liveness: "live", structured: false } });
  expect(caps.controls.stop.state).toBe("enabled");   // ESC → root pane via /api/tmux
  expect(caps.controls.kill.state).toBe("enabled");   // /api/proc → root pid
  expect(caps.controls.images.state).toBe("enabled");
  expect(caps.controls.terminal.state).toBe("enabled");
});

test("a scanner-shaped subagent under a live STRUCTURED root gets structured-subagent (no tmux/proc controls)", () => {
  const c = child();
  expect(surfaceFor(c, null, { runtimeEnabled: true, root: { liveness: "live", structured: true } })).toBe<StripSurface>("structured-subagent");
  const caps = capabilitiesFor(c, null, { runtimeEnabled: true, root: { liveness: "live", structured: true } });
  // Stop enabled with the root-agent note (relays to the root's structured interrupt)
  expect(caps.controls.stop.state).toBe("enabled");
  expect(caps.controls.stop.state === "enabled" && caps.controls.stop.note).toBe("strip.stopSubagent");
  // Kill is enabled: routed through the ROOT's durable structured control
  // channel, never /api/proc. Images delegate to the ROOT's negotiated
  // capability — absent one they stay disabled with the protocol reason.
  expect(caps.controls.kill.state).toBe("enabled");
  expect(caps.controls.images.state).toBe("disabled");
  expect(caps.controls.images.state === "disabled" && caps.controls.images.reason).toBe("composer.structuredImagesProtocol");
  expect(caps.controls.terminal.state).toBe("enabled");
  // An image-capable structured root flips exactly the images cell.
  const capable = capabilitiesFor(c, null, { runtimeEnabled: true, root: { liveness: "live", structured: true, imageInput: imageCap(true) } });
  expect(capable.controls.images.state).toBe("enabled");
});

test("a dead/finished/unknown root keeps a scanner-shaped subagent gated (inert)", () => {
  const c = child();
  expect(surfaceFor(c, null, { runtimeEnabled: true, root: { liveness: "gated", structured: false } })).toBe<StripSurface>("inert");
  expect(surfaceFor(c, null, { runtimeEnabled: true, root: { liveness: "gated", structured: true } })).toBe<StripSurface>("inert");
  expect(surfaceFor(c, null, { runtimeEnabled: true, root: { liveness: "unknown", structured: true } })).toBe<StripSurface>("inert");
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

test("structured: stop+terminal+kill enabled, compact/runtime still fenced, images follow the negotiated capability", () => {
  const f = file({ proc: "running" });
  const view = rv("codex-app-server", "hosted");
  expect(state("stop", f, view)).toBe("enabled");
  expect(state("terminal", f, view)).toBe("enabled");
  // Kill is enabled and routed through the durable structured control channel.
  expect(state("kill", f, view)).toBe("enabled");
  // Compact/reconfigure stay disabled: dispatchStructuredControl still 409s them.
  expect(reason("compact", f, view)).toBe("strip.structuredUnsupported");
  expect(reason("runtime", f, view)).toBe("strip.structuredUnsupported");
  // Images delegate to session.capabilities.imageInput: no negotiated capability
  // (or an unsupported one) disables with the protocol reason; a supported one enables.
  expect(reason("images", f, view)).toBe("composer.structuredImagesProtocol");
  expect(reason("images", f, rv("codex-app-server", "hosted", false, imageCap(false)))).toBe("composer.structuredImagesProtocol");
  expect(state("images", f, rv("codex-app-server", "hosted", false, imageCap(true)))).toBe("enabled");
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

test("shell: only Kill applies, and only while the process runs", () => {
  const f = file({ engine: "shell", proc: "running", root: "shell-tasks" as FileEntry["root"] });
  expect(state("kill", f, null)).toBe("enabled");
  for (const c of ["stop", "compact", "runtime", "terminal", "images", "send"] as ControlName[]) {
    expect(state(c, f, null)).toBe("hidden");
  }
  // A finished shell task (done/killed/never observed) has nothing to signal:
  // Kill is hidden, and the whole row goes dark.
  for (const proc of ["done", "killed", null] as FileEntry["proc"][]) {
    const finished = file({ engine: "shell", proc, root: "shell-tasks" as FileEntry["root"] });
    expect(surfaceFor(finished, null)).toBe<StripSurface>("shell");
    for (const c of ["stop", "compact", "runtime", "kill", "terminal", "images", "send"] as ControlName[]) {
      expect(state(c, finished, null)).toBe("hidden");
    }
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
