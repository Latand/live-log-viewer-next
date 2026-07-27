"use client";

import type { AttachmentStatus } from "@/components/imageAttachments";

/**
 * One composer state per conversation, shared by every rendering of it (#691 §5, U2).
 *
 * The card and the floater are two renderings of one conversation, and the operator
 * may type in either. Component state cannot express that: two textareas backed by
 * two `useState` calls are two drafts that happen to look alike until one of them
 * is sent. So the draft is lifted out of React entirely — the same shape
 * `codexRealtimeClient` already uses for the call — and both renderings subscribe.
 *
 * The idempotency key is here for the same reason and matters more. A send is
 * identified by *which draft* it is sending, so a race between the floater's Send
 * and the card's Send has to resolve to one delivery. Deriving the key from the
 * draft's content and a per-draft epoch makes that structural: both buttons reading
 * the same store at the same moment can only compute the same key, and the outbox
 * that key flows into already refuses a duplicate.
 *
 * Deliberately not persistent. The durable half of a message is the outbox, which
 * already survives reload; this holds an unsent draft and staged tiles, which is a
 * pane of glass, not a record.
 */

/** The subset of a staged attachment both renderings need to render a tile. The
    `File` and object-URL ownership stay with the owning tree — those are resources
    with a lifetime, and two documents cannot both revoke one object URL. */
export interface SharedAttachment {
  id: string;
  status: AttachmentStatus;
  name: string;
  mime: string;
  preview: string;
  error?: string;
}

export interface ComposerSnapshot {
  draft: string;
  attachments: readonly SharedAttachment[];
}

export interface ComposerStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ComposerSnapshot;
  setDraft(draft: string): void;
  setAttachments(attachments: readonly SharedAttachment[]): void;
  /**
   * Adopt a draft the owning tree persisted, unless this store already holds an
   * edit. A remounting card offering its `sessionStorage` draft must not overwrite
   * what the operator just typed in the floater — the remount is the older event.
   */
  hydrate(draft: string): void;
  /** The idempotency key for the current draft, or null when there is nothing to
      send. Stable while the draft is; re-keyed the moment it changes. */
  sendKey(): string | null;
  /** Record that `key` was handed to the outbox: clears the draft and its tiles.
      A stale key is ignored, so a late duplicate Send does nothing. */
  commitSend(key: string): void;
  /**
   * Publish the card's real delivery so the floater can use it.
   *
   * §4 rule 5 says every send flows through the existing queue-first outbox, and
   * that outbox lives in the card's tree with its receipts, its admission handling
   * and its history. The floater must therefore *borrow* the card's send rather
   * than own one — a PiP-specific send route would be a second delivery path, which
   * is precisely how one draft becomes two messages.
   */
  registerSender(send: () => void): () => void;
  /** Deliver the current draft through the registered sender. A no-op when no card
      is mounted: the floater cannot invent a delivery path of its own. */
  send(): void;
  /**
   * Publish the card's real attachment tray.
   *
   * The tray owns things the store cannot: the `File` objects, and the object-URL
   * lifetimes that have to be revoked exactly once. Two trays would mean two
   * revocations and, worse, two sets of bytes for one staged image — so the
   * floater renders the tiles and asks the tray to act, exactly as it borrows the
   * card's send rather than owning one.
   */
  registerAttachmentOwner(owner: ComposerAttachmentOwner): () => void;
  /** Drop one staged attachment through the card's tray. No-op with no card. */
  removeAttachment(id: string): void;
  /** Drop every staged attachment through the card's tray. */
  clearAttachments(): void;
}

export interface ComposerAttachmentOwner {
  remove(id: string): void;
  clearAll(): void;
}

const EMPTY: ComposerSnapshot = { draft: "", attachments: [] };

function createStore(conversationId: string): ComposerStore {
  const listeners = new Set<() => void>();
  let snapshot: ComposerSnapshot = EMPTY;
  let touched = false;
  /* Bumped on every send so a re-typed identical draft is a new message rather
     than a replay of the one just delivered. */
  let epoch = 0;
  /* The card's delivery and its attachment tray, while a card is mounted. Not part
     of the snapshot: they are capabilities, not something either rendering
     displays. */
  let sender: (() => void) | null = null;
  let attachmentOwner: ComposerAttachmentOwner | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const commit = (next: ComposerSnapshot): void => {
    snapshot = next;
    notify();
  };

  const key = (): string | null => {
    const { draft, attachments } = snapshot;
    if (!draft.trim() && attachments.length === 0) return null;
    /* Content-derived rather than random: two Send buttons pressed in the same
       tick must compute the same string without coordinating. */
    const fingerprint = `${conversationId}:${epoch}:${draft}:${attachments.map((entry) => entry.id).join(",")}`;
    return `composer_${hash(fingerprint)}`;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setDraft(draft) {
      touched = true;
      if (draft === snapshot.draft) return;
      commit({ ...snapshot, draft });
    },
    setAttachments(attachments) {
      touched = true;
      const next = [...attachments];
      if (next.length === snapshot.attachments.length
        && next.every((entry, index) => {
          const current = snapshot.attachments[index]!;
          return entry.id === current.id
            && entry.status === current.status
            && entry.preview === current.preview
            && entry.error === current.error;
        })) {
        return;
      }
      commit({ ...snapshot, attachments: next });
    },
    hydrate(draft) {
      if (touched) return;
      touched = true;
      if (draft === snapshot.draft) return;
      commit({ ...snapshot, draft });
    },
    sendKey: key,
    commitSend(sent) {
      if (sent !== key()) return;
      epoch += 1;
      touched = false;
      commit(EMPTY);
    },
    registerSender(send) {
      /* Last registration wins. A card remount registers before the outgoing one
         unregisters, so a naive "clear on unregister" would leave the floater with
         no sender at all; only the still-current registration may clear it. */
      sender = send;
      return () => {
        if (sender === send) sender = null;
      };
    },
    send() {
      sender?.();
    },
    registerAttachmentOwner(owner) {
      /* Same last-one-wins discipline, for the same remount ordering. */
      attachmentOwner = owner;
      return () => {
        if (attachmentOwner === owner) attachmentOwner = null;
      };
    },
    removeAttachment(id) {
      attachmentOwner?.remove(id);
    },
    clearAttachments() {
      attachmentOwner?.clearAll();
    },
  };
}

/** Small, stable, non-cryptographic: this names a draft to an outbox in one tab,
    not a secret. FNV-1a keeps it dependency-free and identical across documents. */
function hash(value: string): string {
  let accumulator = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    accumulator ^= value.charCodeAt(index);
    accumulator = Math.imul(accumulator, 0x01000193) >>> 0;
  }
  return accumulator.toString(36).padStart(7, "0");
}

const stores = new Map<string, ComposerStore>();

/** The one store for this conversation, created on first ask. Same resolution rule
    as `codexRealtimeClient`, so the composer and the call cannot disagree about
    which conversation a rendering belongs to. */
export function composerStore(conversationId: string): ComposerStore {
  const existing = stores.get(conversationId);
  if (existing) return existing;
  const store = createStore(conversationId);
  stores.set(conversationId, store);
  return store;
}

/** Tests only. Production never forgets a draft the operator is still typing. */
export function resetComposerStoresForTest(): void {
  stores.clear();
}
