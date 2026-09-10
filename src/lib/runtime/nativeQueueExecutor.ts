import { nativeQueueInputMatches } from "./nativeQueueContent";
import type { RuntimeHostClient } from "./client";
import { StructuredSendRefusedError, type EngineHost } from "./engineHost";
import { NativeQueueNotSubmittedError, NativeQueueProtocolRefusal, type NativeCodexQueue, type NativeQueueInput } from "./nativeCodexQueue";
import { sameNativeQueueBinding, type NativeQueueBinding, type NativeQueueCommand, type NativeQueueProof, type NativeQueueRecord, type NativeQueueVersion } from "./nativeQueueContracts";

export interface NativeQueueHost {
  queue: NativeCodexQueue;
  prepare(entry: NativeQueueRecord, version: NativeQueueVersion): Promise<NativeQueueInput[]>;
  /** Read canonical history only. Absence and partial history return null. */
  evidence(entry: NativeQueueRecord): Promise<NativeQueueProof | null>;
  evidenceBatch?(entries: NativeQueueRecord[]): Promise<Array<NativeQueueProof | null>>;
  /** The native queue entry has already been withdrawn before this call. */
  sendWithdrawn(entry: NativeQueueRecord, expectedTurnId: string | null): Promise<{ turnId: string }>;
}
export interface NativeQueueExecutorPort {
  client: RuntimeHostClient;
  resolveHost(conversationId: string): EngineHost | null;
  binding(conversationId: string): NativeQueueBinding | null;
  settled?(entry: NativeQueueRecord): Promise<void> | void;
}

/** Runs only in the structured delivery controller's existing per-target drain. */
export class NativeQueueExecutor {
  constructor(private readonly port: NativeQueueExecutorPort) {}

  async execute(command: NativeQueueCommand & { operationId: string }, refusalReason?: string): Promise<void> {
    const { client } = this.port;
    if (!client.nativeQueueRead || !client.nativeQueueTransition) throw new Error("native queue journal is unavailable");
    const transition = (change: Parameters<NonNullable<RuntimeHostClient["nativeQueueTransition"]>>[1]) => client.nativeQueueTransition!(command.operationId, change);
    const prior = await client.operationStatus(command.operationId);
    if (!prior || (prior.receipt.status !== "queued" && prior.receipt.status !== "pending")) return;
    if (refusalReason) { await transition({ phase: "refused", reason: refusalReason }); return; }
    const host = this.port.resolveHost(command.conversationId);
    const native = host?.nativeQueue;
    const owns = () => {
      const binding = this.port.binding(command.conversationId);
      return host === this.port.resolveHost(command.conversationId) && binding && sameNativeQueueBinding(binding, command.binding);
    };
    if (!host || !native || !owns() || native.queue.threadId !== command.binding.threadId) {
      await transition({ phase: "refused", reason: "native queue host or account ownership changed" });
      return;
    }
    const records = await client.nativeQueueRead(command.conversationId);
    /* A reorder names native submission ids, and a queue-level start names
       nothing at all (native's `queuedSubmissionId` is nullable). Neither has a
       journal entry to own, so neither looks for one. */
    const entryTargeted = command.action !== "reorder" && (command.action === "add" || command.entryId !== undefined);
    const entry = entryTargeted ? records.find(e => e.entryId === (command.action === "add" ? command.operationId : command.entryId)) : null;
    if (entryTargeted && (!entry || entry.mutationOperationId !== command.operationId)) throw new Error("native queue mutation identity is unavailable");
    const version = entry?.versions.find(v => v.revision === entry.revision);
    let actuated = false;
    let prepared = false;
    try {
      const input = entry && version ? version.input ?? await native.prepare(entry, version) : [];
      const health = await host.health();
      if (!owns() || health.status === "dead" || health.status === "unhosted") throw new StructuredSendRefusedError("native queue writer is unavailable");
      if (command.turnId !== undefined && command.turnId !== health.activeTurnRef) throw new StructuredSendRefusedError("stale-turn");
      if ((command.action === "start" || command.action === "send-now") && health.status === "attention") throw new StructuredSendRefusedError("blocking-attention");
      if ((command.action === "start" || (command.action === "send-now" && command.turnId === null)) && health.status !== "idle") throw new StructuredSendRefusedError("idle state is unproven");
      if (command.action === "add" && health.status === "attention" && health.activeTurnRef === null) throw new StructuredSendRefusedError("blocking attention prevents native auto-dispatch");
      // Atomic journal CAS: a second executor cannot pass this boundary.
      await transition({ phase: "prepared", input });
      prepared = true;
      if (!owns()) throw new StructuredSendRefusedError("native queue writer changed before actuation");
      actuated = true;
      if (command.action === "add") {
        const ack = await native.queue.add(entry!.clientUserMessageId, input);
        if (!nativeQueueInputMatches({ ...version!, input }, ack.result.queuedSubmission.input)) throw new Error("native queue acknowledged a different input");
        await transition({ phase: "acknowledged", nativeSubmissionId: ack.result.queuedSubmission.id });
      } else if (command.action === "update") {
        if (!entry!.nativeSubmissionId) throw new StructuredSendRefusedError("native submission is unknown");
        const ack = await native.queue.update({ id: entry!.nativeSubmissionId, clientUserMessageId: entry!.clientUserMessageId }, input);
        if (!nativeQueueInputMatches({ ...version!, input }, ack.result.queuedSubmission.input)) throw new Error("native queue acknowledged a different input");
        await transition({ phase: "acknowledged", nativeSubmissionId: ack.result.queuedSubmission.id });
      } else if (command.action === "delete") {
        const ack = await native.queue.delete(entry!.nativeSubmissionId!);
        await transition({ phase: "acknowledged", deleted: ack.result.deleted });
        if (ack.result.deleted) {
          await client.nativeQueueTransition!(entry!.entryId, { phase: "removed" });
          await this.port.settled?.({ ...entry!, state: "removed", mutationOperationId: null });
        }
      } else if (command.action === "reorder") {
        await native.queue.reorder(command.queuedSubmissionIds!);
        await transition({ phase: "acknowledged" });
      } else if (command.action === "start" || command.turnId === null) {
        /* Three idle dispatches through one native call. Without an entry it is
           native's queue-level start, which dispatches the head of the queue.
           With one it is either that entry's turn — `start(submissionId)` — or
           the recovery of a payload native no longer holds, which has no
           submission id left to name and goes back as its own input. */
        const turnId = !entry
          ? (await native.queue.start(null)).result.turn.id
          : entry.state === "withdrawn"
            ? (await native.sendWithdrawn(entry, null)).turnId
            : (await native.queue.start(entry.nativeSubmissionId)).result.turn.id;
        await transition({ phase: "acknowledged", turnId });
      } else {
        // Native's steer-then-delete permits auto-dispatch between the two writes.
        // Positive withdrawal is the only authority to steer this queued payload.
        const removed = await native.queue.delete(entry!.nativeSubmissionId!);
        if (!removed.result.deleted) {
          await transition({ phase: "uncertain", reason: "native entry was not withdrawn; canonical verification required" });
          return;
        }
        await transition({ phase: "withdrawn" });
        if (!owns()) throw new StructuredSendRefusedError("native queue writer changed after withdrawal");
        const result = await native.sendWithdrawn({ ...entry!, state: "withdrawn" }, command.turnId!);
        await transition({ phase: "acknowledged", turnId: result.turnId });
      }
    } catch (error) {
      // A journal CAS failure is another executor's ownership, never a new attempt.
      const current = await client.operationStatus(command.operationId);
      if (current?.receipt.status === "delivered" || current?.receipt.status === "applied" || (!prepared && current?.receipt.status === "delivering")) return;
      if (entry) {
        const recovered = (await client.nativeQueueRead(command.conversationId)).find(row => row.entryId === entry.entryId);
        if (recovered && recovered.mutationOperationId !== command.operationId) return;
      }
      const refused = error instanceof NativeQueueProtocolRefusal || error instanceof NativeQueueNotSubmittedError || error instanceof StructuredSendRefusedError;
      await transition({ phase: refused || !actuated ? "refused" : "uncertain",
        reason: refused ? error.message.slice(0, 240) : "native queue mutation outcome is unknown; no mutation was retried" });
    }
  }

  async reconcile(conversationId: string): Promise<boolean> {
    const { client } = this.port;
    const host = this.port.resolveHost(conversationId);
    if (!host?.nativeQueue || !client.nativeQueueRead || !client.nativeQueueTransition) return false;
    const binding = this.port.binding(conversationId);
    if (!binding) return false;
    const records = await client.nativeQueueRead(conversationId);
    const unknownMutations = records.filter(entry => sameNativeQueueBinding(entry.binding, binding) && entry.mutationOperationId && entry.versions.some(version => version.operationId === entry.mutationOperationId && version.input));
    if (unknownMutations.length) {
      let snapshot;
      try { snapshot = await host.nativeQueue.queue.refresh(); } catch { /* Keep the unresolved original mutations. */ }
      if (snapshot && !snapshot.stale && snapshot.items && this.port.resolveHost(conversationId) === host) {
        for (const entry of unknownMutations) {
          const candidates = snapshot.items.filter(item => item.clientUserMessageId === entry.clientUserMessageId);
          const version = entry.versions.find(version => version.revision === entry.revision)!;
          const current = this.port.binding(conversationId);
          if (!current || !sameNativeQueueBinding(current, entry.binding) || candidates.length !== 1 || !version.input
            || !nativeQueueInputMatches(version, candidates[0]!.input)) continue;
          try { await client.nativeQueueTransition(entry.mutationOperationId!, { phase: "observed-queued", submission: candidates[0]! }); }
          catch { /* An acknowledgement or another canonical read may have settled it. */ }
        }
      }
    }
    for (const entry of records) {
      if (entry.state === "removed") {
        const operation = await client.operationStatus(entry.entryId);
        if (operation?.receipt.status !== "failed") await client.nativeQueueTransition(entry.entryId, { phase: "removed" });
        await this.port.settled?.(entry);
      }
    }
    const entries = records.filter(entry =>
      !entry.proof && entry.state !== "refused" && entry.state !== "removed" && sameNativeQueueBinding(entry.binding, binding));
    if (!entries.length) return false;
    const proofs = host.nativeQueue.evidenceBatch ? await host.nativeQueue.evidenceBatch(entries)
      : await Promise.all(entries.map(entry => host.nativeQueue!.evidence(entry)));
    let pending = false;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const proof = proofs[index];
      if (!proof) pending = true;
      if (!proof || this.port.resolveHost(conversationId) !== host) continue;
      const current = this.port.binding(conversationId);
      if (!current || !sameNativeQueueBinding(current, binding)) continue;
      await client.nativeQueueTransition(entry.entryId, { phase: "proven", proof });
      await this.port.settled?.({ ...entry, proof, state: "delivered" });
    }
    return pending;
  }
}
