import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { darwinProcessArgv, parseDarwinProcArgs2 } from "./darwinArgv";

/** One KERN_PROCARGS2 record as the macOS kernel lays it out: argc, the
    executable path, NUL padding to alignment, then the argument strings and
    the environment behind them. */
function procArgs2Record(argc: number, execPath: string, args: string[], environment: string[] = [], padding = 3): Buffer {
  const head = Buffer.alloc(4);
  head.writeInt32LE(argc, 0);
  return Buffer.concat([
    head,
    Buffer.from(`${execPath}\0`, "utf8"),
    Buffer.alloc(padding),
    ...[...args, ...environment].map((entry) => Buffer.from(`${entry}\0`, "utf8")),
  ]);
}

test("a kernel argument record yields argv alone, past the executable path and short of the environment", () => {
  const record = procArgs2Record(5, "/bin/sh", ["/opt/homebrew/bin/claude", "auth", "login", "--claudeai", "extra-because-argc-says-so"], ["HOME=/Users/user", "PATH=/usr/bin"]);

  expect(parseDarwinProcArgs2(record, record.byteLength))
    .toEqual(["/opt/homebrew/bin/claude", "auth", "login", "--claudeai", "extra-because-argc-says-so"]);
});

test("an argument containing spaces survives the read that `ps` output cannot express", () => {
  const record = procArgs2Record(2, "/usr/bin/env", ["/Users/user/Application Support/claude", "auth login"]);

  expect(parseDarwinProcArgs2(record, record.byteLength))
    .toEqual(["/Users/user/Application Support/claude", "auth login"]);
});

test("a record the kernel could not write in full is refused rather than half-read", () => {
  const record = procArgs2Record(4, "/usr/local/bin/claude", ["/usr/local/bin/claude", "auth", "login", "--claudeai"]);

  // Whole record: four arguments. Cut short: no argv at all, never a prefix.
  expect(parseDarwinProcArgs2(record, record.byteLength)).toHaveLength(4);
  expect(parseDarwinProcArgs2(record, record.byteLength - 3)).toBeNull();
  expect(parseDarwinProcArgs2(record, 4)).toBeNull();
  expect(parseDarwinProcArgs2(record, 2)).toBeNull();
  expect(parseDarwinProcArgs2(record, record.byteLength + 1)).toBeNull();
});

test("a record with an impossible argument count is refused", () => {
  const args = ["/usr/local/bin/claude", "auth", "login", "--claudeai"];
  const withCount = (argc: number) => {
    const record = procArgs2Record(argc, "/usr/local/bin/claude", args);
    return parseDarwinProcArgs2(record, record.byteLength);
  };

  expect(withCount(0)).toBeNull();
  expect(withCount(-1)).toBeNull();
  expect(withCount(9_999)).toBeNull();

  // argc promises more arguments than the record carries.
  const short = procArgs2Record(6, "/usr/local/bin/claude", args);
  expect(parseDarwinProcArgs2(short, short.byteLength)).toBeNull();
});

test("a record without a terminated executable path is refused", () => {
  const head = Buffer.alloc(4);
  head.writeInt32LE(1, 0);
  const record = Buffer.concat([head, Buffer.from("/usr/local/bin/claude", "utf8")]);

  expect(parseDarwinProcArgs2(record, record.byteLength)).toBeNull();
});

test("the reader answers null for a pid it cannot identify, and never guesses", () => {
  expect(darwinProcessArgv(0)).toBeNull();
  expect(darwinProcessArgv(-1)).toBeNull();
  expect(darwinProcessArgv(1.5)).toBeNull();
  // Off darwin there is no kernel record to read: the reader stays closed
  // rather than reaching for /proc or `ps`.
  if (process.platform !== "darwin") expect(darwinProcessArgv(process.pid)).toBeNull();
});

test.skipIf(process.platform !== "darwin")("on macOS the reader returns the exec-time argv of a live child", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-darwin-argv-"));
  const script = path.join(directory, "sleeper");
  /* The child announces itself before it blocks: a pid exists before the image
     it will run does, and until the exec lands the kernel has no argument
     record for that image to hand back — the same window claudeLogin's fence
     polls through. Reading the moment `spawn` returns races that window, so
     the read below waits for a byte only the executed script can have
     written. */
  fs.writeFileSync(script, "#!/bin/sh\necho executed\nwhile read -r _line; do :; done\n", { mode: 0o755 });
  const child = spawn(script, ["first argument", "second"], { stdio: ["pipe", "pipe", "ignore"] });
  const pid = child.pid ?? 0;
  try {
    expect(pid).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("the child exited before it announced its exec")));
    });
    // A #! script execs its interpreter, so argv[0] is the shell and argv[1]
    // the script — the same rewriting the Linux fence already matches.
    expect(darwinProcessArgv(pid)).toEqual(["/bin/sh", script, "first argument", "second"]);
    expect(darwinProcessArgv(process.pid)).not.toEqual(darwinProcessArgv(pid));
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }

  expect(darwinProcessArgv(pid)).toBeNull();
});
