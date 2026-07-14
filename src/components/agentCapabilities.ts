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
import type { HostAxis } from "@/components/runtime/runtimeModel";
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
  | "unresolved"     // runtime plane is authoritative but no host evidence yet
  | "inert";         // nothing applies (e.g. a finished, non-resumable subagent)

export interface StripCapabilities {
  surface: StripSurface;
  controls: Record<ControlName, Capability>;
}

/**
 * Liveness of a Claude subagent's canonical ROOT host. The scanner intentionally
 * leaves subagent `proc`/`pid` null because the root process writes the child
 * transcript (see `src/lib/scanner/transcripts.ts`), so a child's liveness *is*
 * its root host's. Resolved by the component from the runtime store (issue #241
 * finding 2). `unknown` means the root host has not been observed yet.
 */
export type RootLiveness = "live" | "gated" | "unknown";

/**
 * How the caller establishes host authority. When `runtimeEnabled` is true the
 * runtime plane is the source of truth for host capability: a conversation with
 * no resolved runtime session is *unresolved*, not "legacy tmux with a running
 * pid" — so no legacy Stop/Kill/runtime control or dead-host send may fire until
 * affirmative host evidence arrives (issue #241 finding 1). When it is false the
 * runtime plane is off entirely (pre-#241 world) and `file.proc` is authoritative.
 */
export interface HostOptions {
  runtimeEnabled?: boolean;
  /** For a Claude subagent: the liveness of its canonical root host. */
  root?: RootLiveness;
}

/** Resolved host authority — the single place `null` runtime state is classified. */
type HostResolution =
  | { kind: "structured" }
  | { kind: "dead" }
  | { kind: "legacy" }        // file.proc is authoritative (tmux-legacy or plane off)
  | { kind: "unresolved" };   // plane on, no host evidence yet — fail safe

function resolveHost(rv: RuntimeSessionView | null, opts: HostOptions): HostResolution {
  // Dead wins over structured: a structured host that went dead/unhosted still
  // routes to the banner, never the structured strip.
  if (isDeadHost(rv)) return { kind: "dead" };
  if (isStructuredHost(rv)) return { kind: "structured" };
  // Affirmative legacy-host evidence (a tmux-legacy projection) or the runtime
  // plane being off both make `file.proc` the authority. A bare `null` while the
  // plane is on is *unresolved*, never assumed-legacy.
  if (rv && rv.legacy) return { kind: "legacy" };
  if (!opts.runtimeEnabled) return { kind: "legacy" };
  return { kind: "unresolved" };
}

/** Derive a Claude subagent's root-host liveness from the root's runtime view. */
export function rootLivenessFrom(root: { host: HostAxis } | null): RootLiveness {
  if (!root) return "unknown";
  if (root.host === "dead" || root.host === "unhosted") return "gated";
  if (root.host === "hosted") return "live";
  return "unknown"; // registering / recovering / conflict — transitional
}

/** A Claude subagent transcript, whose own proc/pid the scanner leaves null. */
function isClaudeSubagent(file: FileEntry): boolean {
  return file.root === "claude-projects" && file.kind === "subagent";
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
export function surfaceFor(file: FileEntry, rv: RuntimeSessionView | null, opts: HostOptions = {}): StripSurface {
  if (file.engine === "shell") return "shell";
  const host = resolveHost(rv, opts);
  if (host.kind === "structured") return "structured";
  if (host.kind === "dead") return "dead";

  // A Claude subagent's own proc/pid is null by scanner design (the root process
  // writes the child transcript), so its liveness is the ROOT host's, resolved
  // by the caller into `opts.root` (issue #241 finding 2). A live root grants the
  // subagent strip; a gated (dead/finished) or as-yet-unknown root keeps it inert
  // so no relay control fires against an unconfirmed host. `opts.root` is only
  // absent in pure-legacy mode, where the child's own proc is the fallback.
  if (isClaudeSubagent(file)) {
    if (opts.root === "live") return "live-subagent";
    if (opts.root === undefined && host.kind !== "unresolved" && file.proc === "running") return "live-subagent";
    return isResumableConversation(file) ? "resume" : "inert";
  }

  // Non-subagent under the runtime plane: only a *running* pid is ambiguous — it
  // could be a structured/dead host or a live tmux pane, so it fails safe to
  // `unresolved` until affirmative host evidence arrives (finding 1). A finished
  // (proc-null) conversation has no live host to misclassify, so resume/inert
  // stay available.
  if (host.kind === "unresolved") {
    if (file.proc === "running") return "unresolved";
    return isResumableConversation(file) ? "resume" : "inert";
  }
  if (file.proc === "running") {
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
export function capabilitiesFor(file: FileEntry, rv: RuntimeSessionView | null, opts: HostOptions = {}): StripCapabilities {
  const surface = surfaceFor(file, rv, opts);
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
    case "unresolved":
      // The runtime plane owns host capability but hasn't resolved this
      // conversation yet (initial snapshot load / bus outage). Every legacy
      // control stays hidden and Send is disabled with a reason — no /api/tmux
      // or /api/proc request can fire against an as-yet-unclassified host, and
      // no dead-host send can slip through (issue #241 finding 1).
      return {
        surface,
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: HIDDEN,
          kill: HIDDEN,
          terminal: HIDDEN,
          images: HIDDEN,
          send: disabled("strip.resolving"),
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

/** The controls the strip *itself* renders. `kind`/`send`/`images` belong to the
    header and the composer, so they never keep an otherwise-empty strip alive. */
const STRIP_OWN_CONTROLS: ControlName[] = ["stop", "compact", "runtime", "terminal"];

/** True when the strip has at least one of its own visible controls. */
export function stripHasVisibleControls(caps: StripCapabilities): boolean {
  return STRIP_OWN_CONTROLS.some((name) => caps.controls[name].state !== "hidden");
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
export function attachModeFor(file: FileEntry, rv: RuntimeSessionView | null, opts: HostOptions = {}): AttachMode {
  const surface = surfaceFor(file, rv, opts);
  return surface === "live-root" || surface === "live-subagent" ? "live" : "resume";
}
