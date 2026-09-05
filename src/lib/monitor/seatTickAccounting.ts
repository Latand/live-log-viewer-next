import crypto from "node:crypto";
import fs from "node:fs";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { seatTickWakeCommit } from "./seatTick";
import { emptySeatTickState, type SeatTickChildInput, type SeatTickProjectState, type SeatTickOutstandingWake } from "./types";
import { consumeMonitorJsonByte, emptyLedgerCursor, type LedgerCursor, type LedgerOutcome } from "./seatTickChildLedger";

type Base = { key: string; schemaVersion: 1; project: string };
type OwnerScan = { offset: number; identity: string | null; parser: LedgerCursor["parser"]; partial: Record<string, unknown>; version: number | null };
export type AccountingProject = Base & { kind: "project"; revision: number; sequence: number; ownerScan?: OwnerScan; state: SeatTickProjectState; migration: "ready" | "pending" | "unknown"; gap: string | null; legacy?: { offset: number; identity: string | null; parser: LedgerCursor["parser"]; raw: Record<string, unknown>; version: number | null } };
export type AccountingOwner = Base & { kind: "owner"; conversationId: string; epoch: number; after: string; through: string | null };
export type AccountingChild = Base & { kind: "child"; identity: string; rowKey: string; owner: string; launchId: string; input: SeatTickChildInput; generationIndex: number };
export type AccountingSource = Base & { kind: "source"; identity: string; child: string; engine: string; generation: string; legacyBoundary?: { identity: string; bytes: number }; cursor: LedgerCursor };
export type AccountingOutcome = Base & { kind: "outcome"; identity: string; child: string; tuple: string[]; input: SeatTickChildInput; status: "owed" | "acknowledged"; landingKey: string | null; readyKey: string; gap: string | null };
type Ticket = Base & { kind: "poll" | "ready" | "owner-poll" | "running"; target: string };
type OwnerCandidate = Base & { kind: "owner-candidate"; conversationId: string; epoch: number; evidenceIdentity: string };
type Legacy = Base & { kind: "legacy"; conversationId: string; reconciled: boolean };
export type AccountingRow = AccountingProject | AccountingOwner | AccountingChild | AccountingSource | AccountingOutcome | Ticket | Legacy | OwnerCandidate;
type Transaction = Parameters<Parameters<SqliteStateCollection<AccountingRow>["boundedPatch"]>[1]>[0];
const collectionName = "seat-tick-v3";
const collections = new Map<string, { identity: string; collection: SqliteStateCollection<AccountingRow> }>();
const databaseIdentity = (filename: string) => { const stat = fs.statSync(filename); return `${stat.dev}:${stat.ino}`; };
export const outcomeIdentity = (tuple: readonly string[]): string => crypto.createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
const segment = (value: string) => encodeURIComponent(value);
const key = (kind: string, project: string, id = "") => `${kind}/${segment(project)}/${segment(id)}`;

function decodeAccountingRow(raw: unknown): AccountingRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as AccountingRow;
  const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const nullableString = (value: unknown) => value === null || typeof value === "string";
  const childInput = (input: SeatTickChildInput | undefined) => input && string(input.conversationId)
    && typeof input.title === "string" && ["running", "terminal", "unknown"].includes(input.status)
    && (input.outcome === null || ["finished", "failed"].includes(input.outcome));
  if (row.schemaVersion !== 1 || !string(row.key) || typeof row.project !== "string" || typeof row.kind !== "string"
    || !row.key.startsWith(key(row.kind, row.project))) return null;
  switch (row.kind) {
    case "project": {
      const state = row.state;
      if (!integer(row.revision) || !integer(row.sequence) || !["ready", "pending", "unknown"].includes(row.migration)
        || !state || typeof state !== "object" || !nullableString(row.gap)) return null;
      if (state.seatEpoch !== null && !integer(state.seatEpoch)) return null;
      for (const name of ["lastCheckAt", "lastWakeAt", "quietSince", "idleSince", "lastProposalAt"] as const) {
        const value = state[name];
        if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) return null;
      }
      if (state.eventsThrough !== null && !integer(state.eventsThrough)) return null;
      if (!Array.isArray(state.harvestedChildren) || state.harvestedChildren.length !== 0
        || !Array.isArray(state.lastWakeReasons) || !Array.isArray(state.stalledSeen)
        || !state.wakesWithoutChange || typeof state.wakesWithoutChange !== "object") return null;
      const wake = state.outstandingWake;
      if (wake !== null && (!wake || !string(wake.clientMessageId) || !string(wake.conversationId)
        || !integer(wake.seatEpoch) || !nullableString(wake.operationId) || !wake.commit
        || typeof wake.commit.proposal !== "boolean" || !string(wake.commit.fingerprint)
        || !integer(wake.commit.eventsThrough) || !Array.isArray(wake.commit.reasons)
        || !Array.isArray(wake.commit.children) || !wake.commit.children.every(string))) return null;
      return row;
    }
    case "owner": return string(row.conversationId) && integer(row.epoch) && typeof row.after === "string" && nullableString(row.through) ? row : null;
    case "owner-candidate": return string(row.conversationId) && integer(row.epoch) && string(row.evidenceIdentity) ? row : null;
    case "child": return string(row.identity) && string(row.rowKey) && string(row.owner) && string(row.launchId) && childInput(row.input) && integer(row.generationIndex) ? row : null;
    case "source": return string(row.identity) && string(row.child) && string(row.engine) && string(row.generation)
      && row.cursor && integer(row.cursor.offset) && integer(row.cursor.seq) && row.cursor.parser
      && Array.isArray(row.cursor.parser.stack) && row.cursor.parser.stack.length <= 64 ? row : null;
    case "outcome": return Array.isArray(row.tuple) && [2, 3].includes(row.tuple.length) && row.tuple.every(string)
      && row.identity === outcomeIdentity(row.tuple) && row.key === key("outcome", row.project, row.identity)
      && childInput(row.input) && row.input.outcomeId === row.identity && row.input.status === "terminal"
      && ["owed", "acknowledged"].includes(row.status) && string(row.child) && string(row.readyKey) ? row : null;
    case "poll": case "ready": case "owner-poll": case "running": return string(row.target) ? row : null;
    case "legacy": return string(row.conversationId) && typeof row.reconciled === "boolean" ? row : null;
    default: return null;
  }
}

/** Non-evicting accounting rows and FIFO tickets in the existing state DB.
 * All changes use the shared store's authority fence, lease and transaction. */
export class SeatTickAccounting {
  readonly collection: SqliteStateCollection<AccountingRow>;
  constructor(readonly filename: string, readonly project: string) {
    const cached = collections.get(filename);
    if (cached) {
      if (databaseIdentity(filename) !== cached.identity) throw new Error("seat accounting database was replaced");
      this.collection = cached.collection;
      return;
    }
    initializeStateCollections(filename, [{ collection: collectionName, schemaVersion: 1, migrationId: "monitor-v3", key: (raw) => (raw as AccountingRow).key, loadRecords: () => [] }]);
    this.collection = new SqliteStateCollection<AccountingRow>(filename, {
      collection: collectionName, schemaVersion: 1, busyMessage: "seat outcome accounting is busy", key: (row) => row.key,
      decode: decodeAccountingRow, clone: structuredClone, strictDecode: true,
    });
    collections.set(filename, { identity: databaseIdentity(filename), collection: this.collection });
  }
  private base(kind: string, id = ""): Base { return { key: key(kind, this.project, id), project: this.project, schemaVersion: 1 }; }
  get(id: string): AccountingRow | null { return this.collection.get(id); }
  row(): AccountingProject | null {
    const row = this.get(key("project", this.project));
    if (row && row.kind !== "project") throw new Error("invalid project accounting row");
    return row;
  }
  page(kind: AccountingRow["kind"], limit: number): AccountingRow[] {
    const prefix = key(kind, this.project);
    return this.collection.keyRange(prefix, `${prefix}~`, limit);
  }
  private ticket(tx: Transaction, row: AccountingProject, kind: Ticket["kind"], target: string) {
    if (!Number.isSafeInteger(++row.sequence)) throw new Error("accounting sequence exhausted");
    tx.put({ ...this.base(kind, String(row.sequence).padStart(16, "0")), kind, target });
  }
  private mutate<R>(operation: (tx: Transaction, project: AccountingProject) => R): R {
    return this.collection.boundedPatch(4096, (tx) => {
      const row = tx.get(key("project", this.project));
      if (!row || row.kind !== "project") throw new Error("accounting migration has not completed");
      const result = operation(tx, row);
      row.revision++;
      tx.put(row);
      return result;
    });
  }
  initialize(state: SeatTickProjectState, gap: string | null): void {
    this.collection.boundedPatch(4096, (tx) => {
      if (tx.get(key("project", this.project))) return;
      const ids = state.harvestedChildren;
      for (const id of ids) tx.put({ ...this.base("legacy", id), kind: "legacy", conversationId: id, reconciled: false });
      tx.put({ ...this.base("project"), kind: "project", revision: 0, sequence: 0,
        state: { ...state, harvestedChildren: [] }, migration: gap ? "unknown" : "ready", gap });
    });
  }
  /** Legacy JSON is scanned positionally. At most 64 KiB and 200 selected
   * scalars are imported per call; acknowledgments become separate rows. */
  migrateLegacy(file: string, normalize: (raw: Record<string, unknown>, version: number | null) => SeatTickProjectState): void {
    if (this.row()?.migration === "ready") return;
    if (!this.row()) this.collection.boundedPatch(2, (tx) => {
      if (!tx.get(key("project", this.project))) tx.put({ ...this.base("project"), kind: "project", revision: 0, sequence: 0,
        state: emptySeatTickState(), migration: "pending", gap: null,
        legacy: { offset: 0, identity: null, parser: { ...emptyLedgerCursor().parser, select: ["projects", this.project] }, raw: {}, version: null } });
    });
    const opening = this.row()!;
    if (!opening.legacy) return;
    const legacy = structuredClone(opening.legacy);
    let gap: string | null = opening.gap;
    let complete = false;
    let absent = false;
    let fd: number | undefined;
    const imported: string[] = [];
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("legacy state is not a file");
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (legacy.identity !== null && legacy.identity !== identity) {
        gap = "legacy-file-changed";
      } else {
        legacy.identity = identity;
        if (gap === "legacy-state-unreadable") gap = null;
        const buffer = Buffer.alloc(65536);
        const count = fs.readSync(fd, buffer, 0, buffer.length, legacy.offset);
        for (let index = 0; index < count; index++) {
          consumeMonitorJsonByte(legacy.parser, String.fromCharCode(buffer[index]!));
          legacy.offset++;
          if ((legacy.parser.captures?.length ?? 0) >= 200 || legacy.parser.bad) break;
        }
        for (const capture of legacy.parser.captures ?? []) {
          if (capture.path.length === 1) { legacy.version = typeof capture.value === "number" ? capture.value : null; continue; }
          const parts = capture.path.slice(2);
          if (parts[0] === "harvestedChildren") {
            if (parts.length !== 2 || typeof capture.value !== "string" || !capture.value) gap = "legacy-acknowledgments-unreadable";
            else imported.push(capture.value);
            continue;
          }
          if (parts.some((part) => ["__proto__", "constructor", "prototype"].includes(part))) { gap = "legacy-state-unreadable"; continue; }
          if (parts.length > 4) { gap = "legacy-state-unreadable"; continue; }
          let target = legacy.raw;
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]!;
            const next = parts[i + 1]!;
            if (/^\d+$/.test(next) && Number(next) >= 200) { gap = "legacy-plan-unreadable"; break; }
            if (target[part] === null || typeof target[part] !== "object") target[part] = /^\d+$/.test(next) ? [] : {};
            target = target[part] as Record<string, unknown>;
          }
          target[parts.at(-1)!] = capture.value;
        }
        legacy.parser.captures = [];
        if (legacy.parser.bad) gap = "legacy-json-malformed";
        complete = legacy.offset === stat.size && legacy.parser.rootDone && !legacy.parser.bad;
        if (legacy.offset === stat.size && !legacy.parser.rootDone) gap = "legacy-json-incomplete";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && legacy.offset === 0) { absent = true; complete = true; }
      else gap = "legacy-state-unreadable";
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    let state = opening.state;
    if (complete && !absent && legacy.parser.fields.projects !== true) gap = "legacy-projects-unreadable";
    if (complete && !gap) {
      state = absent ? emptySeatTickState() : normalize(legacy.raw, legacy.version);
      if (Object.hasOwn(legacy.raw, "outstandingWake") && legacy.raw.outstandingWake !== null && !state.outstandingWake) gap = "legacy-outstanding-unreadable";
    }
    this.collection.boundedPatch(2048, (tx) => {
      const current = tx.get(opening.key);
      if (!current || current.kind !== "project" || current.revision !== opening.revision) return;
      for (const id of imported) tx.put({ ...this.base("legacy", id), kind: "legacy", conversationId: id, reconciled: false });
      tx.put({ ...current, revision: current.revision + 1, state,
        migration: complete && !gap ? "ready" : gap ? "unknown" : "pending", gap,
        legacy: complete && !gap ? undefined : legacy });
    });
  }
  readState(): SeatTickProjectState {
    const row = this.row();
    if (!row) throw new Error("missing project accounting");
    return { ...row.state, accounting: { filename: this.filename, revision: row.revision, gap: row.migration === "ready" ? row.gap : row.gap ?? "legacy-migration-pending" } };
  }
  writeState(state: SeatTickProjectState): void {
    this.mutate((tx, row) => {
      if (state.accounting?.revision !== row.revision) throw new Error("stale seat tick state");
      if (row.migration === "ready") row.state = { ...state, accounting: undefined, harvestedChildren: [] };
    });
  }
  owner(conversationId: string, epoch: number): void {
    const existing = this.get(key("owner", this.project, String(epoch)));
    if (existing?.kind === "owner" && existing.conversationId === conversationId) return;
    this.mutate((tx, row) => {
      const id = key("owner", this.project, String(epoch));
      const existing = tx.get(id);
      if (existing) {
        if (existing.kind !== "owner" || existing.conversationId !== conversationId) throw new Error("contradictory seat ownership");
        return;
      }
      tx.put({ ...this.base("owner", String(epoch)), kind: "owner", conversationId, epoch, after: "", through: null });
      this.ticket(tx, row, "owner-poll", id);
    });
  }
  /** Read only committed revocations; abandoned pending-seat history grants
   * no ownership. The JSON reader resumes within the fixed byte/field budget. */
  discoverRevokedOwners(filename: string, matches: (project: string) => boolean): boolean {
    const opening = this.row()!;
    let scan: OwnerScan = structuredClone(opening.ownerScan ?? { offset: 0, identity: null,
      parser: { ...emptyLedgerCursor().parser, select: ["revocations"] }, partial: {}, version: null });
    const owners: { conversationId: string; epoch: number }[] = [];
    let fd: number | undefined;
    let gap = false;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("seat evidence is not a file");
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (scan.identity !== identity) scan = { offset: 0, identity,
        parser: { ...emptyLedgerCursor().parser, select: ["revocations"] }, partial: {}, version: null };
      const buffer = Buffer.alloc(32768);
      const count = fs.readSync(fd, buffer, 0, buffer.length, scan.offset);
      for (let i = 0; i < count; i++) {
        consumeMonitorJsonByte(scan.parser, String.fromCharCode(buffer[i]!));
        scan.offset++;
        if ((scan.parser.captures?.length ?? 0) >= 200 || scan.parser.bad) break;
      }
      for (const capture of scan.parser.captures ?? []) {
        if (capture.path.length === 1) { scan.version = typeof capture.value === "number" ? capture.value : null; continue; }
        const field = capture.path[2]!;
        if (field === "$end") {
          const row = scan.partial;
          if (typeof row.project === "string" && matches(row.project)
            && typeof row.conversationId === "string" && row.conversationId.startsWith("conversation_")
            && Number.isSafeInteger(row.seatEpoch) && Number(row.seatEpoch) >= 1
            && typeof row.revokedAt === "string" && Number.isFinite(Date.parse(row.revokedAt))) {
            owners.push({ conversationId: row.conversationId, epoch: Number(row.seatEpoch) });
          }
          scan.partial = {};
        } else scan.partial[field] = capture.value;
      }
      scan.parser.captures = [];
      gap = scan.parser.bad || scan.offset < stat.size || !scan.parser.rootDone || scan.version !== 1;
    } catch (error) { gap = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    this.mutate((tx, row) => {
      // Another scanner may have progressed while the file was read.
      if (row.revision !== opening.revision) return;
      row.ownerScan = scan;
      for (const owner of owners) {
        const id = key("owner", this.project, String(owner.epoch));
        const existing = tx.get(id);
        if (existing) {
          if (existing.kind !== "owner" || existing.conversationId !== owner.conversationId) throw new Error("contradictory predecessor ownership");
          continue;
        }
        tx.put({ ...this.base("owner-candidate", String(owner.epoch)), kind: "owner-candidate", ...owner, evidenceIdentity: scan.identity! });
      }
    });
    if (!gap && scan.identity) {
      const candidates = this.page("owner-candidate", 20);
      this.mutate((tx, row) => {
        for (const candidate of candidates) {
          if (candidate.kind !== "owner-candidate") continue;
          if (candidate.evidenceIdentity === scan.identity) {
            const id = key("owner", this.project, String(candidate.epoch));
            if (!tx.get(id)) {
              tx.put({ ...this.base("owner", String(candidate.epoch)), kind: "owner", conversationId: candidate.conversationId, epoch: candidate.epoch, after: "", through: null });
              this.ticket(tx, row, "owner-poll", id);
            }
          }
          tx.delete(candidate.key);
        }
      });
      gap ||= candidates.length === 20;
    }
    return gap;
  }
  discovery(ticket: Ticket, owner: AccountingOwner, children: AccountingChild[]): void {
    this.mutate((tx, row) => {
      const current = tx.get(ticket.key);
      if (!current) return;
      for (const child of children) {
        const prior = tx.get(child.key);
        if (!prior) {
          tx.put(child);
          if (child.input.status === "running") tx.put({ ...this.base("running", child.identity), kind: "running", target: child.key });
          this.ticket(tx, row, "poll", child.key);
        }
      }
      tx.put(owner);
      tx.delete(ticket.key);
      this.ticket(tx, row, "owner-poll", owner.key);
    });
  }
  child(rowKey: string, owner: string, launchId: string, input: SeatTickChildInput): AccountingChild {
    const identity = outcomeIdentity([owner, rowKey, launchId]);
    return { ...this.base("child", identity), kind: "child", identity, rowKey, owner, launchId, input, generationIndex: 0 };
  }
  source(child: AccountingChild, engine: string, generation: string): AccountingSource {
    const identity = outcomeIdentity([engine, generation]);
    const held = this.get(key("source", this.project, identity));
    if (held) {
      if (held.kind !== "source" || held.child !== child.key || held.engine !== engine || held.generation !== generation) throw new Error("source identity collision");
      return held;
    }
    return { ...this.base("source", identity), kind: "source", identity, child: child.key, engine, generation, cursor: emptyLedgerCursor() };
  }
  ingest(ticket: Ticket, child: AccountingChild, source: AccountingSource | null, outcomes: LedgerOutcome[], failure = false): void {
    this.mutate((tx, row) => {
      if (!tx.get(ticket.key)) return;
      if (source?.cursor.identity && source.legacyBoundary?.identity !== source.cursor.identity) {
        source.legacyBoundary = { identity: source.cursor.identity, bytes: source.cursor.initialSize };
      }
      const tuples = failure ? [[child.launchId, "pre-execution-failure"]] : outcomes.map((event) => [source!.engine, source!.generation, event.turnId]);
      tuples.forEach((tuple, index) => {
        const identity = outcomeIdentity(tuple);
        const id = key("outcome", this.project, identity);
        const result = failure || outcomes[index]!.status !== "completed" ? "failed" : "finished";
        const existing = tx.get(id);
        if (existing) {
          if (existing.kind !== "outcome" || JSON.stringify(existing.tuple) !== JSON.stringify(tuple)) throw new Error("outcome identity collision");
          if (existing.input.outcome !== result) tx.put({ ...existing, gap: "conflicting-terminal" });
          return;
        }
        const legacy = tx.get(key("legacy", this.project, child.input.conversationId));
        const input: SeatTickChildInput = { ...child.input, status: "terminal", outcome: result, outcomeId: identity };
        const readyKey = key("ready", this.project, String(row.sequence + 1).padStart(16, "0"));
        this.ticket(tx, row, "ready", id);
        tx.put({ ...this.base("outcome", identity), kind: "outcome", identity, child: child.key, tuple, input, status: "owed", landingKey: null, readyKey,
          gap: legacy && (failure || !source?.legacyBoundary || outcomes[index]!.endOffset <= source.legacyBoundary.bytes) ? "legacy-delivery-ambiguous" : null });
      });
      if (source) tx.put(source);
      tx.put(child);
      if (child.input.status === "running") tx.put({ ...this.base("running", child.identity), kind: "running", target: child.key });
      else tx.delete(key("running", this.project, child.identity));
      tx.delete(ticket.key);
      this.ticket(tx, row, "poll", child.key);
    });
  }
  ready(limit: number): AccountingOutcome[] {
    return this.page("ready", limit).flatMap((ticket) => {
      if (ticket.kind !== "ready") throw new Error("invalid ready ticket");
      const outcome = this.get(ticket.target);
      if (!outcome || outcome.kind !== "outcome") throw new Error("missing outcome");
      if (outcome.status === "owed" && outcome.gap) this.defer(outcome);
      return outcome.status === "owed" && !outcome.gap ? [outcome] : [];
    });
  }
  defer(outcome: AccountingOutcome): void {
    this.mutate((tx, row) => {
      const held = tx.get(outcome.key);
      if (!held || held.kind !== "outcome" || held.status !== "owed" || held.readyKey !== outcome.readyKey) return;
      tx.delete(held.readyKey);
      held.readyKey = key("ready", this.project, String(row.sequence + 1).padStart(16, "0"));
      this.ticket(tx, row, "ready", held.key);
      tx.put(held);
    });
  }
  prepare(state: SeatTickProjectState, wake: SeatTickOutstandingWake): boolean {
    return this.mutate((tx, row) => {
      if (row.revision !== state.accounting?.revision || row.state.outstandingWake || row.migration !== "ready") return false;
      for (const id of wake.commit.children) {
        const outcome = tx.get(key("outcome", this.project, id));
        if (!outcome || outcome.kind !== "outcome" || outcome.status !== "owed" || outcome.gap) return false;
      }
      row.state = { ...state, accounting: undefined, harvestedChildren: [], outstandingWake: wake };
      return true;
    });
  }
  settle(expectedKey: string, state: SeatTickProjectState, landed: boolean): boolean {
    return this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (!wake || wake.clientMessageId !== expectedKey) return false;
      if (landed) for (const id of wake.commit.children) {
        const outcome = tx.get(key("outcome", this.project, id));
        if (!outcome) {
          // A legacy prepared wake names conversations. Landing preserves that
          // positive evidence without attributing it to a guessed turn.
          if (!id.startsWith("conversation_")) throw new Error("missing frozen outcome");
          tx.put({ ...this.base("legacy", id), kind: "legacy", conversationId: id, reconciled: true });
          continue;
        }
        if (outcome.kind !== "outcome") throw new Error("invalid frozen outcome");
        tx.put({ ...outcome, status: "acknowledged", landingKey: expectedKey });
        tx.delete(outcome.readyKey);
      }
      const current = landed ? seatTickWakeCommit(row.state, wake.commit, Date.parse(state.lastWakeAt!))
        : { ...row.state, outstandingWake: null };
      row.state = { ...current, accounting: undefined, harvestedChildren: [], outstandingWake: null };
      return true;
    });
  }
}
