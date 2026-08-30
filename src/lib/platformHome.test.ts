import { expect, test } from "bun:test";
import path from "node:path";

import { homeDirectory, isWindowsAbsolute } from "./platformHome";

const FALLBACK_POSIX = "/home/user/fallback";
const FALLBACK_WIN = "D:\\Users\\user\\fallback";

test("POSIX keeps $HOME first so an isolated runtime is not read past", () => {
  /* Bun's os.homedir() ignores the env override, so dropping $HOME here would
     make an evidence run, a demo capture or a test read the real home. */
  expect(homeDirectory({ HOME: "/tmp/isolated" }, "linux", () => FALLBACK_POSIX)).toBe("/tmp/isolated");
  expect(homeDirectory({ HOME: "  " }, "darwin", () => FALLBACK_POSIX)).toBe(FALLBACK_POSIX);
  expect(homeDirectory({}, "linux", () => FALLBACK_POSIX)).toBe(FALLBACK_POSIX);
});

test("Windows ignores HOME entirely, however it was set", () => {
  /* Git Bash and MSYS export a POSIX HOME on Windows. Resolving `/c/Users/user`
     there yields a path on the current drive that names nothing, so every
     transcript root, the config dir and the state dir would point at an empty
     directory the viewer would then create. */
  expect(homeDirectory({ HOME: "/c/Users/user" }, "win32", () => FALLBACK_WIN)).toBe(FALLBACK_WIN);
  expect(homeDirectory({ HOME: "C:\\Users\\user" }, "win32", () => FALLBACK_WIN)).toBe(FALLBACK_WIN);
});

test("Windows takes USERPROFILE when it is a Windows path, keeping the override", () => {
  expect(homeDirectory({ USERPROFILE: "C:\\Users\\user\\isolated" }, "win32", () => FALLBACK_WIN))
    .toBe("C:\\Users\\user\\isolated");
  expect(homeDirectory({ USERPROFILE: "\\\\share\\profiles\\user" }, "win32", () => FALLBACK_WIN))
    .toBe("\\\\share\\profiles\\user");
  // A POSIX-shaped USERPROFILE is refused the same way HOME is.
  expect(homeDirectory({ USERPROFILE: "/c/Users/user" }, "win32", () => FALLBACK_WIN)).toBe(FALLBACK_WIN);
  expect(homeDirectory({ USERPROFILE: "   " }, "win32", () => FALLBACK_WIN)).toBe(FALLBACK_WIN);
});

test("only a drive-rooted or UNC path counts as absolute on Windows", () => {
  /* `path.isAbsolute` would not do: on win32 it calls `/c/Users/user` absolute,
     because a leading slash is rooted on the current drive. */
  expect(isWindowsAbsolute("C:\\Users\\user")).toBe(true);
  expect(isWindowsAbsolute("c:/Users/user")).toBe(true);
  expect(isWindowsAbsolute("\\\\server\\share")).toBe(true);
  expect(isWindowsAbsolute("/c/Users/user")).toBe(false);
  expect(isWindowsAbsolute("C:")).toBe(false);
  expect(isWindowsAbsolute("Users\\user")).toBe(false);
});

test("the resolved home is what the running platform would use", () => {
  expect(homeDirectory()).toBe(path.resolve(homeDirectory()));
});
