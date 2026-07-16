import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { RuntimeEvent } from "./engineHost";

export interface RuntimeEventStore {
  load(threadId: string): RuntimeEvent[];
  append(threadId: string, event: RuntimeEvent): void;
}

export interface RuntimeEventCursorRecoveryDiagnostic {
  kind: "runtime-event-cursor-recovery";
  sessionId: string;
  durableTailSeq: number;
  registryCursor: number;
  chosenNextSeq: number;
  action: "use-durable-tail" | "use-registry-cursor";
  relation: "registry-behind" | "registry-ahead" | "durable-ledger-empty";
}

export type RuntimeEventCursorRecoveryReporter = (diagnostic: RuntimeEventCursorRecoveryDiagnostic) => void;

const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 160;

function reportRuntimeEventCursorRecovery(diagnostic: RuntimeEventCursorRecoveryDiagnostic): void {
  console.warn("[structured host] runtime event cursor recovered", diagnostic);
}

export function nextRuntimeEventSequence(cursor: number): number {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("runtime event cursor is invalid");
  }
  const next = cursor + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("runtime event cursor cannot advance safely");
  }
  return next;
}

export function reconcileRuntimeEventCursor(
  sessionId: string,
  durableTailSeq: number,
  registryCursor: number,
  report: RuntimeEventCursorRecoveryReporter = reportRuntimeEventCursorRecovery,
): number {
  if (!Number.isSafeInteger(durableTailSeq) || durableTailSeq < 0) {
    throw new Error("runtime event durable tail sequence is invalid");
  }
  if (!Number.isSafeInteger(registryCursor) || registryCursor < 0) {
    throw new Error("runtime event registry cursor is invalid");
  }
  const useRegistryCursor = durableTailSeq === 0 && registryCursor > 0;
  const cursor = useRegistryCursor ? registryCursor : durableTailSeq;
  const chosenNextSeq = nextRuntimeEventSequence(cursor);
  if (registryCursor !== durableTailSeq) {
    try {
      report({
        kind: "runtime-event-cursor-recovery",
        sessionId: sessionId.slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH),
        durableTailSeq,
        registryCursor,
        chosenNextSeq,
        action: useRegistryCursor ? "use-registry-cursor" : "use-durable-tail",
        relation: useRegistryCursor
          ? "durable-ledger-empty"
          : registryCursor < durableTailSeq ? "registry-behind" : "registry-ahead",
      });
    } catch { /* diagnostics never fence durable recovery */ }
  }
  return cursor;
}

function validEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) <= 0) return false;
  const nonEmptyString = (field: unknown): field is string => typeof field === "string" && field.length > 0;
  switch (event.kind) {
    case "turn-started":
      return nonEmptyString(event.turnId);
    case "delta":
      return nonEmptyString(event.turnId) && typeof event.text === "string";
    case "item":
      return (nonEmptyString(event.turnId) || event.turnId === null)
        && (event.phase === "started" || event.phase === "completed")
        && Object.hasOwn(event, "item");
    case "turn-ended":
      return nonEmptyString(event.turnId)
        && (event.status === "completed" || event.status === "interrupted" || event.status === "error");
    case "attention":
      return nonEmptyString(event.id) && nonEmptyString(event.method) && Object.hasOwn(event, "attention");
    case "attention-resolved":
      return nonEmptyString(event.id)
        && (event.resolution === "answered" || event.resolution === "host-restarted" || event.resolution === "server-resolved");
    case "limits":
      return Object.hasOwn(event, "snapshot");
    case "session-status":
      return (event.status === "active" || event.status === "idle" || event.status === "unhosted" || event.status === "dead")
        && (event.activeFlags === undefined
          || (Array.isArray(event.activeFlags) && event.activeFlags.every(nonEmptyString)));
    default:
      return false;
  }
}

export class FileRuntimeEventStore implements RuntimeEventStore {
  constructor(private readonly directory = statePath("structured-host-events")) {}

  load(threadId: string): RuntimeEvent[] {
    const filename = this.filename(threadId);
    let contents: string;
    try { contents = fs.readFileSync(filename, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: RuntimeEvent[] = [];
    const lines = contents.split("\n");
    const hasTerminatingNewline = contents.endsWith("\n");
    for (const [index, line] of lines.entries()) {
      if (!line && index === lines.length - 1 && hasTerminatingNewline) continue;
      if (!line) throw new Error("runtime event ledger contains an empty record");
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch {
        if (index === lines.length - 1 && !hasTerminatingNewline) break;
        throw new Error("runtime event ledger contains malformed JSON");
      }
      if (!validEvent(parsed)) {
        if (index === lines.length - 1 && !hasTerminatingNewline) break;
        throw new Error("runtime event ledger contains an invalid event");
      }
      const previous = events.at(-1);
      if (previous && parsed.seq !== previous.seq + 1) {
        throw new Error(`runtime event ledger sequence gap after ${previous.seq}`);
      }
      events.push(parsed);
    }
    return events;
  }

  append(threadId: string, event: RuntimeEvent): void {
    if (!validEvent(event)) throw new Error("runtime event ledger append event is invalid");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(threadId);
    const previous = this.load(threadId).at(-1);
    if (previous && event.seq !== previous.seq + 1) {
      throw new Error(`runtime event ledger sequence gap after ${previous.seq}`);
    }
    const fd = fs.openSync(filename, "a+", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const contents = fs.readFileSync(filename, "utf8");
        if (!contents.endsWith("\n")) {
          const boundary = contents.lastIndexOf("\n") + 1;
          const tail = contents.slice(boundary);
          let parsed: unknown;
          try { parsed = JSON.parse(tail); } catch { parsed = null; }
          if (validEvent(parsed)) fs.writeSync(fd, "\n");
          else fs.ftruncateSync(fd, Buffer.byteLength(contents.slice(0, boundary)));
        }
      }
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private filename(threadId: string): string {
    return path.join(this.directory, `${encodeURIComponent(threadId)}.jsonl`);
  }
}
