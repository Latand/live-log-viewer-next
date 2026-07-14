/**
 * Pure capability matrix for the unified agent control strip (issue #241 §4).
 *
 * A single function decides, per control, whether it is `enabled`,
 * `disabled` (with a localized reason naming why/when), or `hidden` for the
 * surface a conversation currently renders on. No React, no I/O — every cell of
 * the design's §4 table is unit-tested against this.
 *
 * The guiding rule (design §4): a control that can *never* apply to a surface is
 * **hidden**; a control that is temporarily unavailable (a backend gap, a
 * migration hold, a dead host) is **disabled with a tooltip** naming the reason.
 */

import type { MessageKey } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";

/** The controls the strip (and the header kill) gate on. */
export type ControlName = "stop" | "compact" | "runtime" | "kill" | "terminal" | "images" | "send";

/** One control's resolved capability. `reason` (disabled) and `note` (enabled)
    are localized tooltip keys the strip appends to the aria-label so screen
    readers hear them too. A `note` explains an *enabled* control whose effect
    isn't obvious — e.g. a subagent Stop that lands in the root agent (§4). */
export type Capability =
  | { state: "enabled"; note?: MessageKey }
  | { state: "disabled"; reason: MessageKey }
  | { state: "hidden" };

/**
 * Which conversation surface a pane renders. The strip branches its layout and
 * the runtime group's mode (live reconfigure vs. on-resume profile) on this.
 */
export type StripSurface =
  | "live-root"      // running top-level tmux claude/codex agent
  | "live-subagent"  // running child pane — ESC/kill land in the root
  | "structured"     // pane-less structured host (codex-app-server / claude-broker)
  | "resume"         // finished, resumable root conversation
  | "dead"           // host died / went unhosted — banner owns recovery (§5)
  | "shell"          // background shell task — only Kill applies
  | "inert";         // nothing applies (e.g. a finished, non-resumable subagent)

export interface StripCapabilities {
  surface: StripSurface;
  controls: Record<ControlName, Capability>;
}

const ENABLED: Capability = { state: "enabled" };
const HIDDEN: Capability = { state: "hidden" };
const disabled = (reason: MessageKey): Capability => ({ state: "disabled", reason });
const enabledWithNote = (note: MessageKey): Capability => ({ state: "enabled", note });

/** A structured (pane-less) host that is currently alive. */
function isStructuredHost(rv: RuntimeSessionView | null): boolean {
  if (!rv || rv.legacy) return false;
  const kind = rv.session.hostKind;
  return kind === "codex-app-server" || kind === "claude-broker";
}

/** The host died or fell unhosted after a crash — recovery moves to the banner. */
function isDeadHost(rv: RuntimeSessionView | null): boolean {
  if (!rv || rv.legacy) return false;
  return rv.session.host === "dead" || rv.session.host === "unhosted";
}

/** A finished conversation that can be reopened (resume boots a fresh window).
    Claude subagent transcripts have no resumable session of their own. */
export function isResumableConversation(file: FileEntry): boolean {
  if (file.root === "claude-projects") return file.kind === "session";
  return file.root === "codex-sessions";
}

function isSubagent(file: FileEntry): boolean {
  return file.kind === "subagent";
}

/** Classify the surface. Dead-host and shell win over everything else. */
export function surfaceFor(file: FileEntry, rv: RuntimeSessionView | null): StripSurface {
  if (file.engine === "shell") return "shell";
  if (isDeadHost(rv)) return "dead";
  if (isStructuredHost(rv)) return "structured";
  const running = file.proc === "running";
  if (running) {
    if (isSubagent(file) || file.parent) return "live-subagent";
    return "live-root";
  }
  if (isResumableConversation(file)) return "resume";
  return "inert";
}

/**
 * Resolve every control's capability for a conversation. The three ⚠ cells that
 * wait on backend work (#240 structured kill/compact/reconfigure, #239
 * structured images) are `disabled` with a tooltip today and flip to `enabled`
 * by editing exactly one row here when those merge.
 */
export function capabilitiesFor(file: FileEntry, rv: RuntimeSessionView | null): StripCapabilities {
  const surface = surfaceFor(file, rv);
  switch (surface) {
    case "live-root":
      return {
        surface,
        controls: {
          stop: ENABLED,
          compact: ENABLED,
          runtime: ENABLED,
          kill: ENABLED,
          terminal: ENABLED,
          images: ENABLED,
          send: ENABLED,
        },
      };
    case "live-subagent":
      return {
        surface,
        controls: {
          // Stop is enabled: ESC lands in the canonical root pane
          // (`livePaneHost` resolves it server-side), so the interrupt is a
          // real root-agent interrupt. The note says so — never a dead button.
          stop: enabledWithNote("strip.stopSubagent"),
          compact: disabled("strip.compactSubagent"),
          runtime: HIDDEN,
          kill: ENABLED,
          terminal: ENABLED,
          images: ENABLED,
          send: ENABLED,
        },
      };
    case "structured":
      return {
        surface,
        controls: {
          stop: ENABLED,
          compact: disabled("strip.awaits240"),
          // Pickers stay visible; the strip disables Apply with the same reason.
          runtime: disabled("strip.awaits240"),
          kill: disabled("strip.awaits240"),
          terminal: ENABLED,
          images: disabled("strip.imagesStructured"),
          send: ENABLED,
        },
      };
    case "resume":
      return {
        surface,
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: ENABLED, // picks the resume profile (§4 "on resume")
          kill: HIDDEN,
          terminal: ENABLED,
          images: ENABLED,
          send: ENABLED,
        },
      };
    case "dead":
      return {
        surface,
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: HIDDEN,
          kill: HIDDEN,
          terminal: ENABLED, // the dead-host escape hatch (§5/§6)
          images: HIDDEN,
          send: disabled("deadHost.sendBlocked"),
        },
      };
    case "shell":
      return {
        surface,
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: HIDDEN,
          kill: ENABLED,
          terminal: HIDDEN,
          images: HIDDEN,
          send: HIDDEN,
        },
      };
    case "inert":
    default:
      return {
        surface: "inert",
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: HIDDEN,
          kill: HIDDEN,
          terminal: isResumableConversation(file) ? ENABLED : HIDDEN,
          images: HIDDEN,
          send: HIDDEN,
        },
      };
  }
}

/** True when the strip has at least one visible (enabled or disabled) control. */
export function stripHasVisibleControls(caps: StripCapabilities): boolean {
  return Object.values(caps.controls).some((c) => c.state !== "hidden");
}

/** How the Terminal dialog should build its command (design §6). */
export type AttachMode = "live" | "resume";

/**
 * A live tmux pane attaches to the *running* pane — its ESC-and-type command,
 * plus a read-only variant — and a Claude subagent attaches to its root pane.
 * Every other surface (structured, finished, dead) hands out a resume command
 * that boots a fresh window. Selecting `resume` for a live tmux pane was the
 * finding-3 bug: it generated a resume command for a conversation still running
 * in a pane you could simply attach to.
 */
export function attachModeFor(file: FileEntry, rv: RuntimeSessionView | null): AttachMode {
  const surface = surfaceFor(file, rv);
  return surface === "live-root" || surface === "live-subagent" ? "live" : "resume";
}
