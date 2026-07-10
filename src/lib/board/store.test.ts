import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boardFor, BoardStoreError, mutateBoard, patchBoard } from "./store";
import { validateBoardPatchRequest } from "./validation";

function temporaryFile(): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-")), "board.json"); }

describe("board store", () => {
  test("increments revisions atomically and rejects stale concurrent writers", () => {
    const file = temporaryFile();
    expect(boardFor("viewer", file).revision).toBe(0);
    const first = patchBoard("viewer", 0, { manual: ["/a"] }, file);
    expect(first).toMatchObject({ ok: true, board: { revision: 1 } });
    const stale = patchBoard("viewer", 0, { hidden: ["/a"] }, file);
    expect(stale).toMatchObject({ ok: false, board: { revision: 1 } });
    expect(boardFor("viewer", file).prefs.manual).toEqual(["/a"]);
  });
  test("fails closed on corrupt durable state and preserves its bytes", () => {
    const file = temporaryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ corrupt", "utf8");
    expect(() => boardFor("viewer", file)).toThrow(BoardStoreError);
    expect(() => patchBoard("viewer", 0, { manual: ["/a"] }, file)).toThrow(BoardStoreError);
    expect(fs.readFileSync(file, "utf8")).toBe("{ corrupt");
  });
  test("accepts missing storage as revision-zero initialization", () => {
    expect(boardFor("viewer", temporaryFile())).toMatchObject({ revision: 0, prefs: { manual: [] } });
  });
  test("loads a legacy schema-one file with empty path aliases", () => {
    const file = temporaryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projects: { viewer: {
      schemaVersion: 1, revision: 3, updatedAt: "2026-07-10T00:00:00.000Z",
      prefs: { manual: ["/a"], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    } } }), "utf8");
    expect(boardFor("viewer", file).pathAliases).toEqual({});
  });
  test("a semantic no-op preserves revision and durable inode", () => {
    const file = temporaryFile();
    const written = patchBoard("viewer", 0, { manual: ["/a"] }, file);
    expect(written.ok).toBe(true);
    const before = fs.statSync(file);
    const result = mutateBoard("viewer", 1, [{ kind: "restore", path: "/a", placement: "manual" }], file);
    expect(result).toMatchObject({ ok: true, board: { revision: 1 } });
    const after = fs.statSync(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
  test("identical semantic intent from two writers advances once", () => {
    const file = temporaryFile();
    const first = mutateBoard("viewer", 0, [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }], file);
    const replay = mutateBoard("viewer", 0, [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }], file);
    expect(first).toMatchObject({ ok: true, board: { revision: 1 } });
    expect(replay).toMatchObject({ ok: true, board: { revision: 1 } });
  });
  test("strict bounded PATCH validation rejects unknown and empty changes", async () => {
    const request = (body: unknown) => new Request("http://127.0.0.1:8898/api/board", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expect(validateBoardPatchRequest(request({ schemaVersion: 1, project: "viewer", baseRevision: 0, patch: { surprise: true } }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(validateBoardPatchRequest(request({ schemaVersion: 1, project: "viewer", baseRevision: 0, patch: {} }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const parsed = await validateBoardPatchRequest(request({ schemaVersion: 1, project: "viewer", baseRevision: 0, patch: { taskPanelOpen: true } }));
    expect(parsed.patch).toEqual({ taskPanelOpen: true });
  });
  test("mutation validation rejects malformed batches and alias cycles", async () => {
    const request = (body: unknown) => new Request("http://127.0.0.1:8898/api/board", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const valid = { schemaVersion: 1, project: "viewer", baseRevision: 0 };
    for (const mutations of [
      [],
      [{ kind: "unknown" }],
      [{ kind: "close", path: "" }],
      [{ kind: "reconcile-roots", roots: Array.from({ length: 513 }, (_, index) => `/root-${index}`), removeManual: [] }],
      [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/one" }, { from: "/old", to: "/two" }] }],
      [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }, { from: "/new", to: "/old" }] }],
      [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }, { kind: "remap-paths", pairs: [{ from: "/new", to: "/old" }] }],
    ]) {
      await expect(validateBoardPatchRequest(request({ ...valid, mutations }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    const parsed = await validateBoardPatchRequest(request({ ...valid, mutations: [{ kind: "set-presentation", viewMode: "scheme" }] }));
    expect(parsed.mutations).toEqual([{ kind: "set-presentation", viewMode: "scheme" }]);
  });
});
