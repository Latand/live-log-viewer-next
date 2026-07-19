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
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";
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
  | "live-subagent"  // running child of a live *tmux* root — ESC/kill land in the root pane
  | "structured-subagent" // running child of a live *structured* root — Stop relays to the root's structured interrupt
  | "structured"     // pane-less structured host (codex-app-server / claude-broker)
  | "resume"         // finished, resumable root conversation
  | "dead"           // host died / went unhosted — banner owns recovery (§5)
  | "superseded"     // terminally retired round (issue #383) — banner links the live successor
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
 * The canonical root host of a Claude subagent, resolved from the runtime store.
 * `structured` distinguishes a `claude-broker`/`codex-app-server` root (whose
 * child must relay Stop through the structured interrupt channel and inherit the
 * structured Kill/images restrictions) from a legacy tmux root (whose child
 * keeps canonical tmux routing) — issue #241 finding 1 (round 3).
 */
export interface RootHost {
  liveness: RootLiveness;
  structured: boolean;
  /** A structured root's negotiated image capability: a structured-root child
      delivers images through the ROOT's host, so the child's images cell
      delegates here (the per-session capability object, not a static rule). */
  imageInput?: RuntimeImageCapability | null;
}

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
  /** For a Claude subagent: its canonical root host (liveness + kind). */
  root?: RootHost;
}

/** Resolved host authority — the single place `null` runtime state is classified. */
type HostResolution =
  | { kind: "structured" }
  | { kind: "dead" }
  | { kind: "legacy" }        // file.proc is authoritative (tmux-legacy or plane off)
  | { kind: "unresolved" };   // plane on, no host evidence yet — fail safe

function resolveHost(rv: RuntimeSessionView | null, opts: HostOptions): HostResolution {
  // Dead wins over structured: a structured host that went dead/unhosted still
  // routes to the banner, never the structured strip. Both classifiers consult
  // the structured-hosts rollback gate (below), so a flag-off session is never
  // read as structured or dead here.
  if (isDeadHost(rv)) return { kind: "dead" };
  if (isStructuredHost(rv)) return { kind: "structured" };
  // Affirmative legacy-host evidence (a tmux-legacy projection) or the runtime
  // plane being off both make `file.proc` the authority. A bare `null` while the
  // plane is on is *unresolved*, never assumed-legacy.
  if (rv && rv.legacy) return { kind: "legacy" };
  // Structured-hosts rollback gate (LLV_STRUCTURED_HOSTS off): a session that
  // still carries structured registry state must resolve through *legacy*
  // capabilities — file.proc is authoritative and no /api/runtime/* request may
  // fire. `isDeadHost`/`isStructuredHost` already returned false above under the
  // gate, so a non-legacy rv reaching here with the gate off is legacy evidence.
  if (rv && !rv.structuredControlsEnabled) return { kind: "legacy" };
  if (!opts.runtimeEnabled) return { kind: "legacy" };
  return { kind: "unresolved" };
}

/** Derive a Claude subagent's root host (liveness + kind) from the root's view. */
export function rootHostFrom(root: RuntimeSessionView | null): RootHost {
  if (!root) return { liveness: "unknown", structured: false };
  const structured = isStructuredHost(root);
  const axis = root.session.host;
  const liveness: RootLiveness =
    axis === "dead" || axis === "unhosted" ? "gated"
    : axis === "hosted" ? "live"
    : "unknown"; // registering / recovering / conflict — transitional
  return { liveness, structured, imageInput: structured ? root.session.capabilities?.imageInput ?? null : null };
}

/** A Claude subagent transcript, whose own proc/pid the scanner leaves null. */
function isClaudeSubagent(file: FileEntry): boolean {
  return file.root === "claude-projects" && file.kind === "subagent";
}

const ENABLED: Capability = { state: "enabled" };
const HIDDEN: Capability = { state: "hidden" };
const disabled = (reason: MessageKey): Capability => ({ state: "disabled", reason });
const enabledWithNote = (note: MessageKey): Capability => ({ state: "enabled", note });

/** Structured image delivery is a *negotiated* per-session capability (shipped
    with the structured image pipeline; the old static "structured ⇒ no images"
    rule is gone): enabled exactly when the host advertised support. */
const structuredImages = (imageInput: RuntimeImageCapability | null | undefined): Capability =>
  imageInput?.supported ? ENABLED : disabled("composer.structuredImagesProtocol");

/** A structured (pane-less) host that is currently alive. Gated by the
    structured-hosts rollback flag: with `structuredControlsEnabled` off no
    session — however its registry state reads — counts as a structured host, so
    every consumer falls back to the legacy path (issue #241 rollback). */
function isStructuredHost(rv: RuntimeSessionView | null): boolean {
  if (!rv || rv.legacy || !rv.structuredControlsEnabled) return false;
  const kind = rv.session.hostKind;
  return kind === "codex-app-server" || kind === "claude-broker";
}

/** The host died or fell unhosted after a crash — recovery moves to the banner.
    Also gated by the rollback flag: with structured controls off the dead-host
    banner (a structured-plane concept) never claims a session — it resolves
    through legacy capabilities like every other flag-off host. */
function isDeadHost(rv: RuntimeSessionView | null): boolean {
  if (!rv || rv.legacy || !rv.structuredControlsEnabled) return false;
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

/** Classify the surface. Shell, superseded, and dead-host win over everything
    else. Supersedence (issue #383) is durable registry evidence projected by
    the server — it needs no runtime-plane resolution, wins over `dead` (the
    banner replaces recovery with navigation to the live successor), and can
    never mark a live card because the registry refuses edges over actively
    hosted chain ends. */
export function surfaceFor(file: FileEntry, rv: RuntimeSessionView | null, opts: HostOptions = {}): StripSurface {
  if (file.engine === "shell") return "shell";
  if (file.supersededBy) return "superseded";
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
    // A live root grants the strip; a structured root routes controls through the
    // structured plane (Stop → root interrupt, Kill → the root's durable control
    // channel, images → the root's negotiated capability), while a legacy tmux
    // root keeps canonical tmux routing.
    if (opts.root?.liveness === "live") return opts.root.structured ? "structured-subagent" : "live-subagent";
    // Pure-legacy mode (plane off) passes no root: the child's own proc is the
    // fallback and its root is necessarily a tmux pane.
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
 * Resolve every control's capability for a conversation. Structured Kill ships
 * through the durable structured control channel, and structured images follow
 * the session's negotiated `capabilities.imageInput`. The remaining ⚠ cells —
 * compact and reconfigure on a structured host — stay `disabled` with a tooltip
 * because `dispatchStructuredControl` still rejects them (409); they flip to
 * `enabled` by editing exactly one row here once the host supports them.
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
    case "structured-subagent":
      return {
        surface,
        controls: {
          // A structured root can't honor a tmux ESC or an /api/proc kill: Stop
          // relays to the ROOT conversation's structured interrupt and Kill
          // enters the ROOT's durable structured control channel (both routed by
          // the caller with the canonical root identity). Images delegate to the
          // ROOT host's negotiated capability. The note names the root.
          stop: enabledWithNote("strip.stopSubagent"),
          compact: disabled("strip.compactSubagent"),
          runtime: HIDDEN,
          kill: ENABLED,
          terminal: ENABLED,
          images: structuredImages(opts.root?.imageInput),
          send: ENABLED,
        },
      };
    case "structured":
      return {
        surface,
        controls: {
          stop: ENABLED,
          compact: disabled("strip.structuredUnsupported"),
          // The composer runtime pill owns selection here (issue #390): the cell
          // is enabled, and per-turn honesty comes from the session's negotiated
          // `runtimeSettings` capability, which disables individual rows when a
          // host can't honor a live change (never a whole-control fence).
          runtime: ENABLED,
          // Kill enters the durable structured control channel (one structured
          // request, never /api/proc). Compact and reconfigure stay fenced:
          // dispatchStructuredControl still answers them with a 409.
          kill: ENABLED,
          terminal: ENABLED,
          images: structuredImages(rv?.session.capabilities?.imageInput),
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
          // Text has a durable pre-recovery hold. Images remain in the local
          // draft until a live host can reserve their runtime-store bytes.
          images: disabled("composer.imagesBlockedDuringRecovery"),
          send: ENABLED,
        },
      };
    case "superseded":
      // A terminally retired round (issue #383): the banner owns navigation to
      // the live successor and the explicit resume-here fork; only the
      // terminal escape hatch stays. Send is disabled with a redirect reason —
      // the server answers any bypass attempt with a 409 successor pointer.
      return {
        surface,
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: HIDDEN,
          kill: HIDDEN,
          terminal: ENABLED,
          images: HIDDEN,
          send: disabled("superseded.sendBlocked"),
        },
      };
    case "shell":
      return {
        surface,
        controls: {
          stop: HIDDEN,
          compact: HIDDEN,
          runtime: HIDDEN,
          // Kill signals the live process — a finished (done/killed) shell task
          // has nothing left to signal, so the control is hidden, not offered.
          kill: file.proc === "running" ? ENABLED : HIDDEN,
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
    header and the composer — and since issue #390 so does `runtime` (the
    composer's RuntimePill) — so they never keep an otherwise-empty strip alive. */
const STRIP_OWN_CONTROLS: ControlName[] = ["stop", "compact", "terminal"];

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
