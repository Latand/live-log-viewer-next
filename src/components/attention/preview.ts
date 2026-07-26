import { focusTargetAnchorKeys } from "@/lib/attention/targets";
import type { AttentionRequestV1, FocusTarget } from "@/lib/attention/types";
import type { AttentionPreview } from "@/components/overlay/AttentionActionRow";

import type { BoardFocusController } from "./focusHandoffBus";
import { focusHandoffProject } from "./navigate";

/**
 * What "let me look first" actually shows (#688 step 3).
 *
 * A preview NEVER moves the view, so everything it says has to come from
 * something already known here: the board's own label for the anchor when this
 * device is looking at the project that holds it, the target's own identity
 * otherwise, and the project the request recorded. Nothing is invented — a
 * request raised through the agent's tool has no board geometry behind it, and
 * the preview says what the request is about rather than describing a layout
 * the raiser never read.
 *
 * The context label is the one line of detail, and it is already bounded and
 * operator-safe on the record. The target's contents are deliberately not here:
 * that is what accepting, and the transcript, are for.
 */

/** The last path segment, without the transcript extension — what a
    conversation is called when the board has no label for it. */
function conversationName(path: string): string {
  const leaf = path.split("/").filter(Boolean).at(-1) ?? path;
  return leaf.replace(/\.jsonl$/i, "") || path;
}

/** The target's own identity, in the vocabulary the operator already sees on
    the board. Never a guess: every one of these is on the request. */
export function focusTargetName(target: FocusTarget): string {
  switch (target.kind) {
    case "conversation":
      return conversationName(target.path);
    case "pipeline":
      return target.pipelineId;
    case "stage":
      return `${target.pipelineId} · ${target.stageId}`;
    case "flowRound":
      return `${target.flowId} · ${target.round}`;
    case "task":
      return target.taskId;
    case "draft":
      return target.draftId;
    case "region":
      return `${Math.round(target.rect.x)}, ${Math.round(target.rect.y)}`;
    case "point":
      return `${Math.round(target.x)}, ${Math.round(target.y)}`;
  }
}

/**
 * The preview card for a request, built from the target and — when this device
 * is already looking at the right project — the board's own name for it.
 */
export function attentionPreviewFor(
  request: Pick<AttentionRequestV1, "target" | "frameAtCreation" | "contextLabel">,
  board: BoardFocusController | null,
): AttentionPreview {
  const project = focusHandoffProject(request);
  const keys = focusTargetAnchorKeys(request.target);
  /* Only this project's board may name the anchor: another project's layout can
     hold the same key for a different thing. */
  const named = board && board.project === project ? board.index.named ?? [] : [];
  const label = keys.length ? named.find((frame) => keys.includes(frame.key))?.label ?? null : null;
  return {
    title: label ?? focusTargetName(request.target),
    project,
    detail: request.contextLabel ?? null,
  };
}
