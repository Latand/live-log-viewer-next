import crypto from "node:crypto";
import fs from "node:fs";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { seatTickWakeCommit } from "./seatTick";
import type { SeatChildrenAnchor } from "@/lib/agent/registry";
import { emptySeatTickState, SEAT_TICK_RETIRED_WAKE_LIMIT, type SeatTickChildInput, type SeatTickProjectState, type SeatTickOutstandingWake, type SeatTickRetiredWake } from "./types";
import { emptyLedgerCursor, type LedgerCursor, type LedgerOutcome } from "./seatTickChildLedger";

type Base = { key: string; schemaVersion: 1; project: string };
/** What the seat file looked like when its revocations were last read: a
    file that has not changed is not read again, and one that could not be read
    keeps saying so until it changes. */
type OwnerScan = { identity: string; gap: boolean };
export type AccountingProject = Base & { kind: "project"; revision: number; sequence: number; ownerScan?: OwnerScan; state: SeatTickProjectState; migration: "ready" | "pending" | "unknown"; gap: string | null };
/** A seat that owns children: the active one and every predecessor the seat
    file records. `after` is where its discovery sweep stands, and `pollKey`
    its ticket in the owner queue, so discovery can move the ticket without a
    scan. */
export type AccountingOwner = Base & { kind: "owner"; conversationId: string; epoch: number; after: SeatChildrenAnchor | null; pollKey: string; bootstrap?: { after: SeatChildrenAnchor | null } };
/** A discovered child. `pollKey` is its one ticket in the poll queue and
    `runningKey` its ticket in the running window while it runs; each is the
    row's own pointer, so a ticket moves in one keyed transaction. */
export type AccountingChild = Base & { kind: "child"; identity: string; rowKey: string; owner: string; launchId: string; input: SeatTickChildInput; generationIndex: number; runningKey: string | null; pollKey: string | null };
export type AccountingSource = Base & { kind: "source"; identity: string; child: string; engine: string; generation: string; legacyBoundary?: { identity: string; bytes: number }; cursor: LedgerCursor };
export type AccountingOutcome = Base & { kind: "outcome"; identity: string; child: string; tuple: string[]; input: SeatTickChildInput; status: "owed" | "acknowledged"; landingKey: string | null; readyKey: string; gap: string | null };
type Ticket = Base & { kind: "poll" | "ready" | "owner-poll" | "running"; target: string };
/** Where a ticket enters its queue (#1465). The queues are FIFO by sequence;
    a `head` ticket sorts before every `tail` one, in sequence among heads, so
    evidence that a child is owed an outcome now — a terminal child discovery
    just found, a ledger the budget cut — is read by the next visit rather
    than after every cold child ahead of it. */
export type TicketPosition = "head" | "tail";
type Legacy = Base & { kind: "legacy"; conversationId: string; reconciled: boolean };
export type AccountingRow = AccountingProject | AccountingOwner | AccountingChild | AccountingSource | AccountingOutcome | Ticket | Legacy;
type Transaction = Parameters<Parameters<SqliteStateCollection<AccountingRow>["boundedPatch"]>[1]>[0];
/** How a prepared attempt ends (#1465). `landed` acknowledges what it named
    and stamps the wake; `unsent` is proven non-delivery and releases it with
    no stamp, so the next check may raise it again. Nothing else ends one. */
export type WakeDisposition = "landed" | "unsent";
const collectionName = "seat-tick-v3";
const collections = new Map<string, { identity: string; collection: SqliteStateCollection<AccountingRow> }>();
const databaseIdentity = (filename: string) => { const stat = fs.statSync(filename); return `${stat.dev}:${stat.ino}`; };
export const outcomeIdentity = (tuple: readonly string[]): string => crypto.createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
const segment = (value: string) => encodeURIComponent(value);
const key = (kind: string, project: string, id = "") => `${kind}/${segment(project)}/${segment(id)}`;
/** The legacy tick-state JSON and the seat file are bounded, atomically written
    documents; either is read whole under a size ceiling. The real ones are
    kilobytes; the ceilings only refuse a file that is not what it claims. */
export const LEGACY_STATE_LIMIT = 4 * 1024 * 1024;
export const SEAT_FILE_LIMIT = 16 * 1024 * 1024;
/** Rows one transaction may touch importing legacy acknowledgments, so a
    crowd of them is imported in several bounded transactions rather than one
    unbounded one; each put is keyed, so a crash between two is replayed. */
const LEGACY_IMPORT_BATCH = 1000;
/** Predecessor owners one read of the seat file records. */
const OWNER_LIMIT = 200;
/** Running children one check observes, and how many of them move to the back
    of the queue afterwards. Observing eight and rotating four means every
    running child is seen on two CONSECUTIVE checks once per cycle, which is
    what the stall rule needs: a stall is reported once it survived a second
    check. A fixed identity-ordered eight would have watched the same eight for
    ever and never seen a stall among the rest (#1465). */
export const RUNNING_PAGE = 8;
export const RUNNING_ROTATE = 4;

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
      const validWake = (wake: SeatTickOutstandingWake | null | undefined): boolean => {
        if (!wake || !string(wake.clientMessageId) || !string(wake.conversationId)
          || !integer(wake.seatEpoch) || !nullableString(wake.operationId) || !wake.commit
          || typeof wake.commit.proposal !== "boolean" || !string(wake.commit.fingerprint)
          || !integer(wake.commit.eventsThrough) || !Array.isArray(wake.commit.reasons)
          || !Array.isArray(wake.commit.children) || !wake.commit.children.every(string)
          || (wake.preparedAt !== undefined && !string(wake.preparedAt))) return false;
        return wake.dispatch === undefined || (!!wake.dispatch && string(wake.dispatch.token)
          && ["active", "refused", "returned"].includes(wake.dispatch.state));
      };
      const wake = state.outstandingWake;
      if (wake !== null && !validWake(wake)) return null;
      if (row.ownerScan !== undefined && (!row.ownerScan || !string(row.ownerScan.identity) || typeof row.ownerScan.gap !== "boolean")) return null;
      /* Retired attempts (#1594) are absent on every row written before the
         slot existed, and absent is exactly what those rows mean: nothing has
         been retired. Reading them back as an empty list is the migration. */
      const retired = state.retiredWakes;
      if (retired === undefined) return { ...row, state: { ...state, retiredWakes: [] } };
      /* The retention bound is the WRITER's (see `retire`), and is deliberately
         not re-asserted here: a row that a future, smaller bound would exceed
         is still a row full of obligations, and refusing to read it would take
         the whole project's tick down rather than let it work them off. */
      if (!Array.isArray(retired)) return null;
      for (const entry of retired) {
        if (!entry || typeof entry !== "object" || !validWake(entry.wake) || !string(entry.retiredAt)
          || !entry.supersededBy || !string(entry.supersededBy.conversationId) || !integer(entry.supersededBy.seatEpoch)) return null;
      }
      return row;
    }
    case "owner": {
      if (!string(row.conversationId) || !integer(row.epoch)) return null;
      // The preceding schema used a key-ordered sweep and no ticket pointer.
      // Restart discovery; existing outcomes and ledger cursors remain authoritative.
      if (typeof row.after === "string" && row.pollKey === undefined) return { ...row, after: null, pollKey: "" };
      const anchor = (value: SeatChildrenAnchor | null) => value === null
        || (!!value && typeof value === "object" && Number.isSafeInteger(value.order) && string(value.key));
      return typeof row.pollKey === "string" && anchor(row.after)
        && (row.bootstrap === undefined || (!!row.bootstrap && anchor(row.bootstrap.after))) ? row : null;
    }
    case "child": return string(row.identity) && string(row.rowKey) && string(row.owner) && string(row.launchId) && childInput(row.input)
      && integer(row.generationIndex) && nullableString(row.runningKey) && (row.pollKey === undefined || nullableString(row.pollKey))
      ? { ...row, pollKey: row.pollKey ?? null } : null;
    case "source": return string(row.identity) && string(row.child) && string(row.engine) && string(row.generation)
      && row.cursor && integer(row.cursor.offset) && integer(row.cursor.seq) && integer(row.cursor.settledThrough)
      && integer(row.cursor.initialSize) && nullableString(row.cursor.identity) && nullableString(row.cursor.activeTurn)
      && nullableString(row.cursor.gap) && typeof row.cursor.atEnd === "boolean" ? row : null;
    case "outcome": return Array.isArray(row.tuple) && [2, 3].includes(row.tuple.length) && row.tuple.every(string)
      && row.identity === outcomeIdentity(row.tuple) && row.key === key("outcome", row.project, row.identity)
      && childInput(row.input) && row.input.outcomeId === row.identity && row.input.status === "terminal"
      && ["owed", "acknowledged"].includes(row.status) && string(row.child) && string(row.readyKey) ? row : null;
    case "poll": case "ready": case "owner-poll": case "running": return string(row.target) ? row : null;
    case "legacy": return string(row.conversationId) && typeof row.reconciled === "boolean" ? row : null;
    default: return null;
  }
}

/** A bounded, atomically written JSON document read whole, or the reason it
    could not be. `absent` is a file that does not exist. */
function readJsonDocument(file: string, limit: number): { kind: "parsed"; value: unknown } | { kind: "absent" } | { kind: "gap"; gap: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: "gap", gap: "not-a-file" };
    if (stat.size > limit) return { kind: "gap", gap: "oversized" };
    const buffer = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const length = fs.readSync(fd, buffer, read, stat.size - read, read);
      if (!length) break;
      read += length;
    }
    try { return { kind: "parsed", value: JSON.parse(buffer.subarray(0, read).toString("utf8")) }; }
    catch { return { kind: "gap", gap: "malformed" }; }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "gap", gap: "unreadable" };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
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
  /** Reserve cold visits even while priority ledgers keep arriving. */
  pollPage(limit: number): AccountingRow[] {
    const cold = this.collection.keyRange(`${key("poll", this.project)}0`, `${key("poll", this.project)}~`, 8);
    const priority = this.page("poll", limit);
    const seen = new Set(cold.map((ticket) => ticket.key));
    return [...cold, ...priority.filter((ticket) => !seen.has(ticket.key))].slice(0, limit);
  }
  /** A FIFO ticket at the tail of its queue, or at its head (see
      {@link TicketPosition}); the key is returned so a row can remember which
      ticket is its own. */
  private ticket(tx: Transaction, row: AccountingProject, kind: Ticket["kind"], target: string, position: TicketPosition = "tail"): string {
    if (!Number.isSafeInteger(++row.sequence)) throw new Error("accounting sequence exhausted");
    const ticket = { ...this.base(kind, `${position === "head" ? "!" : ""}${String(row.sequence).padStart(16, "0")}`), kind, target };
    tx.put(ticket);
    return ticket.key;
  }
  private atHead(ticketKey: string, kind: Ticket["kind"]): boolean {
    return ticketKey.startsWith(key(kind, this.project, "!"));
  }
  /** Keep the child's running ticket in step with its status: a running child
      holds exactly one, and a child that stopped running holds none. */
  private trackRunning(tx: Transaction, row: AccountingProject, child: AccountingChild): void {
    if (child.input.status === "running") {
      if (!child.runningKey) child.runningKey = this.ticket(tx, row, "running", child.key);
    } else if (child.runningKey) {
      tx.delete(child.runningKey);
      child.runningKey = null;
    }
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
  /**
   * Import the project's row from the legacy JSON state file, once.
   *
   * The file is a bounded document the tick wrote atomically, so it is read
   * whole under {@link LEGACY_STATE_LIMIT} and parsed in one step; there is no
   * resumable cursor and nothing to resume. A file that cannot be read whole,
   * parsed, or trusted leaves the row `unknown` with the reason on it, and
   * every check reports that reason until the file is fixed or removed — a
   * blocked migration refuses every prepare, so it must never be silent.
   * Acknowledgments become separate rows, imported in bounded batches.
   */
  migrateLegacy(file: string, normalize: (raw: Record<string, unknown>, version: number | null) => SeatTickProjectState): void {
    if (this.row()?.migration === "ready") return;
    if (!this.row()) this.collection.boundedPatch(2, (tx) => {
      if (!tx.get(key("project", this.project))) tx.put({ ...this.base("project"), kind: "project", revision: 0, sequence: 0,
        state: emptySeatTickState(), migration: "pending", gap: null });
    });
    const opening = this.row()!;
    const document = readJsonDocument(file, LEGACY_STATE_LIMIT);
    let gap: string | null = null;
    let state = emptySeatTickState();
    const imported: string[] = [];
    if (document.kind === "gap") gap = document.gap === "malformed" ? "legacy-json-malformed" : document.gap === "oversized" ? "legacy-state-oversized" : "legacy-state-unreadable";
    else if (document.kind === "parsed") {
      const parsed = document.value;
      const projects = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).projects : undefined;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) gap = "legacy-projects-unreadable";
      else {
        const version = typeof (parsed as Record<string, unknown>).version === "number" ? (parsed as Record<string, unknown>).version as number : null;
        const raw = (projects as Record<string, unknown>)[this.project];
        if (raw !== undefined) {
          const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
          state = normalize(row, version);
          const acknowledgments = row.harvestedChildren;
          if (acknowledgments !== undefined) {
            if (!Array.isArray(acknowledgments)) gap = "legacy-acknowledgments-unreadable";
            else for (const id of acknowledgments) {
              if (typeof id !== "string" || !id || id.length > 200) { gap = "legacy-acknowledgments-unreadable"; break; }
              imported.push(id);
            }
          }
          if (Object.hasOwn(row, "outstandingWake") && row.outstandingWake !== null && !state.outstandingWake) gap = "legacy-outstanding-unreadable";
        }
      }
    }
    const legacyRows = gap ? [] : [...new Set(imported)];
    for (let start = 0; start < legacyRows.length; start += LEGACY_IMPORT_BATCH) {
      const batch = legacyRows.slice(start, start + LEGACY_IMPORT_BATCH);
      this.collection.boundedPatch(LEGACY_IMPORT_BATCH + 2, (tx) => {
        const current = tx.get(opening.key);
        if (!current || current.kind !== "project" || current.revision !== opening.revision) return;
        for (const id of batch) tx.put({ ...this.base("legacy", id), kind: "legacy", conversationId: id, reconciled: false });
      });
    }
    this.collection.boundedPatch(2, (tx) => {
      const current = tx.get(opening.key);
      if (!current || current.kind !== "project" || current.revision !== opening.revision) return;
      const migration = gap ? "unknown" : "ready";
      /* A blocked import re-read on every check must not move the revision
         while nothing about it changed, or a check's own conditional write —
         made on the revision it read — is refused as stale. */
      if (current.migration === migration && current.gap === gap && gap) return;
      tx.put({ ...current, revision: current.revision + 1, state: gap ? current.state : { ...state, harvestedChildren: [] }, migration, gap });
    });
  }
  readState(): SeatTickProjectState {
    const row = this.row();
    if (!row) throw new Error("missing project accounting");
    return { ...row.state, accounting: { filename: this.filename, revision: row.revision, gap: row.migration === "ready" ? row.gap : row.gap ?? "legacy-migration-pending" } };
  }
  /** Conditional project write. A row whose legacy import is blocked is written
      too (#1465): the check's own memory — the run of failures that puts the
      blocked import on the board, the stall memory, the sealed cursor — has to
      persist for the condition to be reported at all, and the import, once the
      file is fixed, replaces the row wholesale anyway. */
  writeState(state: SeatTickProjectState): void {
    this.mutate((tx, row) => {
      if (state.accounting?.revision !== row.revision) throw new Error("stale seat tick state");
      row.state = { ...state, accounting: undefined, harvestedChildren: [] };
    });
  }
  /** The seat's own owner row, recorded on first sight; returned so the check
      can discover its children directly, every check. */
  owner(conversationId: string, epoch: number): AccountingOwner {
    const id = key("owner", this.project, String(epoch));
    const existing = this.get(id);
    if (existing?.kind === "owner" && existing.conversationId === conversationId && existing.pollKey) return existing;
    this.mutate((tx, row) => {
      const held = tx.get(id);
      if (held) {
        if (held.kind !== "owner" || held.conversationId !== conversationId) throw new Error("contradictory seat ownership");
        if (!held.pollKey) tx.put({ ...held, pollKey: this.ticket(tx, row, "owner-poll", id) });
        return;
      }
      const owner: AccountingOwner = { ...this.base("owner", String(epoch)), kind: "owner", conversationId, epoch, after: null, pollKey: "" };
      owner.pollKey = this.ticket(tx, row, "owner-poll", id);
      tx.put(owner);
    });
    const recorded = this.get(id);
    if (!recorded || recorded.kind !== "owner") throw new Error("missing owner provenance");
    return recorded;
  }
  /**
   * Record the project's predecessor seats from the seat file's committed
   * revocations, so their children are discovered too. Abandoned pending-seat
   * history grants no ownership.
   *
   * The seat file is written atomically and is kilobytes long, so it is read
   * whole under {@link SEAT_FILE_LIMIT} and parsed once; the identity of the
   * file last read is remembered on the project row, and an unchanged file is
   * not read again. Returns whether this check's owner discovery is incomplete.
   */
  discoverRevokedOwners(filename: string, matches: (project: string) => boolean): boolean {
    const opening = this.row()!;
    let identity: string;
    try {
      const stat = fs.statSync(filename);
      identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (opening.ownerScan?.identity === identity) return opening.ownerScan.gap;
    const document = readJsonDocument(filename, SEAT_FILE_LIMIT);
    if (document.kind === "absent") return false;
    let gap = document.kind === "gap";
    const owners: { conversationId: string; epoch: number }[] = [];
    if (document.kind === "parsed") {
      const file = document.value as Record<string, unknown> | null;
      const revocations = file && typeof file === "object" && !Array.isArray(file) && file.schemaVersion === 1 && Array.isArray(file.revocations)
        ? file.revocations : null;
      if (!revocations) gap = true;
      else for (const candidate of revocations) {
        const row = (candidate ?? {}) as Record<string, unknown>;
        if (typeof row.project === "string" && matches(row.project)
          && typeof row.conversationId === "string" && row.conversationId.startsWith("conversation_")
          && Number.isSafeInteger(row.seatEpoch) && Number(row.seatEpoch) >= 1
          && typeof row.revokedAt === "string" && Number.isFinite(Date.parse(row.revokedAt))) {
          owners.push({ conversationId: row.conversationId, epoch: Number(row.seatEpoch) });
        }
      }
    }
    const recorded = owners.slice(0, OWNER_LIMIT);
    const capped = owners.length > recorded.length;
    let raced = false;
    this.mutate((tx, row) => {
      // Another controller may have progressed while the file was read.
      if (row.revision !== opening.revision) { raced = true; return; }
      for (const owner of recorded) {
        const id = key("owner", this.project, String(owner.epoch));
        const existing = tx.get(id);
        if (existing) {
          if (existing.kind !== "owner" || existing.conversationId !== owner.conversationId) throw new Error("contradictory predecessor ownership");
          continue;
        }
        const predecessor: AccountingOwner = { ...this.base("owner", String(owner.epoch)), kind: "owner", conversationId: owner.conversationId, epoch: owner.epoch, after: null, pollKey: "" };
        predecessor.pollKey = this.ticket(tx, row, "owner-poll", id);
        tx.put(predecessor);
      }
      /* A capped read is not remembered as this file: the next check reads it
         again and records the owners past the cap, which already exist by then
         and are skipped. */
      if (!capped) row.ownerScan = { identity, gap };
    });
    return gap || capped || raced;
  }
  /** Record one discovery page: the owner's sweep moves to `owner.after`, its
      ticket goes to the tail of the owner queue, and each child not yet known
      enters the poll queue — at the head when discovery already classified it
      terminal, so its ledger is read this check rather than behind every cold
      child before it. A turn another controller already took is skipped. */
  discovery(owner: AccountingOwner, children: readonly { child: AccountingChild; position?: TicketPosition }[]): void {
    this.mutate((tx, row) => {
      if (!tx.get(owner.pollKey)) return;
      for (const { child, position } of children) {
        const existing = tx.get(child.key);
        if (existing) {
          if (existing.kind !== "child") throw new Error("invalid child provenance");
          if (!existing.pollKey) tx.put({ ...existing, pollKey: this.ticket(tx, row, "poll", child.key, position) });
          continue;
        }
        child.pollKey = this.ticket(tx, row, "poll", child.key, position);
        this.trackRunning(tx, row, child);
        tx.put(child);
      }
      tx.delete(owner.pollKey);
      tx.put({ ...owner, pollKey: this.ticket(tx, row, "owner-poll", owner.key) });
    });
  }
  /** Adopt an old FIFO ticket by key, without scanning or rebuilding history. */
  adoptPoll(child: AccountingChild, ticketKey: string): AccountingChild {
    if (child.pollKey) return child;
    this.mutate((tx) => {
      const current = tx.get(child.key);
      const ticket = tx.get(ticketKey);
      if (current?.kind === "child" && !current.pollKey && ticket?.kind === "poll" && ticket.target === child.key) {
        tx.put({ ...current, pollKey: ticketKey });
      }
    });
    return this.get(child.key) as AccountingChild;
  }
  child(rowKey: string, owner: string, launchId: string, input: SeatTickChildInput): AccountingChild {
    const identity = outcomeIdentity([owner, rowKey, launchId]);
    return { ...this.base("child", identity), kind: "child", identity, rowKey, owner, launchId, input, generationIndex: 0, runningKey: null, pollKey: null };
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
  /** Record one poll of a child: its outcomes become owed rows, its running
      ticket follows its status, and its poll ticket is re-queued at `position`
      — the tail once its ledger was read to the end, the head when the budget
      cut the read, so the next check resumes it first. A poll another
      controller already recorded is skipped. */
  ingest(child: AccountingChild, source: AccountingSource | null, outcomes: LedgerOutcome[], failure = false, position: TicketPosition = "tail"): void {
    this.mutate((tx, row) => {
      if (!child.pollKey || !tx.get(child.pollKey)) return;
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
      this.trackRunning(tx, row, child);
      tx.delete(child.pollKey!);
      child.pollKey = this.ticket(tx, row, "poll", child.key, position);
      tx.put(child);
    });
  }
  /** Move a child's poll ticket to the head of its queue (#1465): a child the
      running window saw settle that this check's ledger budget could not
      reach is read first by the next check, not after every cold child. */
  promote(child: AccountingChild): void {
    if (!child.pollKey || this.atHead(child.pollKey, "poll")) return;
    this.mutate((tx, row) => {
      if (!tx.get(child.pollKey!)) return;
      tx.delete(child.pollKey!);
      child.pollKey = this.ticket(tx, row, "poll", child.key, "head");
      tx.put(child);
    });
  }
  /** Unchanged cold ledgers need only advance their FIFO tickets. Rotate the
      bounded visit batch in one transaction, preserving all evidence rows. */
  rotateCold(children: readonly AccountingChild[]): void {
    if (!children.length) return;
    this.mutate((tx, row) => {
      for (const child of children) {
        const current = tx.get(child.key);
        if (current?.kind !== "child" || !child.pollKey || current.pollKey !== child.pollKey || !tx.get(child.pollKey)) continue;
        tx.delete(child.pollKey);
        tx.put({ ...current, pollKey: this.ticket(tx, row, "poll", child.key) });
      }
    });
  }
  /** Remove a ticket its target no longer claims, so a stale one cannot be
      re-queued for ever beside the ticket the row does claim. */
  drop(ticket: AccountingRow): void {
    this.mutate((tx) => { if (tx.get(ticket.key)) tx.delete(ticket.key); });
  }
  /** Move observed running tickets to the tail of their queue, so the next
      check observes the children behind them. A ticket its child no longer
      claims is stale and is dropped. */
  rotateRunning(tickets: readonly AccountingRow[]): void {
    if (tickets.length === 0) return;
    this.mutate((tx, row) => {
      for (const ticket of tickets) {
        if (ticket.kind !== "running" || !tx.get(ticket.key)) continue;
        tx.delete(ticket.key);
        const child = tx.get(ticket.target);
        if (!child || child.kind !== "child" || child.runningKey !== ticket.key) continue;
        child.runningKey = child.input.status === "running" ? this.ticket(tx, row, "running", child.key) : null;
        tx.put(child);
      }
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
  /** Freeze the attempt on the row, or refuse without touching it: a refusal
      moves no revision, so the check that was refused for want of a finished
      import or behind an outstanding attempt can still write its own state. */
  prepare(state: SeatTickProjectState, wake: SeatTickOutstandingWake): boolean {
    return this.collection.boundedPatch(4096, (tx) => {
      const row = tx.get(key("project", this.project));
      if (!row || row.kind !== "project") throw new Error("accounting migration has not completed");
      if (row.revision !== state.accounting?.revision || row.state.outstandingWake || row.migration !== "ready") return false;
      for (const id of wake.commit.children) {
        const outcome = tx.get(key("outcome", this.project, id));
        if (!outcome || outcome.kind !== "outcome" || outcome.status !== "owed" || outcome.gap) return false;
      }
      row.state = { ...state, accounting: undefined, harvestedChildren: [], outstandingWake: wake };
      row.revision++;
      tx.put(row);
      return true;
    });
  }
  /** A dispatch claims the exact attempt it read before entering any async
      transport. No expiry: an interrupted caller may still reserve or actuate. */
  beginDispatch(expected: SeatTickOutstandingWake): string | null {
    return this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (!wake || wake.clientMessageId !== expected.clientMessageId || (wake.dispatch && wake.dispatch.state !== "refused")
        || wake.dispatch?.token !== expected.dispatch?.token) return null;
      const token = crypto.randomUUID();
      row.state.outstandingWake = { ...wake, dispatch: { token, state: "active" } };
      return token;
    });
  }
  /** Record transport's return. A throw keeps admission active and unresolved;
      only a refusal with no handle contributes to a later absence proof. */
  returnedDispatch(expectedKey: string, token: string, refused: boolean): void {
    this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (wake?.clientMessageId === expectedKey && wake.dispatch?.token === token && wake.dispatch.state === "active") {
        row.state.outstandingWake = { ...wake, dispatch: { token, state: refused ? "refused" : "returned" } };
        return;
      }
      /* The seat may have been superseded while this call was still out, which
         moves the attempt to the retired slot (#1594). What the call returned
         is a fact about the attempt, so it is recorded wherever the attempt now
         is; dropping it would leave a retired entry claiming a transport call
         is still in flight for as long as the row lives. */
      const retired = row.state.retiredWakes ?? [];
      const index = retired.findIndex((entry) => entry.wake.clientMessageId === expectedKey
        && entry.wake.dispatch?.token === token && entry.wake.dispatch.state === "active");
      if (index < 0) return;
      const next = [...retired];
      next[index] = { ...next[index]!, wake: { ...next[index]!.wake, dispatch: { token, state: refused ? "refused" : "returned" } } };
      row.state = { ...row.state, retiredWakes: next };
    });
  }
  cancelUndispatched(expected: SeatTickOutstandingWake): boolean {
    return this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (!wake || wake.clientMessageId !== expected.clientMessageId || wake.dispatch) return false;
      row.state.outstandingWake = null;
      return true;
    });
  }
  /** After authoritative absence, release only the returned dispatch that was
      observed. This transaction also denies all stale dispatch admissions. */
  settleAbsent(expected: SeatTickOutstandingWake): boolean {
    return this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (!wake || wake.clientMessageId !== expected.clientMessageId || wake.operationId || !wake.text
        || wake.dispatch?.state !== "refused" || wake.dispatch.token !== expected.dispatch?.token) return false;
      row.state.outstandingWake = null;
      return true;
    });
  }
  /**
   * Move the outstanding attempt to the retired slot (#1594).
   *
   * The attempt is taken from the ROW rather than from `expected`, so a
   * dispatch state another transaction recorded between the read and here
   * travels with it. Nothing else about it changes: same key, same payload,
   * same landing plan. What changes is that it no longer fences the next wake.
   *
   * Refused when the row moved on to another attempt, and refused at the bound
   * — a project that has reached it keeps the fence, which is what the tick did
   * before this existed, rather than discarding an obligation to make room.
   */
  retire(expected: SeatTickOutstandingWake, retiredAt: string, supersededBy: SeatTickRetiredWake["supersededBy"]): boolean {
    return this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (!wake || wake.clientMessageId !== expected.clientMessageId) return false;
      const retired = row.state.retiredWakes ?? [];
      if (retired.length >= SEAT_TICK_RETIRED_WAKE_LIMIT) return false;
      row.state = { ...row.state, outstandingWake: null, retiredWakes: [...retired, { wake, retiredAt, supersededBy }] };
      return true;
    });
  }
  /** End a retired attempt, once its holder has accounted for it (#1594). It
      touches nothing else on the row: a retired attempt credits no stamp, no
      cursor and no child whatever became of it, because whatever became of it
      happened to a seat this project has replaced. */
  settleRetired(clientMessageId: string): boolean {
    return this.mutate((tx, row) => {
      const retired = row.state.retiredWakes ?? [];
      const next = retired.filter((entry) => entry.wake.clientMessageId !== clientMessageId);
      if (next.length === retired.length) return false;
      row.state = { ...row.state, retiredWakes: next };
      return true;
    });
  }
  /** End the prepared attempt under `expectedKey` (#1465). See
      {@link WakeDisposition} for what each ending stamps. `state` carries the
      instant a landing is stamped at, on `lastWakeAt`. */
  settle(expectedKey: string, state: SeatTickProjectState, disposition: WakeDisposition): boolean {
    return this.mutate((tx, row) => {
      const wake = row.state.outstandingWake;
      if (!wake || wake.clientMessageId !== expectedKey || (disposition === "unsent" && wake.dispatch?.state === "active")) return false;
      if (disposition === "landed") for (const id of wake.commit.children) {
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
      const current = disposition === "landed" ? seatTickWakeCommit(row.state, wake.commit, Date.parse(state.lastWakeAt!)) : row.state;
      row.state = { ...current, accounting: undefined, harvestedChildren: [], outstandingWake: null };
      return true;
    });
  }
}
