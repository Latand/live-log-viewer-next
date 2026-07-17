import { canonicalizeConversationId, currentConversationFile, withoutArchivedPredecessors } from "@/lib/accounts/identity";
import { groupDirectReviewers, taskOwnerResolver } from "@/lib/flows/directReviewGrouping";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import { shortTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

/*
 * Deterministic role titles for Viewer-spawned workers (issue #325 §titles).
 *
 * A worker spawned through /api/spawn never has a human-authored title: the
 * scanner falls back to the literal «Codex session»/«Claude session», or picks
 * up the head of the machine-authored spawn prompt («You are a Builder in tdd
 * mode…»). This projection derives a presentation title from the durable data
 * instead:
 *
 *   builder / architect / verifier / …  →  «<task subject> — <role>»
 *   reviewer                            →  «<reviewed subject> — reviewer R<n>»
 *
 * The subject comes from the owning board task's first line (issue number
 * included), falling back for reviewers to the reviewed conversation's own
 * title and finally to the reviewed conversation id tail. Review rounds take
 * the SAME numbering the round deck renders: the durable flow membership for
 * managed loops, the claiming flow's round for legacy claimed reviewers, and
 * the shared grouping core (lib/flows/directReviewGrouping) for direct
 * one-shot reviewers — so a card's title and its deck spine can never
 * disagree.
 *
 * This is a read model, exactly like the issue #33 custom-title projection:
 * native transcripts are never rewritten, and an explicit user rename keeps
 * final precedence (the role title then becomes its Reset base).
 */

/** Scanner fallbacks that carry no information — always worth replacing. */
const GENERIC_SESSION_TITLES = new Set(["Codex session", "Claude session"]);

const SUBJECT_MAX = 48;

/** `shortTitle` with issue references kept intact: `cleanTitle` strips `#` as
    a markdown heading marker, but `#325` in a subject is the issue number —
    the most load-bearing token of the whole title. */
function subjectShortTitle(value: string, maxLength: number): string {
  const guarded = value.replace(/#(?=\d)/g, "\u{E000}");
  return shortTitle(guarded, maxLength).replace(/\u{E000}/gu, "#");
}

/** Concise human subject of a board task: its first non-empty line, leading
    emoji/bullets stripped (the issue number survives), bounded for a title. */
export function taskSubjectLabel(task: Pick<BoardTask, "text">): string | null {
  const firstLine = task.text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const stripped = firstLine.replace(/^[^#\p{L}\p{N}]+/u, "");
  const cleaned = subjectShortTitle(stripped, SUBJECT_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

export interface RoleTitleInput {
  files: readonly FileEntry[];
  /** Real (server) flows — round numbers for claimed reviewers. */
  flows: readonly Flow[];
  tasks?: readonly BoardTask[];
  /** Durable registry alias map (old id → canonical id). */
  conversationAliases?: Readonly<Record<string, string>>;
}

function reviewedIdTail(reviewedId: string): string {
  return reviewedId.replace(/^conversation_/, "").slice(0, 8);
}

/**
 * Derives the role titles as a pure `path → title` map. Only current
 * generations of role-carrying claude/codex conversations are titled;
 * everything else — archived predecessors, subagents, role-less sessions —
 * is left to the regular title pipeline.
 */
export function deriveRoleSessionTitles(input: RoleTitleInput): Map<string, string> {
  const aliases = input.conversationAliases ?? {};
  const canonical = (id: string) => canonicalizeConversationId(id, aliases);
  const visible = withoutArchivedPredecessors([...input.files]);
  const taskFor = taskOwnerResolver(input.tasks ?? []);

  /* Direct one-shot review rounds via the shared grouping core: the round
     number is the member's position in its task/subject group, and the group's
     task doubles as the subject source. */
  const directRound = new Map<string, { n: number; task: BoardTask | null }>();
  const groups = groupDirectReviewers({ files: input.files, flows: input.flows, tasks: input.tasks, conversationAliases: aliases });
  for (const group of groups) {
    group.members.forEach((member, index) => {
      directRound.set(member.file.path, { n: index + 1, task: group.task });
    });
  }

  /* Legacy claimed reviewers (a real flow round holds the path but no durable
     membership exists): number by the claiming round. */
  const flowRoundByPath = new Map<string, number>();
  for (const flow of input.flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath) flowRoundByPath.set(round.reviewerPath, round.n);
    }
  }

  const subjectOfTask = (task: BoardTask | null) => (task ? taskSubjectLabel(task) : null);

  /* Reviewed-conversation subject fallback reads titles BEFORE any overlay of
     this projection mutates them, so processing order cannot change output. */
  const reviewedSubject = (reviewedId: string): string => {
    const reviewed = currentConversationFile(visible, reviewedId);
    if (reviewed && !GENERIC_SESSION_TITLES.has(reviewed.title)) {
      const cleaned = subjectShortTitle(reviewed.title, SUBJECT_MAX);
      if (cleaned.length > 0) return cleaned;
    }
    return reviewedIdTail(reviewedId);
  };

  const titles = new Map<string, string>();
  for (const file of visible) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    const lineage = file.durableLineage;
    const role = lineage?.role;
    if (!lineage || !role) continue;

    if (role === "reviewer" && lineage.reviewsConversationId) {
      const reviewedId = canonical(lineage.reviewsConversationId);
      const direct = directRound.get(file.path);
      const membershipRound = lineage.memberships.find(
        (membership) => membership.role === "reviewer" && membership.round !== null,
      )?.round ?? null;
      const round = direct?.n ?? membershipRound ?? flowRoundByPath.get(file.path) ?? null;
      const ownerTask = direct !== undefined
        ? direct.task
        : taskFor(file.conversationId ? canonical(file.conversationId) : null, file.path) ?? taskFor(reviewedId, null);
      const subject = subjectOfTask(ownerTask) ?? reviewedSubject(reviewedId);
      titles.set(file.path, round === null ? `${subject} — reviewer` : `${subject} — reviewer R${round}`);
      continue;
    }

    /* Non-review roles (and a reviewer edge without a subject): the concise
       task-plus-role form. Without an owning task there is nothing meaningful
       to derive — the stable fallback is the untouched scan title. */
    const ownerTask = taskFor(file.conversationId ? canonical(file.conversationId) : null, file.path);
    const subject = subjectOfTask(ownerTask);
    if (subject) titles.set(file.path, `${subject} — ${role}`);
  }
  return titles;
}

/**
 * Applies the derived titles in place. Runs AFTER the custom-title overlay
 * (issue #33): an entry whose title a user explicitly renamed — signalled by
 * the preserved `autoTitle` — keeps the rename, and the role title replaces
 * its Reset base instead. An untouched entry gets the role title directly and
 * `autoTitle` stays unset, so the rename UI never reads a derived title as a
 * user override.
 */
export function overlayRoleSessionTitles(input: RoleTitleInput): void {
  const titles = deriveRoleSessionTitles(input);
  if (!titles.size) return;
  for (const file of input.files) {
    const title = titles.get(file.path);
    if (title === undefined) continue;
    if (file.autoTitle !== undefined) file.autoTitle = title;
    else file.title = title;
  }
}
