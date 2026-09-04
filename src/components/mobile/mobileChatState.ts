import { accountIdFromPath } from "@/lib/accounts/badge";
import { activeCardMigration } from "@/lib/accounts/migration";
import type { TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { attentionId, blockingStuckDelivery } from "../attention";
import { latestAttempt, stageChipState, type StageChipState } from "../pipelines/pipelineModel";
import { clockDuration, turnIsRunning, turnLeftOpen } from "../turnDuration";
import { fmtAge } from "../utils";
import { workingSince } from "../workingSince";

/**
 * One state, one phrase, one precedence (docs/design/mobile-v2/README.md §2
 * rule 10, §4.2).
 *
 * A conversation's state is computed HERE, once, and rendered once per surface:
 * the conversation bar's meta line, the switcher's rows, and — when lane 2
 * lands — the board's rows. The order is the design's, and it is the order the
 * operator reads it in:
 *
 *   offline > killed > stalled > limit > held > waiting > working > returned > done
 *
 * `offline` is screen-level (the runtime lost the host), so it is passed in
 * rather than read off the entry: every conversation on an offline phone shows
 * the last state received and says so. Everything below it is a projection over
 * the authorities the board already trusts — the process state, the activity,
 * the rate-limit wall, the account-switch delivery fence, the attention queue
 * and the open turn — so this module invents no lifecycle of its own.
 *
 * `killed` is the process state read together with the turn the host left
 * behind (#1487): a host that died mid-turn is killed; a host stopped after
 * its turn settled — the ordinary end of every finished stage — reads as the
 * finished conversation it is, in the neutral tone.
 */
export type ChatStateKey =
  | "offline"
  | "killed"
  | "stalled"
  | "limit"
  | "held"
  | "waiting"
  | "working"
  | "returned"
  | "done";

/** The precedence, most urgent first. The one list every reader sorts by. */
export const CHAT_STATE_PRECEDENCE: readonly ChatStateKey[] = [
  "offline",
  "killed",
  "stalled",
  "limit",
  "held",
  "waiting",
  "working",
  "returned",
  "done",
];

/** Colour role of a state; the dot, the meta phrase and the row edge all take
    their tone from here, so no surface can paint a blocked wait as running
    (2026-08 audit finding 3). */
export type ChatTone = "danger" | "warning" | "success" | "accent" | "neutral";

const TONES: Record<ChatStateKey, ChatTone> = {
  offline: "neutral",
  killed: "danger",
  stalled: "danger",
  limit: "warning",
  held: "warning",
  waiting: "warning",
  working: "success",
  returned: "accent",
  done: "neutral",
};

/** The dot's fill for a tone. `working` is the only one that pulses, and only
    on the focused surface (§5); reduced motion stills it through Tailwind. */
export const CHAT_TONE_DOT: Record<ChatTone, string> = {
  danger: "bg-danger",
  warning: "bg-warning",
  success: "bg-success",
  accent: "bg-accent",
  neutral: "bg-strong",
};

export const CHAT_TONE_TEXT: Record<ChatTone, string> = {
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
  accent: "text-accent",
  neutral: "text-secondary",
};

export interface ChatStateOptions {
  /** The runtime lost the host: screen-level, outranks every entry signal. */
  offline?: boolean;
  nowMs?: number;
}

/** How many deliveries the account-switch fence is holding for this card. */
export function heldDeliveries(file: FileEntry): number {
  const migration = activeCardMigration(file.migration, accountIdFromPath(file.path));
  return migration?.heldDeliveries ?? 0;
}

/**
 * Messages queued behind something that is not the agent, or null.
 *
 * Two authorities say so and the phone treats them as one word, because to the
 * operator they are one fact — what they sent has not been delivered:
 *
 *  - the account-switch fence, with the registry's unsettled count
 *    ({@link heldDeliveries}), the same level-wise read the composer's held
 *    ribbon and the outgoing bubbles use;
 *  - a delivery the outbox is still holding past the queue's wait, which is one
 *    reservation and therefore one message.
 *
 * A lane in either state must not read as running: that is exactly the shape of
 * the 2026-08 audit's finding 3.
 */
export function heldMessages(file: FileEntry, nowMs: number = Date.now()): number | null {
  const fence = heldDeliveries(file);
  if (fence > 0) return fence;
  return file.stuckDelivery && blockingStuckDelivery(file, nowMs / 1000) !== null ? 1 : null;
}

/** The one state of a conversation. */
export function chatState(file: FileEntry, { offline = false, nowMs = Date.now() }: ChatStateOptions = {}): ChatStateKey {
  if (offline) return "offline";
  if (file.proc === "killed" && turnLeftOpen(file)) return "killed";
  /* Stalled needs the attention queue's own TTL judgement: a permission prompt
     from two days ago is dead context, not a conversation holding the line. */
  if (file.activity === "stalled" && attentionId(file, nowMs / 1000) !== null) return "stalled";
  if (file.rateLimit) return "limit";
  if (heldMessages(file, nowMs) !== null) return "held";
  if (file.pendingQuestion || file.waitingInput || file.bridgeAsk) return "waiting";
  /* A dead host runs nothing, whatever freshness the transcript still carries. */
  if (file.proc !== "killed" && turnIsRunning(file)) return "working";
  /* A conversation that finished its turn and is waiting on the operator is
     the queue's business; the attention id is what says so. */
  if (attentionId(file, nowMs / 1000) !== null) return "waiting";
  if (file.parent !== null && file.activity === "recent" && file.proc !== "running") return "returned";
  return "done";
}

export interface ChatStateBits {
  key: ChatStateKey;
  tone: ChatTone;
  /** The full meta phrase: «working 12:40», «limit · Main resets 16:40». */
  phrase: string;
  /** The badge word for a row that needs the operator, or null. */
  badge: string | null;
}

/** Elapsed run time of the open turn, as the ticking clock the bar shows. */
export function workingElapsed(file: FileEntry, nowMs: number): string | null {
  const startedAt = workingSince(file);
  if (startedAt === null) return null;
  return clockDuration(Math.max(0, (nowMs - startedAt) / 1000));
}

/** The rate-limit wall's reset clock, or null when the engine reported none. */
function limitReset(file: FileEntry): string | null {
  const at = file.rateLimit?.resetAt ?? null;
  if (at === null) return null;
  const date = new Date(at * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The state, its tone, its phrase and its badge — everything a surface needs
 * to render the conversation's status once. The phrase never truncates on any
 * surface: the model and the reasoning tier give way first (§3.2).
 */
export function chatStateBits(t: TFunction, file: FileEntry, options: ChatStateOptions = {}): ChatStateBits {
  const nowMs = options.nowMs ?? Date.now();
  const key = chatState(file, { ...options, nowMs });
  const tone = TONES[key];
  const age = fmtAge(file.mtime);
  switch (key) {
    case "offline":
      return { key, tone, phrase: t("mobile2.chat.stateOffline"), badge: null };
    case "killed":
      return { key, tone, phrase: t("mobile2.chat.stateKilledAge", { age }), badge: null };
    case "stalled":
      return { key, tone, phrase: t("mobile2.chat.stateStalled", { age }), badge: t("mobile2.chat.badgeStalled") };
    case "limit": {
      const reset = limitReset(file);
      const account = file.rateLimit?.accountId ?? null;
      const phrase = reset === null
        ? t("mobile2.chat.stateLimit")
        : account
          ? t("mobile2.chat.stateLimitAccountAt", { account, time: reset })
          : t("mobile2.chat.stateLimitAt", { time: reset });
      return { key, tone, phrase, badge: t("mobile2.chat.badgeLimit") };
    }
    case "held":
      return { key, tone, phrase: t("mobile2.chat.stateHeldQueued", { count: heldMessages(file, nowMs) ?? 1 }), badge: null };
    case "waiting": {
      const question = Boolean(file.pendingQuestion || file.waitingInput || file.bridgeAsk);
      return {
        key,
        tone,
        phrase: question ? t("mobile2.chat.stateQuestion", { age }) : t("mobile2.chat.stateWaiting", { age }),
        badge: question ? t("mobile2.chat.badgeQuestion") : t("mobile2.chat.badgeWaiting"),
      };
    }
    case "working": {
      const elapsed = workingElapsed(file, nowMs);
      return { key, tone, phrase: elapsed === null ? t("mobile2.chat.stateWorking") : t("mobile2.chat.stateWorkingFor", { elapsed }), badge: null };
    }
    case "returned":
      return { key, tone, phrase: t("mobile2.chat.stateReturned", { age }), badge: null };
    default:
      return { key, tone, phrase: t("mobile2.chat.stateDone", { age }), badge: null };
  }
}

/** Where a conversation sits in its pipeline, for the bar's `stage k/n` and
    the menu's first row (§4.2, P2-9). `current` is true only while the stage
    the conversation belongs to is the one the pipeline is on. */
export interface StagePosition {
  pipeline: Pipeline;
  stage: PipelineStage;
  /** 1-based position of the stage this conversation ran. */
  k: number;
  n: number;
  state: StageChipState;
  /** True only while this is the stage the pipeline's cursor sits on. */
  current: boolean;
}

/** The pipeline stage a transcript path — or a focused round deck's flow —
    belongs to, if any. A review-loop stage matches by flow id, since the board
    folds its reviewer transcript into the deck. */
export function stagePosition(pipelines: readonly Pipeline[], path: string | null, flowId: string | null = null): StagePosition | null {
  if (!path && !flowId) return null;
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed") continue;
    const index = pipeline.stages.findIndex((stage) => {
      const attempt = latestAttempt(pipeline, stage.id);
      if (!attempt) return false;
      if (path && attempt.agentPath === path) return true;
      return Boolean(flowId && attempt.flowId === flowId);
    });
    if (index < 0) continue;
    const stage = pipeline.stages[index]!;
    return {
      pipeline,
      stage,
      k: index + 1,
      n: pipeline.stages.length,
      state: stageChipState(pipeline, stage),
      current: pipeline.state !== "completed" && pipeline.cursor?.stageId === stage.id,
    };
  }
  return null;
}
