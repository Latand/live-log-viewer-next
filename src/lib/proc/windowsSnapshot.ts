/**
 * Pure parsers behind the Windows proc backend. Nothing here touches the
 * filesystem, spawns a process or loads FFI, so every rule below is unit-
 * testable on Linux and macOS as well — which matters because nobody working
 * on this repository has a Windows machine and the only live exercise of the
 * backend is the `windows-latest` leg of `platform-tests.yml`.
 *
 * The snapshot source is one Windows PowerShell call per TTL:
 *
 *   Get-CimInstance Win32_Process |
 *     Select-Object ProcessId, ParentProcessId, CommandLine, WorkingSetSize,
 *       @{n='Created';e={$_.CreationDate.ToFileTimeUtc()}} |
 *     ConvertTo-Csv -NoTypeInformation
 *
 * CSV rather than JSON because Windows PowerShell 5.1 serialises a DateTime
 * into JSON as `/Date(ms)/` and loses everything below the millisecond.
 */

import type { ProcSnapshotEntry } from "./types";

/** One row of the Win32_Process projection above. */
export interface WindowsProcessRow {
  pid: number;
  /** Parent pid as the snapshot reported it, before the stale-link filter. */
  rawPpid: number | null;
  argv: string[];
  /**
   * Process creation time as a FILETIME (100 ns ticks since 1601-01-01 UTC),
   * or null when the column was empty — `Idle` and `System` report none.
   *
   * WMI's CreationDate is a CIM_DATETIME with *microsecond* resolution, so
   * this value is the kernel's creation time truncated to whole microseconds.
   * That is precise enough to order two processes, which is all this column is
   * used for. It is deliberately NOT the identity token: see
   * `windowsIdentity.ts`, which reads the untruncated value from the kernel.
   */
  created: bigint | null;
  workingSetBytes: number;
}

export interface WindowsSnapshot {
  rows: Map<number, WindowsProcessRow>;
  /** pid → ppid with stale parent links already dropped. */
  ppids: Map<number, number>;
}

/**
 * Splits a Windows command line the way `CommandLineToArgvW` does, which is
 * the only correct way to recover argv from `Win32_Process.CommandLine`:
 * the command line is a single string and the program path routinely contains
 * a space (`C:\Program Files\...`), so whitespace splitting — what the
 * portable backend does to `ps` output — would break `argvEngine`'s
 * basename match on argv[0].
 *
 * The rules, from the Windows documentation:
 *  - argv[0] is special: backslashes are never escapes there, and the token
 *    ends at the first whitespace, or at the closing quote when it opens with
 *    one.
 *  - Elsewhere, 2n backslashes before a quote produce n backslashes and the
 *    quote toggles quoting; 2n+1 produce n backslashes and a literal quote.
 *  - A quote inside a quoted block that is immediately followed by another
 *    quote produces one literal quote and stays quoted.
 */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = [];
  const text = commandLine ?? "";
  let index = 0;
  const skipBlanks = (): void => {
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  };

  skipBlanks();
  if (index >= text.length) return argv;

  /* argv[0]: quotes group, backslashes are literal. */
  let first = "";
  if (text[index] === '"') {
    index += 1;
    while (index < text.length && text[index] !== '"') {
      first += text[index];
      index += 1;
    }
    if (index < text.length) index += 1;
  } else {
    while (index < text.length && text[index] !== " " && text[index] !== "\t") {
      first += text[index];
      index += 1;
    }
  }
  argv.push(first);

  for (;;) {
    skipBlanks();
    if (index >= text.length) break;
    let arg = "";
    let quoted = false;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") {
        let backslashes = 0;
        while (index < text.length && text[index] === "\\") {
          backslashes += 1;
          index += 1;
        }
        if (text[index] === '"') {
          arg += "\\".repeat(backslashes >> 1);
          if (backslashes % 2 === 1) {
            arg += '"';
            index += 1;
            continue;
          }
        } else {
          arg += "\\".repeat(backslashes);
          continue;
        }
      }
      if (text[index] === '"') {
        index += 1;
        if (quoted && text[index] === '"') {
          arg += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (!quoted && (text[index] === " " || text[index] === "\t")) break;
      arg += text[index];
      index += 1;
    }
    argv.push(arg);
  }
  return argv;
}

/**
 * RFC 4180 rows out of `ConvertTo-Csv -NoTypeInformation` output. 5.1 quotes
 * every field and doubles embedded quotes; the parser also accepts unquoted
 * fields so a future PowerShell that quotes less does not silently return
 * nothing. Line endings are CRLF from PowerShell and LF from the fixtures.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endField = (): void => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = (): void => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

function toInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toFiletime(value: string | undefined): bigint | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed > BigInt(0) ? parsed : null;
}

/**
 * Windows never re-parents an orphan, and it hands a freed pid back within
 * seconds, so a row's ParentProcessId can name a live process that merely
 * inherited the dead parent's number. A tree walk that trusted it would kill
 * an unrelated process. Both creation times are already in the snapshot, so
 * the false link is recognisable: a parent cannot have started after its own
 * child. Links to a pid that is absent from the snapshot, and self-links, are
 * dropped for the same reason.
 */
export function windowsParentLinks(rows: Map<number, WindowsProcessRow>): Map<number, number> {
  const ppids = new Map<number, number>();
  for (const [pid, row] of rows) {
    const ppid = row.rawPpid;
    if (ppid === null || ppid <= 0 || ppid === pid) continue;
    const parent = rows.get(ppid);
    if (!parent) continue;
    if (parent.created !== null && row.created !== null && parent.created > row.created) continue;
    ppids.set(pid, ppid);
  }
  return ppids;
}

const COLUMNS = ["ProcessId", "ParentProcessId", "CommandLine", "WorkingSetSize", "Created"] as const;

/**
 * Parses the CSV projection into rows plus the filtered parent links. A row
 * whose ProcessId does not parse is skipped rather than throwing: the whole
 * scan degrading to nothing because one system row was odd is worse than
 * losing that row.
 */
export function parseWindowsProcessSnapshot(csv: string): WindowsSnapshot {
  const rows = new Map<number, WindowsProcessRow>();
  const parsed = parseCsvRows(csv);
  const header = parsed[0];
  if (!header) return { rows, ppids: new Map() };
  const at = new Map(COLUMNS.map((name) => [name, header.indexOf(name)] as const));
  const pidAt = at.get("ProcessId") ?? -1;
  if (pidAt < 0) return { rows, ppids: new Map() };
  const cell = (row: string[], name: (typeof COLUMNS)[number]): string | undefined => {
    const column = at.get(name) ?? -1;
    return column < 0 ? undefined : row[column];
  };
  for (const row of parsed.slice(1)) {
    const pid = toInteger(row[pidAt]);
    if (pid === null || pid <= 0) continue;
    rows.set(pid, {
      pid,
      rawPpid: toInteger(cell(row, "ParentProcessId")),
      argv: parseWindowsCommandLine(cell(row, "CommandLine") ?? ""),
      created: toFiletime(cell(row, "Created")),
      workingSetBytes: Math.max(0, toInteger(cell(row, "WorkingSetSize")) ?? 0),
    });
  }
  return { rows, ppids: windowsParentLinks(rows) };
}

/**
 * `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath` always carries a
 * trailing separator (`C:\work\proj\`); every caller compares it against a
 * `path.join`ed value, which never does. A bare drive root keeps its
 * separator, since `C:` alone means "the current directory on C:" to Windows
 * and is not the same path as `C:\`.
 */
export function normalizeWindowsCwd(raw: string): string | null {
  const trimmed = raw.replace(/\0.*$/s, "").trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed[0]!.toUpperCase() + ":\\";
  const stripped = trimmed.replace(/[\\/]+$/, "");
  if (!stripped) return null;
  return /^[a-z]:/.test(stripped) ? stripped[0]!.toUpperCase() + stripped.slice(1) : stripped;
}

/**
 * `agentProcesses` drops every process whose cwd is null, so a backend that
 * never resolved one would show zero agents. Resolving a cwd on Windows costs
 * an OpenProcess plus three ReadProcessMemory calls, which is far too much to
 * pay for every process on the host, so the backend pays it only for rows that
 * could possibly be an agent. This predicate is deliberately looser than
 * `argvEngine` — it does not know about helper arguments and matches the same
 * first two tokens — so the backend never has to import the scanner.
 */
export function looksLikeAgentArgv(argv: string[]): boolean {
  for (const token of argv.slice(0, 2)) {
    const base = token.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (base === "claude" || base === "claude.exe" || base === "codex" || base === "codex.exe") return true;
  }
  return false;
}

/** Snapshot rows as the backend's `listProcesses` contract wants them. */
export function snapshotEntries(
  snapshot: WindowsSnapshot,
  cwdFor: (pid: number) => string | null,
  tty: number,
): ProcSnapshotEntry[] {
  const list: ProcSnapshotEntry[] = [];
  for (const [pid, row] of snapshot.rows) {
    list.push({ pid, argv: row.argv, cwd: looksLikeAgentArgv(row.argv) ? cwdFor(pid) : null, tty });
  }
  return list;
}
