import { expect, test } from "bun:test";

import { linuxBackend } from "./linux";
import { portableBackend } from "./portable";
import { selectProcBackend } from "./index";
import { windowsBackend } from "./windows";

/*
 * Which backend a platform gets. This mattered enough to be worth its own file:
 * before the Windows backend existed, win32 fell through to `portableBackend`,
 * which shells out to `ps`, `lsof`, `vm_stat` and `sysctl` — so every scan
 * returned empty and every process was invisible, with nothing to say so.
 */

test("each platform selects the backend that can actually read it", () => {
  expect(selectProcBackend("linux", undefined).name).toBe("linux");
  expect(selectProcBackend("darwin", undefined).name).toBe("portable");
  expect(selectProcBackend("win32", undefined).name).toBe("windows");
  expect(selectProcBackend("freebsd", undefined).name).toBe("portable");
});

test("VIEWER_PROC_BACKEND forces one of the three, literally", () => {
  expect(selectProcBackend("linux", "portable")).toBe(portableBackend);
  expect(selectProcBackend("darwin", "linux")).toBe(linuxBackend);
  expect(selectProcBackend("linux", "windows")).toBe(windowsBackend);
  expect(selectProcBackend("win32", "portable")).toBe(portableBackend);
});

test("an unrecognised override falls back to the platform default", () => {
  expect(selectProcBackend("win32", "wmic").name).toBe("windows");
  expect(selectProcBackend("linux", "").name).toBe("linux");
});

test("every backend answers the whole contract", () => {
  /* A backend that silently lacks a method would throw deep inside a scan. */
  const methods = Object.keys(linuxBackend).sort();
  expect(Object.keys(windowsBackend).sort()).toEqual(methods);
  expect(Object.keys(portableBackend).sort()).toEqual(methods);
});
