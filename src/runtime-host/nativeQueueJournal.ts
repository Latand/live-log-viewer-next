import { nativeQueueInputMatches } from "@/lib/runtime/nativeQueueContent";
import type { RuntimeOperationCommand } from "@/lib/runtime/contracts";
import type { Database } from "bun:sqlite";
import type { NativeQueueCommand, NativeQueueCompactedProof, NativeQueueProof, NativeQueueRecord, NativeQueueTransition, NativeQueueVersion } from "@/lib/runtime/nativeQueueContracts";
import { sameNativeQueueBinding } from "@/lib/runtime/nativeQueueContracts";

const SETTLED_STATES = ["delivered", "removed", "refused"] as const;

/**
 * The operation ids an entry still has to be answered through (#1664).
 *
 * An unsettled entry is proven, removed or refused through its add
 * operation, and an unresolved edit/delete/start/send-now keeps its own
 * mutation id as the fence nothing else may cross. Journal compaction drops
 * operation rows once their effect stops being `pending`, which native
 * admission reaches long before canonical delivery is seen, so these ids are
 * held explicitly.
 * A settled entry holds nothing: its answer is already recorded on the entry.
 */
function heldOperationIds(entry: NativeQueueRecord): string[] {
  if ((SETTLED_STATES as readonly string[]).includes(entry.state)) return [];
  return entry.mutationOperationId && entry.mutationOperationId !== entry.entryId
    ? [entry.entryId, entry.mutationOperationId]
    : [entry.entryId];
}

/**
 * Whether this command is about ONE entry of the journal's.
 *
 * A reorder names native submission ids and no Viewer entry. A start may name
 * one — the withdrawn payload's recovery, and the queued row's `send now` on an
 * idle thread — or none at all, which is native's own queue-level start
 * (`ThreadQueueStartParams.queuedSubmissionId` is nullable). Neither of the
 * entry-less forms has a version to admit or a state to move.
 */
function entryTargeted(command: NativeQueueCommand): boolean {
  if (command.action === "reorder") return false;
  return command.action === "add" || command.entryId !== undefined;
}

/** Called inside the journal's admission/transition transaction. No transport. */
export class NativeQueueJournal {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_queue_entries (
      entry_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS native_queue_conversation ON native_queue_entries(conversation_id);
    CREATE TABLE IF NOT EXISTS native_queue_operation_holds (operation_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS native_queue_operation_holds_entry ON native_queue_operation_holds(entry_id);`);
    /* Rebuilt from the entries on every open, so a journal written before the
       holds existed gains them before its first compaction. Bounded like the
       entries it mirrors: at most two ids per unsettled entry, and admission
       refuses a conversation's 2001st unsettled entry. */
    db.exec(`BEGIN IMMEDIATE; DELETE FROM native_queue_operation_holds;
      INSERT OR IGNORE INTO native_queue_operation_holds(operation_id, entry_id)
        SELECT entry_id, entry_id FROM native_queue_entries WHERE json_extract(state_json, '$.state') NOT IN ('delivered', 'removed', 'refused');
      INSERT OR IGNORE INTO native_queue_operation_holds(operation_id, entry_id)
        SELECT json_extract(state_json, '$.mutationOperationId'), entry_id FROM native_queue_entries
        WHERE json_extract(state_json, '$.state') NOT IN ('delivered', 'removed', 'refused') AND json_extract(state_json, '$.mutationOperationId') IS NOT NULL;
      COMMIT;`);
  }

  /** True when this id names a retained entry, settled or not. */
  retains(operationId: string): boolean {
    return this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM native_queue_entries WHERE entry_id = ?").get(operationId) !== null;
  }

  read(conversationId: string): NativeQueueRecord[] {
    const open = this.db.query<{ state_json: string }, [string]>(`SELECT state_json FROM native_queue_entries
      WHERE conversation_id = ? AND json_extract(state_json, '$.state') NOT IN ('delivered', 'removed', 'refused') ORDER BY rowid LIMIT 2001`).all(conversationId);
    if (open.length > 2000) throw new Error("native queue unresolved entry bound exceeded");
    const terminal = this.db.query<{ state_json: string }, [string]>(`SELECT state_json FROM native_queue_entries
      WHERE conversation_id = ? AND json_extract(state_json, '$.state') IN ('delivered', 'removed', 'refused') ORDER BY rowid DESC LIMIT 128`).all(conversationId);
    return [...open, ...terminal.reverse()].map(row => JSON.parse(row.state_json) as NativeQueueRecord);
  }

  command(command: RuntimeOperationCommand, operationId: string): NativeQueueCommand | null {
    if (command.kind === "native-queue") return command;
    if (command.kind !== "send") return null;
    const row = this.db.query<{ state_json: string }, [string]>("SELECT state_json FROM native_queue_entries WHERE entry_id = ?").get(operationId);
    if (!row) return null;
    const entry = JSON.parse(row.state_json) as NativeQueueRecord;
    return { kind: "native-queue", action: "add", conversationId: command.conversationId, operationId,
      idempotencyKey: command.idempotencyKey, binding: entry.binding,
      text: command.text, images: command.images, contentDigest: command.contentDigest, runtime: command.runtime };
  }

  private get(id: string): NativeQueueRecord {
    const row = this.db.query<{ state_json: string }, [string]>("SELECT state_json FROM native_queue_entries WHERE entry_id = ?").get(id);
    if (!row) throw new Error("native queue entry is unknown");
    return JSON.parse(row.state_json) as NativeQueueRecord;
  }

  private save(entry: NativeQueueRecord): void {
    this.db.query("INSERT INTO native_queue_entries VALUES (?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET state_json = excluded.state_json")
      .run(entry.entryId, entry.conversationId, JSON.stringify(entry));
    this.db.query("DELETE FROM native_queue_operation_holds WHERE entry_id = ?").run(entry.entryId);
    for (const operationId of heldOperationIds(entry)) {
      this.db.query("INSERT OR IGNORE INTO native_queue_operation_holds(operation_id, entry_id) VALUES (?, ?)").run(operationId, entry.entryId);
    }
  }

  /** Canonical proof of one retained version; the same rule for every caller. */
  private prove(entry: NativeQueueRecord, proof: NativeQueueProof): void {
    const version = entry.versions.find(v => v.revision === proof.revision);
    if ((entry.dispatchedTurnId && proof.turnId !== entry.dispatchedTurnId) || !version?.input || proof.threadId !== entry.binding.threadId || proof.clientUserMessageId !== entry.clientUserMessageId
      || !proof.turnId || !proof.itemId || JSON.stringify(version.input) !== JSON.stringify(proof.input)) throw new Error("native queue canonical proof mismatch");
    if (entry.proof && JSON.stringify(entry.proof) !== JSON.stringify(proof)) throw new Error("native queue canonical proof conflict");
    entry.proof = proof;
    entry.dispatchedRevision = proof.revision;
    entry.dispatchedTurnId = proof.turnId;
    entry.state = "delivered";
    if (entry.mutationOperationId === entry.entryId) entry.mutationOperationId = null;
    // An in-flight edit/delete retains its own mutation identity until it answers.
    entry.reason = null;
  }

  /**
   * Settles an entry whose add operation journal compaction already removed
   * (#1664), on canonical proof alone. Nothing executable is created: no
   * operation, no effect, no key. The caller has already established that no
   * operation row exists for `entryId`.
   *
   * Narrower than the operation path on purpose, because no receipt is left to
   * cross-check against: the entry must be the add's own identity, awaiting
   * proof, under the same conversation and binding, with no other mutation
   * holding it, and the proof must name exactly the version it would dispatch.
   * Anything else leaves the entry exactly as it was.
   */
  proveCompacted(request: NativeQueueCompactedProof): { entry: NativeQueueRecord; replayed: boolean } {
    const entry = this.get(request.entryId);
    if (entry.entryId !== request.entryId || entry.clientUserMessageId !== entry.entryId) throw new Error("native queue entry is not an original add identity");
    if (entry.conversationId !== request.conversationId || !sameNativeQueueBinding(entry.binding, request.binding)) throw new Error("native queue entry ownership changed");
    if (entry.proof) {
      if (JSON.stringify(entry.proof) !== JSON.stringify(request.proof)) throw new Error("native queue canonical proof conflict");
      return { entry, replayed: true };
    }
    if (entry.state !== "admitted" && entry.state !== "queued" && entry.state !== "dispatching" && entry.state !== "uncertain") {
      throw new Error("native queue entry is not awaiting canonical proof");
    }
    if (entry.mutationOperationId && entry.mutationOperationId !== entry.entryId) throw new Error("native queue entry has an unresolved mutation");
    if (request.proof.revision !== (entry.dispatchedRevision ?? entry.revision)) throw new Error("native queue canonical proof names another version");
    this.prove(entry, request.proof);
    this.save(entry);
    return { entry, replayed: false };
  }

  admit(command: NativeQueueCommand, operationId: string): NativeQueueRecord | null {
    if (!entryTargeted(command)) return null;
    let entry: NativeQueueRecord;
    let base: NativeQueueVersion | undefined;
    if (command.action === "add") {
      if (this.read(command.conversationId).filter(entry => !["delivered", "removed", "refused"].includes(entry.state)).length >= 2000) throw new Error("native queue admission bound exceeded");
      entry = { entryId: operationId, conversationId: command.conversationId, binding: command.binding,
        clientUserMessageId: operationId, nativeSubmissionId: null, revision: 1, versions: [],
        profilePolicy: "thread-at-dispatch", state: "admitted", mutationOperationId: operationId, dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null };
    } else {
      entry = this.get(command.entryId!);
      if (entry.conversationId !== command.conversationId || !sameNativeQueueBinding(entry.binding, command.binding)) throw new Error("native queue entry ownership changed");
      if (entry.revision !== command.expectedRevision) throw new Error("native queue entry revision changed");
      if (entry.mutationOperationId || (entry.state !== "queued" && entry.state !== "withdrawn")) throw new Error("native queue entry is frozen or unresolved");
      if (entry.state === "withdrawn" && command.action !== "start") throw new Error("withdrawn input requires an explicit idle start");
      if (command.action === "update" && entry.versions.length >= 128) throw new Error("native queue retained edit bound exceeded");
      /* The version this edit is a revision OF, resolved BEFORE the counter
         moves. It is what an edit that names no attachments and no provenance
         carries forward, so changing the words of a message never silently
         throws its images, its selected card or its authorship away (#1629). */
      base = entry.versions.find(version => version.revision === entry.revision);
      if (command.action === "update") entry.revision = entry.versions.length + 1;
      entry.mutationOperationId = operationId;
    }
    if (command.action === "add" || command.action === "update") {
      /* CONTENT IS THE CALLER'S AND IS NEVER RECONSTRUCTED HERE. `contentDigest`
         was computed over exactly the text and refs the command carries, so
         silently substituting a prior version's attachments would produce a
         payload whose digest describes something else. An edit that drops them
         is refused instead, and the control that offers it carries them. */
      if (command.action === "update" && base?.images.length && !command.images?.length) {
        throw new Error("native queue edit must carry the entry's attachments");
      }
      entry.versions.push({ revision: entry.revision, operationId, text: command.text!, images: command.images ?? [],
        contentDigest: command.contentDigest!, ...(command.runtime ? { requestedRuntime: command.runtime } : {}),
        ...(command.selectedContext ?? base?.selectedContext ? { selectedContext: (command.selectedContext ?? base?.selectedContext)! } : {}),
        ...(command.origin ?? base?.origin ? { origin: (command.origin ?? base?.origin)! } : {}) });
    }
    this.save(entry);
    return entry;
  }

  transition(command: NativeQueueCommand, operationId: string, transition: NativeQueueTransition): NativeQueueRecord | null {
    if (!entryTargeted(command)) return null;
    const entry = this.get(command.action === "add" ? operationId : command.entryId!);
    if (entry.conversationId !== command.conversationId || !sameNativeQueueBinding(entry.binding, command.binding)) throw new Error("native queue entry ownership changed");
    if (transition.phase === "removed") {
      if (entry.state !== "removed" || entry.proof || entry.mutationOperationId) throw new Error("native queue removal is unproven");
      return entry;
    }
    if (transition.phase === "proven") {
      this.prove(entry, transition.proof);
      this.save(entry);
      return entry;
    }
    if (entry.mutationOperationId !== operationId) throw new Error("native queue mutation ownership changed");
    const version = entry.versions.find(v => v.revision === entry.revision)!;
    if (transition.phase === "observed-queued") {
      const observed = transition.submission;
      if ((command.action !== "add" && command.action !== "update") || !version.input
        || !observed.id || observed.clientUserMessageId !== entry.clientUserMessageId
        || (entry.nativeSubmissionId && entry.nativeSubmissionId !== observed.id)
        || !nativeQueueInputMatches(version, observed.input)) throw new Error("native queue observation conflicts with the frozen input");
      transition = { phase: "acknowledged", nativeSubmissionId: observed.id };
    }
    if (transition.phase === "prepared") {
      if (!Array.isArray(transition.input) || transition.input.length === 0) throw new Error("native queue input is invalid");
      if (version.input && JSON.stringify(version.input) !== JSON.stringify(transition.input)) throw new Error("native queue prepared payload changed");
      version.input = transition.input;
    } else if (transition.phase === "withdrawn") {
      if (command.action !== "send-now") throw new Error("native queue withdrawal is invalid");
      if (!entry.proof) entry.state = "withdrawn";
    } else if (transition.phase === "uncertain") {
      if (!entry.proof) entry.state = "uncertain";
      entry.reason = transition.reason;
      // Keep the unresolved mutation fence. No new key can retry it.
    } else if (transition.phase === "refused") {
      if (!entry.proof) {
        if (command.action === "add") entry.state = "refused";
        /* Back to the revision this edit was a revision OF, which the command
           carries and the admission validated against the entry. Counting back
           through `versions` instead reached into REFUSED history: every
           attempt appends a version, so a second consecutive refusal landed on
           the first refused one and presented — and would have dispatched —
           text native never accepted (#1629). */
        if (command.action === "update") entry.revision = command.expectedRevision!;
      }
      entry.reason = transition.reason;
      entry.mutationOperationId = null;
    } else {
      if (command.action === "add" || command.action === "update") {
        if (!transition.nativeSubmissionId || (entry.nativeSubmissionId && entry.nativeSubmissionId !== transition.nativeSubmissionId)) throw new Error("native queue submission identity changed");
        entry.nativeSubmissionId = transition.nativeSubmissionId;
        if (!entry.proof) entry.state = "queued";
      } else if (command.action === "delete") {
        if (!entry.proof) entry.state = transition.deleted === true ? "removed" : "uncertain";
      } else if (command.action === "start" || command.action === "send-now") {
        if (!transition.turnId) throw new Error("native queue dispatch has no turn identity");
        if (!entry.proof) entry.state = "dispatching";
        entry.dispatchedRevision ??= entry.revision;
        entry.dispatchedTurnId ??= transition.turnId;
      }
      entry.mutationOperationId = null;
      entry.reason = null;
    }
    this.save(entry);
    return entry;
  }
}
