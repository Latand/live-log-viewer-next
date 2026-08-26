import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "@/lib/orchestrator/prompt";

/*
 * What an orchestrator seat's mandate looks like once it is a transcript row
 * (#1166).
 *
 * A seat is created by DELIVERING the mandate: as the spawn's first prompt, or
 * as a message to the conversation being adopted. Either way it reaches the
 * transcript as an ordinary message the operator never typed, and the feed used
 * to render those 8 KB as the operator's own bubble — collapsed to 180
 * characters and a character count, as if they had said it.
 *
 * The recognition is the delivery contract itself:
 * `orchestratorMandateForDelivery` guarantees every delivered mandate carries
 * the initial-status directive verbatim, appending it when a bespoke mandate
 * lacks it. Nothing else in a conversation carries that block, so its presence
 * IS the classification — and it holds for both delivery modes, for bespoke
 * mandates, and for as long as the transcript exists, which delivery-time
 * evidence does not (held delivery records are retired after a week).
 *
 * Pure and render-time only: no transcript byte changes, and nothing here is
 * stored.
 */

/** The headings a rotation handoff is composed under (`seatCommand.ts`), and
    the compact history variant. Matched at the start of a line, so the same
    words quoted inside a mandate never split it. */
const HANDOFF_HEADINGS = ["## Handoff from your predecessor", "## Rotation history"] as const;

/** How the card names this mandate. `unknown` is the honest answer when no
    seat is in scope and the text is not the default this build carries: the
    delivery may be an older approved default or a bespoke one, and the row
    itself cannot tell them apart. */
export type MandateLabel =
  | { kind: "version"; version: number }
  | { kind: "custom" }
  | { kind: "unknown" };

export interface MandateMessage {
  label: MandateLabel;
  /** Lines and characters of the WHOLE delivered message, sections included —
      the size the card is standing in for. */
  lines: number;
  chars: number;
  /** The mandate proper, without the rotation handoff. */
  mandate: string;
  /** The rotation handoff, when this delivery carried one. */
  handoff: string | null;
}

/** True when this row's text IS a delivered seat mandate. */
export function isOrchestratorMandateText(text: string): boolean {
  return text.includes(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
}

/** Offset of the handoff heading that opens a line, or -1. */
function handoffStart(text: string): number {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (HANDOFF_HEADINGS.some((heading) => line.startsWith(heading))) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function sectionsOf(text: string): { mandate: string; handoff: string | null } {
  /* A rotation appends the handoff to the mandate and delivery appends the
     directive after that, so on a BESPOKE rotation the directive sits at the
     very end of the wire text while belonging to the mandate. Lift it back
     before splitting, so the handoff section is the handoff and nothing else. */
  const trailing = `\n\n${ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE}`;
  const appended = text.endsWith(trailing);
  const body = appended ? text.slice(0, -trailing.length) : text;
  const start = handoffStart(body);
  if (start < 0) return { mandate: text.trim(), handoff: null };
  const mandate = body.slice(0, start).trimEnd();
  return {
    mandate: appended ? `${mandate}\n\n${ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE}` : mandate,
    handoff: body.slice(start).trim(),
  };
}

/**
 * How the card reads one delivered mandate.
 *
 * `seatPromptVersion` is the seat's own record of what the mandate was based
 * on — a number for an approved default, null for a bespoke one — and it
 * outranks the text, because a seat created on an older default no longer
 * matches the prompt this build carries. `undefined` means no seat is in scope
 * (the board's conversation pane reads the same rows without one), and then
 * only the text can answer: the current default names its version, anything
 * else stays unknown rather than being called bespoke on no evidence.
 */
export function mandateMessage(text: string, seatPromptVersion?: number | null): MandateMessage {
  const { mandate, handoff } = sectionsOf(text);
  return {
    label: labelOf(mandate, seatPromptVersion),
    lines: text.split("\n").length,
    chars: text.length,
    mandate,
    handoff,
  };
}

function labelOf(mandate: string, seatPromptVersion: number | null | undefined): MandateLabel {
  if (typeof seatPromptVersion === "number") return { kind: "version", version: seatPromptVersion };
  if (seatPromptVersion === null) return { kind: "custom" };
  return mandate.includes(ORCHESTRATOR_SYSTEM_PROMPT)
    ? { kind: "version", version: ORCHESTRATOR_PROMPT_VERSION }
    : { kind: "unknown" };
}
