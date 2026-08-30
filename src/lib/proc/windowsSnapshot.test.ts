import { expect, test } from "bun:test";

import {
  looksLikeAgentArgv,
  normalizeWindowsCwd,
  parseCsvRows,
  parseWindowsCommandLine,
  parseWindowsProcessSnapshot,
  snapshotEntries,
  windowsParentLinks,
  type WindowsProcessRow,
} from "./windowsSnapshot";

/*
 * Every rule the Windows backend applies to bytes is a pure function, and this
 * file runs on every platform. What it cannot prove is that a real
 * `Get-CimInstance Win32_Process` produces these bytes — that is the
 * `windows-latest` leg of `platform-tests.yml`, which runs the real call and
 * requires this parser to find the runner's own process in the result.
 */

function csv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}

const HEADER = [
  "ProcessId",
  "ParentProcessId",
  "CommandLine",
  "WorkingSetSize",
  "UserModeTime",
  "KernelModeTime",
  "Created",
];

test("argv[0] keeps a quoted program path with spaces as one token", () => {
  expect(parseWindowsCommandLine('"C:\\Program Files\\nodejs\\claude.exe" -p "hello world"')).toEqual([
    "C:\\Program Files\\nodejs\\claude.exe",
    "-p",
    "hello world",
  ]);
});

test("argv[0] never treats a backslash as an escape", () => {
  /* CommandLineToArgvW's documented exception: in the program name a backslash
     is a separator, never an escape, so a bare Windows path survives whole. */
  expect(parseWindowsCommandLine("C:\\tools\\claude.exe --version")).toEqual([
    "C:\\tools\\claude.exe",
    "--version",
  ]);
});

test("backslash runs before a quote follow the 2n / 2n+1 rule", () => {
  expect(parseWindowsCommandLine('claude.exe a\\\\"b c" d')).toEqual(["claude.exe", "a\\b c", "d"]);
  expect(parseWindowsCommandLine('claude.exe a\\\\\\"b')).toEqual(["claude.exe", 'a\\"b']);
  expect(parseWindowsCommandLine("claude.exe a\\\\b")).toEqual(["claude.exe", "a\\\\b"]);
});

test("a doubled quote inside a quoted argument is one literal quote", () => {
  expect(parseWindowsCommandLine('claude.exe "say ""hi"" now"')).toEqual(["claude.exe", 'say "hi" now']);
});

test("an empty command line yields no argv rather than one empty token", () => {
  expect(parseWindowsCommandLine("")).toEqual([]);
  expect(parseWindowsCommandLine("   ")).toEqual([]);
});

test("the CSV reader handles quoted commas, doubled quotes, CRLF and unquoted cells", () => {
  expect(parseCsvRows('"a","b,c","d""e"\r\n"1","2","3"\r\n')).toEqual([
    ["a", "b,c", 'd"e'],
    ["1", "2", "3"],
  ]);
  expect(parseCsvRows("a,b\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
});

test("a parent created after its child is not a parent", () => {
  /* Windows does not re-parent orphans and reissues a freed pid within seconds,
     so ParentProcessId can name an unrelated live process. The tree walk that
     terminates a host would otherwise reach it. */
  const rows = new Map<number, WindowsProcessRow>([
    [100, { pid: 100, rawPpid: 4, argv: [], created: BigInt(200), workingSetBytes: 0, cpuMs: null }],
    [4, { pid: 4, rawPpid: null, argv: [], created: BigInt(500), workingSetBytes: 0, cpuMs: null }],
    [200, { pid: 200, rawPpid: 4, argv: [], created: BigInt(900), workingSetBytes: 0, cpuMs: null }],
  ]);
  const links = windowsParentLinks(rows);
  expect(links.get(100)).toBeUndefined();
  expect(links.get(200)).toBe(4);
});

test("a link to a pid absent from the snapshot, and a self-link, are dropped", () => {
  const rows = new Map<number, WindowsProcessRow>([
    [10, { pid: 10, rawPpid: 999, argv: [], created: BigInt(1), workingSetBytes: 0, cpuMs: null }],
    [11, { pid: 11, rawPpid: 11, argv: [], created: BigInt(1), workingSetBytes: 0, cpuMs: null }],
  ]);
  expect([...windowsParentLinks(rows).keys()]).toEqual([]);
});

test("the snapshot parse reads every column and survives an unusable row", () => {
  const snapshot = parseWindowsProcessSnapshot(csv([
    HEADER,
    ["0", "0", "", "8192", "", "", ""],
    ["not-a-pid", "4", "x", "1", "0", "0", "1"],
    [
      "1234",
      "4",
      'C:\\agents\\claude\\claude.exe --session-id abc',
      "5242880",
      "21200000",
      "10000000",
      "133700000000000000",
    ],
    ["4", "0", "", "40960", "", "", ""],
  ]));

  expect(snapshot.rows.get(1234)).toEqual({
    pid: 1234,
    rawPpid: 4,
    argv: ["C:\\agents\\claude\\claude.exe", "--session-id", "abc"],
    created: BigInt("133700000000000000"),
    workingSetBytes: 5_242_880,
    cpuMs: 3_120,
  });
  expect(snapshot.ppids.get(1234)).toBe(4);
  /* System reports no creation time; it stays a usable row, and the ordering
     rule simply has nothing to compare it against. pid 0 (Idle) is not a
     process this backend can describe at all. */
  expect(snapshot.rows.get(4)?.created).toBeNull();
  /* Both CPU columns absent is "no reading", never zero: an evidence-based
     liveness verdict must not read a missing column as an idle process. */
  expect(snapshot.rows.get(4)?.cpuMs).toBeNull();
  expect(snapshot.rows.has(0)).toBe(false);
  expect(snapshot.rows.size).toBe(2);
});

test("a byte-order mark ahead of the header does not hide every column", () => {
  const snapshot = parseWindowsProcessSnapshot("\ufeff" + csv([HEADER, ["7", "1", "x.exe", "1", "0", "0", "133700000000000000"]]));
  expect(snapshot.rows.get(7)?.argv).toEqual(["x.exe"]);
});

test("a header without ProcessId yields an empty snapshot instead of nonsense rows", () => {
  expect(parseWindowsProcessSnapshot(csv([["Name"], ["explorer"]])).rows.size).toBe(0);
  expect(parseWindowsProcessSnapshot("").rows.size).toBe(0);
});

test("a DosPath loses its trailing separator, except at a drive root", () => {
  expect(normalizeWindowsCwd("C:\\work\\proj\\")).toBe("C:\\work\\proj");
  expect(normalizeWindowsCwd("c:\\work\\proj")).toBe("C:\\work\\proj");
  /* `C:` alone is the current directory on C:, which is not `C:\`. */
  expect(normalizeWindowsCwd("C:\\")).toBe("C:\\");
  expect(normalizeWindowsCwd("")).toBeNull();
  expect(normalizeWindowsCwd("C:\\work\\proj\\\0garbage")).toBe("C:\\work\\proj");
});

test("only rows that could be an agent pay for a working-directory read", () => {
  /* Reading a cwd costs an OpenProcess plus three ReadProcessMemory calls.
     Paying it for every process on the host is what this predicate prevents. */
  const snapshot = parseWindowsProcessSnapshot(csv([
    HEADER,
    ["1", "0", "C:\\Windows\\explorer.exe", "1", "0", "0", "10"],
    ["2", "1", '"C:\\Program Files\\claude\\claude.exe" -p hi', "1", "0", "0", "20"],
    ["3", "1", "C:\\bun\\bun.exe C:\\tools\\codex.exe app-server", "1", "0", "0", "20"],
  ]));
  const asked: number[] = [];
  const entries = snapshotEntries(snapshot, (pid) => {
    asked.push(pid);
    return "C:\\work";
  }, 1);

  expect(asked.sort()).toEqual([2, 3]);
  expect(entries.find((entry) => entry.pid === 1)?.cwd).toBeNull();
  expect(entries.find((entry) => entry.pid === 2)?.cwd).toBe("C:\\work");
  expect(entries.every((entry) => entry.tty === 1)).toBe(true);
});

test("the agent predicate matches the scanner's basename rule on both separators", () => {
  expect(looksLikeAgentArgv(["C:\\x\\claude.exe"])).toBe(true);
  expect(looksLikeAgentArgv(["/usr/bin/codex"])).toBe(true);
  expect(looksLikeAgentArgv(["C:\\bun.exe", "C:\\y\\codex.exe"])).toBe(true);
  expect(looksLikeAgentArgv(["C:\\x\\codex-telegram-mcp.exe"])).toBe(false);
  expect(looksLikeAgentArgv(["node", "server.js", "claude.exe"])).toBe(false);
});
