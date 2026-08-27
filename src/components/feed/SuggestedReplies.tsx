"use client";

import { useEffect, useState } from "react";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import {
  MAX_REPLY_SUGGESTIONS,
  type ReplySuggestion,
  type ReplySuggestionOrigin,
  type ReplySuggestionSetV1,
} from "@/lib/suggestions/types";
import type { FileEntry } from "@/lib/types";

import type { OutboxEntry } from "../conversation/outbox";
import { appendComposerDraft } from "../TmuxComposer";
import type { FeedEntry } from "./parse";

/**
 * The manager's reply drafts, as pills the operator answers with (#1202).
 *
 * One more render-time projection over the conversation the surface already
 * shows — the shape the mandate card took in #1166: the record says what was
 * offered, the feed says whether it still stands, and the pills are what the
 * two of them come to together. Which is why nothing here polls: the dock and
 * the board pane already stream the transcript, and `revision` changes with it,
 * so a set is fetched exactly when the conversation moved.
 *
 * A pill inserts its draft through the composer's OWN seam — the stored draft
 * plus the compose event every mounted composer for that conversation listens
 * for — so the text lands in the field the operator is looking at, focused,
 * caret at the end, joined to whatever they had already typed. It is never
 * sent: the operator reads it, edits it if they want, and presses send.
 */

export interface SuggestedRepliesProps {
  file: FileEntry;
  /** Changes whenever this conversation's transcript did. The set is re-read
      on each change and never on a timer of its own. */
  revision: string;
  /** The feed's own rows, for the one projection that hides a set: the
      operator has already answered. */
  items?: readonly FeedEntry[];
  /** Messages submitted but not yet echoed by the transcript — the operator's
      answer counts the instant they press send, not a poll later. */
  outbox?: readonly OutboxEntry[];
  /** Pinned above the composer because the latest turn is scrolled out of
      view, rather than sitting in the feed under it. */
  floating?: boolean;
}

/* Last answer per conversation, so a set that the operator already retired
   never flashes back while a fresh read is in flight. */
const cache = new Map<string, ReplySuggestionSetV1 | null>();
const inFlight = new Map<string, Promise<ReplySuggestionSetV1 | null>>();
/* The transcript state each conversation was last read at, so the two mounted
   surfaces and a re-render share one read per change instead of one each. */
const readRevisions = new Map<string, string>();
const lastReadAt = new Map<string, number>();

/**
 * The floor between two reads of the same conversation. A busy turn grows the
 * transcript many times a second and every one of those changes is a reason to
 * look — but not a reason to look again 40 ms later. The read is still driven
 * by the stream: this only collapses a burst into its trailing read, so a set
 * offered mid-turn appears within about this long and a quiet conversation
 * costs nothing at all.
 */
const MIN_READ_INTERVAL_MS = 1_500;

/** The origin the server wrote, read as-is. The renderer shows the drafts
    either way, so an unrecognised label reads as unidentified rather than
    being upgraded to the manager the surface would like it to be. */
function parseOrigin(value: unknown): ReplySuggestionOrigin {
  const origin = (value ?? {}) as Record<string, unknown>;
  const kind = origin.kind;
  return {
    kind: kind === "manager" || kind === "gateway" || kind === "agent" ? kind : "unidentified",
    conversationId: typeof origin.conversationId === "string" ? origin.conversationId : null,
    role: typeof origin.role === "string" ? origin.role : null,
  };
}

function parseReply(value: unknown): ReplySuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { label, text } = value as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim()) return null;
  if (typeof text !== "string" || !text.trim()) return null;
  return { label, text };
}

/** The server's answer, believed only as far as it parses: a malformed set
    renders as no suggestions rather than as a broken row. */
export function parseReplySuggestionSet(value: unknown): ReplySuggestionSetV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const set = value as Record<string, unknown>;
  if (typeof set.conversationId !== "string" || typeof set.setId !== "string") return null;
  if (typeof set.at !== "string" || !Number.isFinite(Date.parse(set.at))) return null;
  if (!Array.isArray(set.replies)) return null;
  const replies = set.replies.map(parseReply).filter((reply): reply is ReplySuggestion => reply !== null);
  if (replies.length === 0) return null;
  return {
    conversationId: set.conversationId,
    setId: set.setId,
    at: set.at,
    origin: parseOrigin(set.origin),
    replies: replies.slice(0, MAX_REPLY_SUGGESTIONS),
  };
}

function tsMs(ts: unknown): number | null {
  if (typeof ts !== "string" && typeof ts !== "number") return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When the operator last spoke in this conversation — a transcript row of
 * their own, or a message they submitted that has not echoed yet. A set older
 * than that answer is over, whatever the record still holds.
 */
export function latestOperatorMessageAt(
  items: readonly FeedEntry[] = [],
  outbox: readonly OutboxEntry[] = [],
): number | null {
  let latest: number | null = null;
  for (const { item } of items) {
    if (item.kind !== "user") continue;
    const ms = tsMs(item.ts);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  for (const entry of outbox) {
    if (typeof entry.at === "number" && (latest === null || entry.at > latest)) latest = entry.at;
  }
  return latest;
}

function suggestionsUrl(conversationId: string): string {
  return `/api/log/suggestions?conversationId=${encodeURIComponent(conversationId)}`;
}

/**
 * The conversation moved and the record could not be read at its new state.
 *
 * The previous answer is NOT the answer to this question: the last thing that
 * read cleanly belonged to an earlier turn, and showing it under a newer
 * message offers the operator drafts for something nobody asked. So the row
 * goes quiet and the conversation is marked unread, which lets the next change
 * — or the next surface to mount — try again.
 */
function unreadable(conversationId: string, revision: string): ReplySuggestionSetV1 | null {
  if (readRevisions.get(conversationId) !== revision) return cache.get(conversationId) ?? null;
  cache.set(conversationId, null);
  readRevisions.delete(conversationId);
  return null;
}

async function readSet(conversationId: string, revision: string): Promise<ReplySuggestionSetV1 | null> {
  const key = `${conversationId}\n${revision}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (readRevisions.get(conversationId) === revision) return cache.get(conversationId) ?? null;
  readRevisions.set(conversationId, revision);
  lastReadAt.set(conversationId, Date.now());
  const request = (async () => {
    try {
      const response = await fetch(suggestionsUrl(conversationId));
      if (!response.ok) return unreadable(conversationId, revision);
      const body = await response.json() as { set?: unknown };
      const parsed = parseReplySuggestionSet(body.set);
      if (readRevisions.get(conversationId) !== revision) return cache.get(conversationId) ?? null;
      cache.set(conversationId, parsed);
      return parsed;
    } catch {
      /* Quiet: a failed read renders exactly like a conversation with no
         drafts, which is the ordinary case. */
      return unreadable(conversationId, revision);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}

function useReplySuggestions(conversationId: string | null, revision: string): ReplySuggestionSetV1 | null {
  const [set, setSet] = useState<ReplySuggestionSetV1 | null>(
    () => (conversationId ? cache.get(conversationId) ?? null : null),
  );
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    const read = () => {
      void readSet(conversationId, revision).then((next) => {
        if (alive) setSet(next);
      });
    };
    const since = Date.now() - (lastReadAt.get(conversationId) ?? 0);
    if (since >= MIN_READ_INTERVAL_MS) {
      read();
      return () => { alive = false; };
    }
    /* Trailing read, not a poll: it fires once for this change and nothing
       reschedules it. */
    const timer = setTimeout(read, MIN_READ_INTERVAL_MS - since);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [conversationId, revision]);
  return conversationId && set?.conversationId === conversationId ? set : null;
}

export function SuggestedReplies({ file, revision, items, outbox, floating = false }: SuggestedRepliesProps) {
  const { t } = useLocale();
  const conversationId = file.conversationId ?? null;
  const set = useReplySuggestions(conversationId, revision);
  const answeredAt = latestOperatorMessageAt(items, outbox);
  const offeredAt = set ? Date.parse(set.at) : Number.NaN;
  const answered = Boolean(set) && Number.isFinite(offeredAt) && answeredAt !== null && answeredAt > offeredAt;

  /* The operator answered: the drafts are stale the moment they did, so the row
     goes with the message rather than waiting under a question that is over.
     Nothing is written from here — the send path itself retires the durable
     record, for the set that was standing when the message was accepted, so a
     pane that is closed, unmounted or slow changes nothing about it. This only
     forgets the local copy, so a remount does not flash it back. */
  useEffect(() => {
    if (!answered || !set || !conversationId) return;
    if (cache.get(conversationId)?.setId === set.setId) cache.set(conversationId, null);
  }, [answered, set, conversationId]);

  if (!set || answered) return null;
  const cardId = conversationIdentity(file);
  return (
    <div
      /* The placement is part of the contract, not decoration: the drafts are
         offered under the latest turn, or pinned above the composer once that
         turn is no longer what the operator is looking at — never both. */
      data-reply-suggestions={floating ? "floating" : "inline"}
      role="group"
      aria-label={t("composer.suggestedReplies")}
      /* Wraps AND scrolls: on a phone three drafts become two rows rather than
         a horizontal page, and a long single row can still be swiped. */
      className={`flex min-w-0 flex-wrap items-center gap-1.5 overflow-x-auto ${
        floating
          ? "rounded-surface border border-border bg-raised/95 p-1.5 shadow-2 backdrop-blur-sm"
          : "mt-2"
      }`}
    >
      {set.replies.map((reply, index) => (
        <button
          key={`${set.setId}:${index}`}
          type="button"
          data-reply-suggestion
          title={reply.text}
          onClick={() => appendComposerDraft(cardId, reply.text)}
          className="inline-flex max-w-full shrink-0 items-center rounded-full border border-border bg-raised px-2.5 py-1 text-label font-semibold text-primary [@media(pointer:coarse)]:min-h-11 hover:border-accent/50 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="truncate">{reply.label}</span>
        </button>
      ))}
    </div>
  );
}
