import { nativeQueueInputMatches } from "@/lib/runtime/nativeQueueContent";
import type { RuntimeOperationCommand } from "@/lib/runtime/contracts";
import type { Database } from "bun:sqlite";
import type { NativeQueueCommand, NativeQueueRecord, NativeQueueTransition } from "@/lib/runtime/nativeQueueContracts";
import { sameNativeQueueBinding } from "@/lib/runtime/nativeQueueContracts";

/** Called inside the journal's admission/transition transaction. No transport. */
export class NativeQueueJournal {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_queue_entries (
      entry_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS native_queue_conversation ON native_queue_entries(conversation_id);`);
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
  }

  admit(command: NativeQueueCommand, operationId: string): NativeQueueRecord | null {
    if (command.action === "reorder") return null;
    let entry: NativeQueueRecord;
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
      if (command.action === "update") entry.revision = entry.versions.length + 1;
      entry.mutationOperationId = operationId;
    }
    if (command.action === "add" || command.action === "update") {
      entry.versions.push({ revision: entry.revision, operationId, text: command.text!, images: command.images ?? [],
        contentDigest: command.contentDigest!, ...(command.runtime ? { requestedRuntime: command.runtime } : {}),
        ...(command.selectedContext ? { selectedContext: command.selectedContext } : {}), ...(command.origin ? { origin: command.origin } : {}) });
    }
    this.save(entry);
    return entry;
  }

  transition(command: NativeQueueCommand, operationId: string, transition: NativeQueueTransition): NativeQueueRecord | null {
    if (command.action === "reorder") return null;
    const entry = this.get(command.action === "add" ? operationId : command.entryId!);
    if (entry.conversationId !== command.conversationId || !sameNativeQueueBinding(entry.binding, command.binding)) throw new Error("native queue entry ownership changed");
    if (transition.phase === "removed") {
      if (entry.state !== "removed" || entry.proof || entry.mutationOperationId) throw new Error("native queue removal is unproven");
      return entry;
    }
    if (transition.phase === "proven") {
      const proof = transition.proof;
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
        if (command.action === "update") entry.revision = entry.versions.at(-2)!.revision;
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
