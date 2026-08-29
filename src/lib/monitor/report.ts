import { MONITOR_REF_PREFIX, seatTickProposalRef, stateLabel } from "./cards";
import type { ProposalIssue } from "./githubEvidence";
import { redactBounded } from "./redact";
import { MONITOR_MARKER } from "./requests";
import type {
  ClassifiedRequest,
  MonitorCreation,
  MonitorRunRecord,
  RequestState,
  SeatTickItem,
  SeatTickSignalInput,
  SeatTickWakeReason,
} from "./types";

/**
 * The message the monitor delivers to the orchestrator (issue #741).
 *
 * It opens with {@link MONITOR_MARKER} for two reasons: the operator can tell
 * at a glance that no human wrote it, and the next run's extractor uses the
 * same marker to refuse to read this text back as an operator request.
 */

/** Order the states are reported in: the ones needing a decision first. */
const REPORT_ORDER: RequestState[] = ["untracked", "stalled", "awaiting-confirmation", "in-flight", "completed"];

export interface ReportInput {
  record: MonitorRunRecord;
  classified: readonly ClassifiedRequest[];
  createdByFingerprint: ReadonlyMap<string, MonitorCreation>;
}

function bullet(entry: ClassifiedRequest, created: MonitorCreation | undefined): string {
  const card = created ? ` → board card ${created.taskId}` : "";
  return `- ${entry.request.title}${card}\n  ${entry.reason}.`;
}

export function renderMonitorReport(input: ReportInput): string {
  const { record, classified, createdByFingerprint } = input;
  const lines: string[] = [
    `${MONITOR_MARKER} run ${record.runId}`,
    "",
    `Window ${record.window.from.slice(0, 16).replace("T", " ")} → ${record.window.to.slice(0, 16).replace("T", " ")} UTC (${record.window.hours}h), `
      + `${record.scanned.conversations} conversation(s), ${record.scanned.operatorMessages} operator message(s)`
      + `${record.scope.project ? `, project ${record.scope.project}` : ", all projects"}.`,
  ];

  if (classified.length === 0) {
    lines.push("", "No concrete operator request in this window. Nothing created, nothing outstanding.");
  } else {
    for (const state of REPORT_ORDER) {
      const entries = classified.filter((entry) => entry.state === state);
      if (entries.length === 0) continue;
      lines.push("", `${stateLabel(state).toUpperCase()} (${entries.length})`);
      for (const entry of entries) lines.push(bullet(entry, createdByFingerprint.get(entry.request.fingerprint)));
    }
  }

  if (record.created.length > 0) {
    lines.push("", `Created ${record.created.length} board card(s); no GitHub issue was created — the monitor never opens one from inferred intent.`);
  } else {
    lines.push("", "Created no board work this run; no GitHub issue was created — the monitor never opens one from inferred intent.");
  }
  const budgeted = record.skipped.filter((entry) => entry.reason === "card-budget").length;
  if (budgeted > 0) lines.push(`Held back ${budgeted} candidate(s) at this run's card budget; the next run picks them up.`);

  lines.push(
    "",
    `Run ${record.outcome}${record.detail ? ` — ${record.detail}` : ""}. Surfacing only: deciding and delegating stays with you.`,
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * What the seat itself receives (#1245).
 *
 * Short and structural on purpose. The prompt this replaces was a hand-written
 * plan the agent re-typed into every schedule it made for itself, so the plan
 * lived only in the prompt text and died with the session; here the Viewer says
 * what it found and the seat supplies the judgement.
 *
 * The contract at the foot is the same in both briefs, and each clause answers
 * a way the session-scheduled version actually failed: it acted outside the
 * items it was woken for, it left outcomes only in its own transcript, it kept
 * re-running an action that had already failed, it re-armed its own schedule,
 * and it once stopped inside a tick to ask the operator a question.
 *
 * The clause about the settings is there because the pair "do not schedule
 * yourself" and "nothing can quiet the schedule armed for you" is what #1275
 * was filed about. The first half is still right; the second half is now false,
 * and the brief says so where the seat reads it, rather than leaving the lever
 * discoverable only by reading the tool list.
 * ------------------------------------------------------------------------- */

const SEAT_TICK_MESSAGE_LIMIT = 4_000;

const SEAT_TICK_CONTRACT = [
  "Act on the listed items only, and nothing else this turn.",
  "Record every outcome where it belongs — on the board card or on the pipeline — not only in this conversation.",
  "If an item cannot be done, mark its task blocked with the reason. That is the stop, and it is the only one.",
  "Do not schedule yourself. The Viewer ticks this seat; a self-scheduled monitor is refused practice.",
  "This tick is yours to govern: seat_tick_settings turns it off, changes how often it wakes you, or turns it back on, per project, with a reason that shows on the board.",
  "Do not wait on the operator inside this turn.",
];

function seatTickBullet(item: SeatTickItem): string {
  return `- [${item.kind}] ${item.id} — ${item.label}`;
}

/**
 * The project's own monitor prompt (#1280), in the seat's own words.
 *
 * It is APPENDED — never a substitution. The reasons and items above it are
 * what the tick derived, the contract below it is the same contract every wake
 * has carried, and this sits between them saying what to look at within them.
 * The framing line is there because the wake is read by a session that did not
 * write the prompt: a rotation's successor has to be able to tell an
 * instruction its predecessor left standing from the operator's words this
 * turn, and to know where to go to replace or withdraw it.
 *
 * With no prompt on the row this contributes nothing at all, so a project that
 * never set one gets the wake exactly as it was.
 */
function seatTickPromptSection(monitorPrompt: string | null | undefined): string[] {
  if (!monitorPrompt) return [];
  return [
    "",
    "Standing monitor note for this project, in the seat's own words (seat_tick_settings sets, replaces and clears it). "
      + "It shapes what you look at; the contract below still governs what you do:",
    monitorPrompt,
  ];
}

export function seatTickWakeMessage(input: {
  project: string;
  reasons: readonly SeatTickWakeReason[];
  items: readonly SeatTickItem[];
  deferred: number;
  signals: readonly SeatTickSignalInput[];
  /** The project's own monitor prompt (#1280), or nothing. */
  monitorPrompt?: string | null;
}): string {
  const lines = [
    `Seat tick — ${input.project}.`,
    "",
    "Why you were woken:",
    ...input.reasons.map((reason) => `- ${reason.kind}: ${reason.detail}`),
    "",
    "Items:",
    ...input.items.map(seatTickBullet),
  ];
  if (input.deferred > 0) {
    lines.push(`(${input.deferred} more item(s) held back for the next wake.)`);
  }
  if (input.signals.length > 0) {
    lines.push("", "Signals:", ...input.signals.map((signal) => `- ${signal.label}`));
  }
  lines.push(...seatTickPromptSection(input.monitorPrompt));
  lines.push("", "Contract:", ...SEAT_TICK_CONTRACT.map((clause) => `- ${clause}`));
  return redactBounded(lines.join("\n"), SEAT_TICK_MESSAGE_LIMIT);
}

/**
 * The proactive brief: with nothing assigned, the Viewer gathers what a model
 * needs and the model does the ranking.
 *
 * The gathering is code and the judgement is the seat's, deliberately — #746
 * settled that the semantic call belongs to a model. Nothing here opens an
 * issue or a pipeline: the proposal lands as one board card the operator moves
 * to `assigned` when they want it, and that move is what starts the work.
 */
export function seatTickProposalMessage(input: {
  project: string;
  issues: readonly ProposalIssue[];
  signals: readonly SeatTickSignalInput[];
  items: number;
  slot: string;
  /** The project's own monitor prompt (#1280), or nothing. The proposal slot is
      a scheduler-fired wake like any other, so a note about what this project's
      monitor should look at is owed here too — a prompt that silently went
      missing on the one tick that asks the seat to rank the whole board would
      be the same gap in a smaller place. */
  monitorPrompt?: string | null;
}): string {
  const lines = [
    `Seat tick — ${input.project}. No lane is open and no board task is waiting, and the proposal slot is due.`,
    "",
    "Open issues:",
    ...(input.issues.length > 0
      ? input.issues.map((issue) => `- #${issue.number} ${issue.title}${issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""}`)
      : ["- (none readable; rank from the board and the signals below)"]),
  ];
  if (input.signals.length > 0) {
    lines.push("", "Signals:", ...input.signals.map((signal) => `- ${signal.label}`));
  }
  lines.push(
    "",
    `Produce ONE ranked list of at most ${input.items} actions, each with the evidence behind it, and post it as a single board card in inbox for this project.`,
    "Rank by what actually matters now: what is blocking, what is cheap and finishes something, what has been waiting longest.",
    `Put this exact line at the foot of the card so the next tick recognizes it: ${MONITOR_REF_PREFIX} ${seatTickProposalRef(input.slot)}`,
    "Open no GitHub issue and start no pipeline from this — the operator moves a card to assigned when they want it, and the next tick starts it.",
    ...seatTickPromptSection(input.monitorPrompt),
    "",
    "Contract:",
    ...SEAT_TICK_CONTRACT.map((clause) => `- ${clause}`),
  );
  return redactBounded(lines.join("\n"), SEAT_TICK_MESSAGE_LIMIT);
}
