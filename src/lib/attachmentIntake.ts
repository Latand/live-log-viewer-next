/**
 * The composer attachment-intake contract, in ONE place (issue #1224): what a
 * composer accepts, and — the half that keeps regressing — what the operator is
 * told about everything it does not.
 *
 * Every composer asks the same two questions of a picked, pasted or dropped
 * file: is it deliverable here, and if not, what does the operator see? Each
 * composer answering them for itself is exactly how the same defect kept coming
 * back in a new file. The pane composer learned to name every file refused in
 * one gesture; the task composer went on writing one status per file into a
 * slot that holds one message, so every refusal but the last vanished unnamed —
 * the silent discard this issue exists to remove, wearing a new coat. The screen
 * and the sentence live here now, and a composer supplies its policy rather than
 * its own copy of the rules.
 *
 * No React and no `node:` imports: a hook, a component and a plain unit test all
 * read this module.
 */

import {
  attachmentMegabytes,
  MAX_INBOX_FILES,
  MAX_INBOX_FILES_TOTAL_BYTES,
  MAX_INBOX_FILE_BYTES,
} from "@/lib/filePolicy";
import { getLocale, translate } from "@/lib/i18n";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

/** What a staged slot IS, and therefore how it is delivered (issue #1224).
    An `image` rides base64 into the turn under the engine's negotiated image
    capability; a `file` is written to the conversation's inbox and named in the
    message by path, which needs no capability at all. */
export type AttachmentKind = "image" | "file";

/** One refused file: the operator's own name for it, and why it was refused.
    Both halves are mandatory — a reason with no name is the silent discard with
    extra words. */
export interface AttachmentRefusal {
  name: string;
  reason: string;
}

/** Whether this file is deliverable as an IMAGE — the same whitelist the server
    saves against. Anything else is a general attachment (issue #1224). */
export function isImageAttachment(file: { type?: string }): boolean {
  return inboxImageExt(file.type ?? "") !== null;
}

/** The name a refusal — and the tray tile — calls this file by. A picker that
    hands over no filename still gets a word rather than an empty one, so no
    refusal reads as a colon with nothing in front of it. */
export function attachmentDisplayName(file: { name?: string }, kind: AttachmentKind): string {
  return file.name || translate(getLocale(), kind === "image" ? "img.image" : "attach.file");
}

/** What a composer can actually deliver, which is all the screen needs to know
    about it. */
export interface AttachmentIntakePolicy {
  /** Whether this composer has a by-path road for a non-image file (issue
      #1224): the pane composer writes one to the conversation's inbox and names
      its path in the message. A composer without that road refuses a document
      BY NAME instead of dropping it. */
  acceptFiles: boolean;
  /** The engine's negotiated image capability, where one is known. Absent ⇒ the
      composer's own image ceiling applies and no engine gate does. */
  imageCapability?: RuntimeImageCapability | null;
  /** What this composer's tray already holds, so the count and byte ceilings
      are enforced across gestures rather than within one. */
  staged?: { files: number; bytes: number };
}

export interface ScreenedAttachments {
  accepted: { file: File; kind: AttachmentKind }[];
  refusals: AttachmentRefusal[];
}

/**
 * Screen one intake gesture against a composer's policy, in the operator's own
 * selection order, so a refusal names the files in the order they were handed
 * over. Nothing here touches the DOM or stages anything: it decides, and the
 * caller stages what came back accepted and surfaces what came back refused.
 *
 * Every path out of a file is either `accepted` or a named refusal. There is no
 * third one, and that is the whole point of the module.
 */
export function screenAttachments(input: readonly File[], policy: AttachmentIntakePolicy): ScreenedAttachments {
  const capability = policy.imageCapability ?? null;
  const accepted: { file: File; kind: AttachmentKind }[] = [];
  const refusals: AttachmentRefusal[] = [];
  const refuse = (name: string, reason: string) => { refusals.push({ name, reason }); };
  const stagedFiles = policy.staged?.files ?? 0;
  const stagedBytes = policy.staged?.bytes ?? 0;
  let addedFiles = 0;
  let addedBytes = 0;

  for (const file of input) {
    const kind: AttachmentKind = isImageAttachment(file) ? "image" : "file";
    const name = attachmentDisplayName(file, kind);
    /* A file with no bytes is refused BY NAME before anything is staged: there
       is nothing to hand an agent, and a slot that stages anyway settles as
       `ready` with an empty payload the send then leaves behind (issue #1224).
       Only an explicit zero counts, so a picker that reports no size at all
       still goes through the read, where the same emptiness is caught again. */
    if (file.size === 0) {
      refuse(name, translate(getLocale(), "attach.empty"));
      continue;
    }
    if (kind === "image") {
      /* Images: unchanged behaviour and unchanged capability gate. An engine
         that cannot take an image says so here rather than at delivery time. */
      if (capability && !capability.supported) {
        refuse(name, capability.reason ?? translate(getLocale(), "composer.structuredImagesUnavailable"));
        continue;
      }
      const rawLimit = capability?.maxRawBytesPerImage ?? MAX_INBOX_IMAGE_BYTES;
      if (file.size > rawLimit) {
        refuse(name, capability
          ? translate(getLocale(), "img.structuredTooLarge", { max: attachmentMegabytes(rawLimit) })
          : translate(getLocale(), "attach.tooLarge", { max: attachmentMegabytes(rawLimit) }));
        continue;
      }
      accepted.push({ file, kind });
      continue;
    }
    if (!policy.acceptFiles) {
      refuse(name, translate(getLocale(), "attach.imagesOnlyHere"));
      continue;
    }
    if (file.size > MAX_INBOX_FILE_BYTES) {
      refuse(name, translate(getLocale(), "attach.tooLarge", { max: attachmentMegabytes(MAX_INBOX_FILE_BYTES) }));
      continue;
    }
    /* Count and aggregate ceilings are weighed pre-read against file sizes, so
       an over-budget batch is refused before any placeholder mounts — the tray
       never shows a slot that could never deliver. */
    if (stagedFiles + addedFiles + 1 > MAX_INBOX_FILES) {
      refuse(name, translate(getLocale(), "attach.tooMany", { max: MAX_INBOX_FILES }));
      continue;
    }
    if (stagedBytes + addedBytes + file.size > MAX_INBOX_FILES_TOTAL_BYTES) {
      refuse(name, translate(getLocale(), "attach.aggregateTooLarge", { max: attachmentMegabytes(MAX_INBOX_FILES_TOTAL_BYTES) }));
      continue;
    }
    addedFiles += 1;
    addedBytes += file.size;
    accepted.push({ file, kind });
  }

  return { accepted, refusals };
}

/**
 * Refusals in one gesture are separated by a NEWLINE, not a semicolon: the
 * status surface renders several lines (issue #1224 round-3 finding 3), and a
 * refusal naming four rejected files on one truncated line is a refusal the
 * operator cannot read — which is the mechanism defeating itself.
 */
export const REFUSAL_SEPARATOR = "\n";

/**
 * A whole gesture's refusals as ONE status message. The composer status holds
 * exactly one slot, so a call per refused file left only the last one on screen
 * and every earlier file disappeared unnamed. Files refused for the same reason
 * are named together, in the order they were handed over, each reason on its own
 * line, and the single-file case still reads exactly as it always did.
 */
export function refusalStatusText(refusals: readonly AttachmentRefusal[]): string {
  const grouped = new Map<string, string[]>();
  for (const { name, reason } of refusals) {
    const names = grouped.get(reason);
    if (names) names.push(name);
    else grouped.set(reason, [name]);
  }
  return [...grouped]
    .map(([reason, names]) => translate(getLocale(), "attach.refused", { names: names.join(", "), reason }))
    .join(REFUSAL_SEPARATOR);
}
