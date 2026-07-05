import { resumeSpecFor } from "@/lib/agent/cli";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import { detectBlockingGate, parseScreenMenu, screenWaitsForInput } from "@/lib/status";
import {
  buildImagePayload,
  deleteInboxImages,
  forgetResumePane,
  killPane,
  knownLivePids,
  liveResumePane,
  paneScreen,
  resolveTarget,
  sendInterrupt,
  sendKeys,
  sendText,
  sendToResumedAgent,
  withPaneLock,
  type InboxImagePayload,
} from "@/lib/tmux";

/**
 * Conversation-level delivery: every action the tmux API exposes, expressed
 * over transcript paths instead of panes. This module owns the resolution
 * ladder — live pane → resume window → relay through the root conversation —
 * and each per-action guard; the route only maps HTTP to these calls.
 */

export interface DeliveryFailure {
  error: string;
  status: number;
}

export interface DeliverySuccess {
  ok: true;
  target: string;
  imagePaths?: string[];
  /** Set when the message booted a fresh agent window instead of an existing pane. */
  spawned?: boolean;
}

export type DeliveryOutcome = DeliverySuccess | DeliveryFailure;

function failure(error: unknown, status = 500): DeliveryFailure {
  return { error: error instanceof Error ? error.message : String(error), status };
}

/** Resolves and revalidates a request pid against the scanner's live set. */
export async function targetForKnownPid(pid: number): Promise<string | null | "unknown"> {
  const live = await knownLivePids();
  if (!live.has(pid)) return "unknown";
  return resolveTarget(pid);
}

/**
 * Live pane of a conversation, for an interrupt or a kill. The pid comes from
 * the scanner's own entry for the path — a client-supplied pid is ignored
 * (like /api/proc), since resolving it directly would let any same-origin
 * caller reach an unrelated agent's pane. Never boots a fresh agent window:
 * both actions only make sense against a pane that already exists.
 */
export async function livePaneTarget(filePath: string): Promise<string | null> {
  const entry = (await listFiles()).find((item) => item.path === filePath);
  if (entry && entry.pid !== null) {
    const target = await resolveTarget(entry.pid);
    if (target !== null) return target;
  }
  const pane = await liveResumePane(filePath);
  return pane ? pane.display : null;
}

export async function interruptConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return { error: "для переривання потрібен path розмови", status: 400 };
  }
  const target = await livePaneTarget(filePath);
  if (target === null) {
    return { error: "немає активного пейна агента для переривання", status: 409 };
  }
  try {
    await sendInterrupt(target);
    return { ok: true, target };
  } catch (error) {
    return failure(error);
  }
}

/* The /compact slash command typed into the live pane: both agent CLIs
   parse a submitted "/compact" and condense their context; the transcript
   then grows a compaction marker the feed renders as a band. Only makes
   sense against a pane that already exists — never boots a window. */
export async function compactConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return { error: "для стискання потрібен path розмови", status: 400 };
  }
  const target = await livePaneTarget(filePath);
  if (target === null) {
    return { error: "немає активного пейна агента для стискання", status: 409 };
  }
  try {
    await sendText(target, "/compact");
    return { ok: true, target };
  } catch (error) {
    return failure(error);
  }
}

export type DialogStale = "blocked" | "closed" | "changed" | null;

/**
 * Stale-menu guard for a dialog key press, pure over the captured screen: the
 * dialog that advanced or closed since the client rendered must swallow
 * nothing. A digit must still point at the same option label under the same
 * question; a bare Tab/Enter/Escape only checks the question when a menu is
 * still on screen.
 */
export function dialogKeyStale(screen: string, key: string, label: unknown, question: unknown): DialogStale {
  const blocking = detectBlockingGate(screen);
  if (blocking !== null) return "blocked";
  if (!screenWaitsForInput(screen)) return "closed";
  const menu = parseScreenMenu(screen);
  if (/^[1-9]$/.test(key)) {
    const option = menu?.options.find((item) => String(item.value) === key);
    if (
      !option ||
      (typeof label === "string" && label !== option.label) ||
      (typeof question === "string" && question !== menu?.question)
    ) {
      return "changed";
    }
  } else if (menu && typeof question === "string" && question !== menu.question) {
    return "changed";
  }
  return null;
}

/* A key press into a live dialog the scrape fallback surfaced: the digit of
   a menu option, or Tab/Enter/Escape for screens the parser cannot read.
   The pane is re-read right before sending — see dialogKeyStale. */
export async function answerDialogKey(filePath: string, key: string, label: unknown, question: unknown): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return { error: "для відповіді потрібен path розмови", status: 400 };
  }
  if (!/^([1-9]|Tab|Enter|Escape)$/.test(key)) {
    return { error: "некоректна клавіша", status: 400 };
  }
  const target = await livePaneTarget(filePath);
  if (target === null) {
    return { error: "немає активного пейна агента", status: 409 };
  }
  try {
    const stale = await withPaneLock(target, async () => {
      const verdict = dialogKeyStale(await paneScreen(target), key, label, question);
      if (verdict === null) await sendKeys(target, [key]);
      return verdict;
    });
    if (stale === "blocked") return { error: "пейн чекає на підтвердження, яке потребує ручного рішення", status: 409 };
    if (stale === "closed") return { error: "пейн уже не чекає на відповідь", status: 409 };
    if (stale === "changed") return { error: "меню на екрані вже змінилось", status: 409 };
    return { ok: true, target };
  } catch (error) {
    return failure(error);
  }
}

export async function resumeConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return { error: "для відкриття потрібен path розмови", status: 400 };
  }
  const entry = (await listFiles()).find((item) => item.path === filePath);
  if (!entry) return { error: "файл невідомий переглядачу", status: 403 };
  const spec = resumeSpecFor(entry.root, entry.path);
  if (!spec) return { error: "цю розмову неможливо відновити", status: 409 };
  try {
    const sent = await sendToResumedAgent(entry.path, spec, "");
    return { ok: true, target: sent.target, spawned: sent.spawned };
  } catch (error) {
    return failure(error);
  }
}

/* Closing a chat card also puts out its tmux pane. A missing pane is fine —
   the conversation may have never had one or it died already; the close is
   then a pure UI removal and still succeeds. */
export async function killConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return { error: "для закриття потрібен path розмови", status: 400 };
  }
  const entry = (await listFiles()).find((item) => item.path === filePath);
  /* A branch column shares the root conversation's pane: killing it from a
     branch close would take the whole agent down along with the root card
     that is still on screen. Only a root conversation may kill a pane. */
  if (entry && entry.parent) {
    return { ok: true, target: "" };
  }
  const target = await livePaneTarget(filePath);
  if (target === null) {
    return { ok: true, target: "" };
  }
  try {
    await killPane(target);
    forgetResumePane(filePath);
    return { ok: true, target };
  } catch (error) {
    return failure(error);
  }
}

export interface ConversationMessage {
  pid: number | null;
  path: string;
  text: string;
  images: InboxImagePayload[];
}

/**
 * The send ladder: a known live pid delivers straight into its pane; a
 * conversation without one reopens through its resume spec; subagents and
 * other child records, which have no resumable session of their own, relay
 * through the root conversation — into its live pane when it runs, through a
 * resume window otherwise.
 */
export async function deliverConversationMessage(message: ConversationMessage): Promise<DeliveryOutcome> {
  const { pid, path: filePath, images } = message;
  const text = message.text.trim();

  let target: string | null = null;
  if (pid !== null) {
    const resolved = await targetForKnownPid(pid);
    if (resolved === "unknown" && !filePath) {
      return { error: "процес невідомий переглядачу", status: 403 };
    }
    target = resolved === "unknown" ? null : resolved;
  }

  /* Saved paths stay visible to the catch-all: a delivery that fails after
     the images hit disk deletes them so a retry cannot duplicate files. */
  let imagePaths: string[] = [];
  try {
    /* Images are only saved to the inbox once a deliverable destination is
       confirmed below — every early 409/403 return above and below happens
       before any file touches disk, so a rejected request never orphans one. */
    if (target !== null) {
      const bundle = buildImagePayload(text, images);
      imagePaths = bundle.imagePaths;
      await sendText(target, bundle.payload);
      return { ok: true, target, ...(imagePaths.length ? { imagePaths } : {}) };
    }

    /* No live pane: reopen the conversation as a fresh agent window in the
       user's current tmux session and type the prompt there. */
    if (!filePath || !pathAllowed(filePath)) {
      return { error: "процес не у tmux-сесії", status: 409 };
    }
    const all = await listFiles();
    const entry = all.find((item) => item.path === filePath);
    if (!entry) {
      return { error: "файл невідомий переглядачу", status: 403 };
    }
    const spec = resumeSpecFor(entry.root, entry.path);
    if (spec) {
      const bundle = buildImagePayload(text, images);
      imagePaths = bundle.imagePaths;
      const sent = await sendToResumedAgent(entry.path, spec, bundle.payload);
      return { ok: true, target: sent.target, spawned: sent.spawned, ...(imagePaths.length ? { imagePaths } : {}) };
    }

    const byPath = new Map(all.map((item) => [item.path, item]));
    const seen = new Set<string>();
    let root = entry;
    while (root.parent && byPath.has(root.parent) && !seen.has(root.path)) {
      seen.add(root.path);
      root = byPath.get(root.parent)!;
    }
    if (root.path === entry.path) {
      return { error: "цю розмову неможливо відновити", status: 409 };
    }
    /* Resolved before saving anything: the root's live pane or resume spec
       must exist, or the request is rejected without ever writing an image. */
    const rootTarget = root.pid !== null ? await resolveTarget(root.pid) : null;
    const rootSpec = rootTarget === null ? resumeSpecFor(root.root, root.path) : null;
    if (rootTarget === null && !rootSpec) {
      return { error: "коренева сесія недоступна для повідомлення", status: 409 };
    }
    const bundle = buildImagePayload(text, images);
    imagePaths = bundle.imagePaths;
    const relayText = `Повідомлення від користувача для твоєї гілки «${entry.title.slice(0, 100)}» — передай або обробʼи сам:\n${bundle.payload}`;
    const imageField = imagePaths.length ? { imagePaths } : {};
    if (rootTarget !== null) {
      await sendText(rootTarget, relayText);
      return { ok: true, target: rootTarget, ...imageField };
    }
    const sent = await sendToResumedAgent(root.path, rootSpec!, relayText);
    return { ok: true, target: sent.target, spawned: sent.spawned, ...imageField };
  } catch (error) {
    deleteInboxImages(imagePaths);
    return failure(error);
  }
}
