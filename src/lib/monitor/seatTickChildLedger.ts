import fs from "node:fs";

/** Persistable streaming parser for the existing JSONL runtime ledger. Only
 * the four outcome fields are retained; item bodies and deltas are validated
 * and discarded as bytes arrive. No transcript or whole-ledger read. */
type Frame = { kind: "object" | "array"; phase: "key" | "colon" | "value" | "comma" | "end"; key?: string; path: string[]; index: number };
export interface LedgerCursor {
  offset: number;
  identity: string | null;
  seq: number;
  activeTurn: string | null;
  settledThrough: number;
  atEnd: boolean;
  initialSize: number;
  parser: { stack: Frame[]; token: string; mode: "idle" | "string" | "scalar"; escape: boolean; unicode: number; keep: boolean; rootDone: boolean; bad: boolean; fields: Record<string, unknown>; select?: string[]; captures?: { path: string[]; value: unknown }[] };
  gap: string | null;
}
export interface LedgerOutcome { turnId: string; status: "completed" | "interrupted" | "error"; seq: number; endOffset: number }
const emptyParser = (): LedgerCursor["parser"] => ({ stack: [], token: "", mode: "idle", escape: false, unicode: 0, keep: false, rootDone: false, bad: false, fields: {} });
export const emptyLedgerCursor = (): LedgerCursor => ({ offset: 0, identity: null, seq: 0, activeTurn: null, settledThrough: 0, atEnd: false, initialSize: 0, parser: emptyParser(), gap: null });
const FIELDS = new Set(["kind", "turnId", "status", "seq"]);

export function consumeMonitorJsonByte(parser: LedgerCursor["parser"], char: string): void {
  if (parser.bad) return;
  const top = () => parser.stack.at(-1);
  const valuePath = (frame: Frame) => [...frame.path, frame.kind === "array" ? String(frame.index) : frame.key ?? ""];
  const selected = (parts: string[]) => {
    if (!parser.select) return false;
    if (parts.length === 1 && (parts[0] === "version" || (parser.select[0] === "revocations" && parts[0] === "schemaVersion"))) return true;
    if (parser.select[0] === "revocations") return parts.length === 3 && parts[0] === "revocations" && ["project", "conversationId", "seatEpoch", "revokedAt", "successorConversationId"].includes(parts[2]!);
    if (!parser.select.every((part, index) => parts[index] === part)) return false;
    const field = parts[parser.select.length];
    return ["seatEpoch", "lastCheckAt", "lastWakeAt", "lastWakeReasons", "wakesWithoutChange", "quietSince", "idleSince", "lastProposalAt", "stalledSeen", "lastWakeFingerprint", "eventsThrough", "outstandingWake", "pullRequestGap", "harvestedChildren"].includes(field ?? "");
  };
  const value = (decoded: unknown, container = false) => {
    const frame = top();
    if (!frame || frame.phase !== "value") { parser.bad = true; return; }
    if (parser.stack.length === 1 && frame.key && FIELDS.has(frame.key)) {
      if (Object.hasOwn(parser.fields, frame.key)) { parser.bad = true; return; }
      parser.fields[frame.key] = decoded;
    }
    if (!container && selected(valuePath(frame))) (parser.captures ??= []).push({ path: valuePath(frame), value: decoded });
    frame.phase = "comma";
    if (frame.kind === "array") frame.index++;
  };
  if (parser.mode === "string") {
    if (parser.keep) {
      if (parser.token.length >= 4096) { parser.bad = true; return; }
      parser.token += char;
    }
    if (parser.unicode) {
      if (!/[0-9a-f]/i.test(char)) parser.bad = true;
      parser.unicode--;
    } else if (parser.escape) {
      parser.escape = false;
      if (char === "u") parser.unicode = 4;
      else if (!'"\\/bfnrt'.includes(char)) parser.bad = true;
    } else if (char === "\\") parser.escape = true;
    else if (char === '"') {
      let decoded: unknown = null;
      if (parser.keep) {
        try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parser.token, "latin1"))); }
        catch { parser.bad = true; return; }
      }
      const frame = top();
      if (frame?.kind === "object" && (frame.phase === "key" || frame.phase === "end")) {
        frame.key = typeof decoded === "string" ? decoded : "";
        frame.phase = "colon";
      } else value(decoded);
      parser.mode = "idle";
      parser.token = "";
    } else if (char.charCodeAt(0) < 32) parser.bad = true;
    return;
  }
  if (parser.mode === "scalar") {
    if (!/[ \t\r\n,\]}]/.test(char)) {
      if (parser.token.length >= 128) { parser.bad = true; return; }
      parser.token += char;
      return;
    }
    try {
      const parsed = JSON.parse(parser.token);
      if (parsed !== null && !["number", "boolean"].includes(typeof parsed)) throw new Error("scalar expected");
      value(parsed);
    } catch { parser.bad = true; return; }
    parser.mode = "idle";
    parser.token = "";
  }
  if (/[ \t\r\n]/.test(char)) return;
  if (parser.rootDone) { parser.bad = true; return; }
  const frame = top();
  if (char === "}" || char === "]") {
    if (!frame || frame.kind !== (char === "}" ? "object" : "array") || !["comma", "end"].includes(frame.phase)) { parser.bad = true; return; }
    if (parser.select?.[0] === "revocations" && frame.path.length === 2 && frame.path[0] === "revocations") (parser.captures ??= []).push({ path: [...frame.path, "$end"], value: true });
    parser.stack.pop();
    if (!parser.stack.length) parser.rootDone = true;
    return;
  }
  if (char === ",") {
    if (!frame || frame.phase !== "comma") { parser.bad = true; return; }
    frame.phase = frame.kind === "object" ? "key" : "value";
    return;
  }
  if (char === ":") {
    if (!frame || frame.phase !== "colon") parser.bad = true;
    else frame.phase = "value";
    return;
  }
  if (char === '"') {
    const key = frame?.kind === "object" && ["key", "end"].includes(frame.phase);
    if (!key && frame?.phase !== "value" && !(frame?.kind === "array" && frame.phase === "end")) { parser.bad = true; return; }
    if (frame?.kind === "array" && frame.phase === "end") frame.phase = "value";
    parser.keep = key ? (parser.select !== undefined || parser.stack.length === 1) : (frame !== undefined && selected(valuePath(frame))) || (parser.stack.length === 1 && FIELDS.has(frame?.key ?? ""));
    parser.token = parser.keep ? '"' : "";
    parser.mode = "string";
    return;
  }
  if (frame?.kind === "array" && frame.phase === "end") frame.phase = "value";
  if (char === "{" || char === "[") {
    if (parser.select && parser.stack.length === 1 && frame?.key === "projects") parser.fields.projects = char === "{";
    const childPath = frame ? valuePath(frame) : [];
    if (frame) value(null, true);
    else if (char !== "{") { parser.bad = true; return; }
    if (parser.stack.length >= 64) { parser.bad = true; return; }
    parser.stack.push({ kind: char === "{" ? "object" : "array", phase: "end", path: childPath, index: 0 });
    return;
  }
  if (!frame || frame.phase !== "value") { parser.bad = true; return; }
  parser.mode = "scalar";
  parser.token = char;
}

export function readChildLedger(filename: string, previous: LedgerCursor, byteLimit: number, recordLimit: number): {
  cursor: LedgerCursor; outcomes: LedgerOutcome[]; bytes: number; records: number;
} {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 262144 || !Number.isSafeInteger(recordLimit) || recordLimit < 1 || recordLimit > 200) throw new Error("invalid ledger budget");
  let cursor = structuredClone(previous);
  const outcomes: LedgerOutcome[] = [];
  let fd: number | undefined;
  let bytes = 0;
  let records = 0;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("ledger is not a regular file");
    const identity = `${stat.dev}:${stat.ino}`;
    if (cursor.identity !== identity || stat.size < cursor.offset) {
      cursor = { ...emptyLedgerCursor(), identity, initialSize: stat.size, gap: previous.identity ? "ledger-replaced" : previous.gap };
    }
    if (cursor.gap === "ledger-unreadable") cursor.gap = null;
    const buffer = Buffer.alloc(Math.min(byteLimit, 16384));
    while (bytes < byteLimit && records < recordLimit) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, byteLimit - bytes), cursor.offset);
      if (!length) break;
      bytes += length;
      for (let i = 0; i < length; i++) {
        const c = String.fromCharCode(buffer[i]!);
        cursor.offset++;
        if (c !== "\n") consumeMonitorJsonByte(cursor.parser, c);
        else {
          consumeMonitorJsonByte(cursor.parser, " ");
          const { fields, bad, rootDone } = cursor.parser;
          if (bad || !rootDone || !Number.isSafeInteger(fields.seq) || (fields.seq as number) <= 0 || typeof fields.kind !== "string") cursor.gap = "malformed-record";
          else {
            const seq = fields.seq as number;
            if (seq !== cursor.seq + 1) cursor.gap = "sequence-gap";
            cursor.seq = seq;
            if (fields.kind === "turn-started") {
              if (typeof fields.turnId === "string" && fields.turnId) cursor.activeTurn = fields.turnId;
              else cursor.gap = "invalid-turn-start";
            }
            if (fields.kind === "turn-ended") {
              if (typeof fields.turnId === "string" && fields.turnId.length > 0 && ["completed", "interrupted", "error"].includes(String(fields.status))) {
                if (cursor.activeTurn === null || cursor.activeTurn === fields.turnId) { cursor.activeTurn = null; cursor.settledThrough = seq; }
                outcomes.push({ turnId: fields.turnId, status: fields.status as LedgerOutcome["status"], seq, endOffset: cursor.offset });
              } else cursor.gap = "invalid-terminal";
            }
          }
          cursor.parser = emptyParser();
          records++;
          if (records >= recordLimit) break;
        }
      }
    }
    cursor.atEnd = cursor.offset === stat.size;
  } catch { cursor.gap = "ledger-unreadable"; cursor.atEnd = false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return { cursor, outcomes, bytes, records };
}
