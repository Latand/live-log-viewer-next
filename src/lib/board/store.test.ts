import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boardFor, BoardStoreError, migrateBoardProjects, mutateBoard, patchBoard, remapBoardPaths, transferBoardPathPlacements } from "./store";
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
  test("favorites persist across a reload and survive a legacy board with no favorites field", () => {
    const file = temporaryFile();
    const added = mutateBoard("viewer", 0, [{ kind: "set-favorite", id: "conv-1", favorite: true }], file);
    expect(added).toMatchObject({ ok: true, board: { revision: 1 } });
    // Survives a fresh read of the persisted file (a reload/deploy).
    expect(boardFor("viewer", file).prefs.favorites).toEqual(["conv-1"]);
    // A board written before favorites existed reads back with an empty list.
    fs.writeFileSync(file, JSON.stringify({ projects: { viewer: {
      schemaVersion: 1, revision: 5, updatedAt: "2026-07-10T00:00:00.000Z",
      prefs: { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    } } }), "utf8");
    expect(boardFor("viewer", file).prefs.favorites).toEqual([]);
    const seeded = mutateBoard("viewer", 5, [{ kind: "set-favorite", id: "conv-2", favorite: true }], file);
    expect(seeded).toMatchObject({ ok: true, board: { revision: 6 } });
    expect(boardFor("viewer", file).prefs.favorites).toEqual(["conv-2"]);
  });
  test("durable writes fsync the board file and parent directory", async () => {
    const file = temporaryFile();
    const modulePath = path.join(import.meta.dir, "store.ts");
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const fs = (await import("node:fs")).default; const sync = fs.fsyncSync.bind(fs); let calls = 0; fs.fsyncSync = (descriptor) => { calls += 1; return sync(descriptor); }; const m = await import(${JSON.stringify(modulePath)}); m.patchBoard("viewer", 0, { manual: ["/durable"] }, ${JSON.stringify(file)}); console.log(calls);`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect(Number((await new Response(child.stdout).text()).trim())).toBeGreaterThanOrEqual(3);
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
    expect(boardFor("viewer", file).explicitManual).toEqual(["/a"]);
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
  test("concurrent processes preserve every successful project mutation", async () => {
    const file = temporaryFile();
    const modulePath = path.join(import.meta.dir, "store.ts");
    const writers = Array.from({ length: 40 }, (_, index) => Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(modulePath)}); const result = m.patchBoard(${JSON.stringify(`project-${index}`)}, 0, { manual: [${JSON.stringify(`/path-${index}`)}] }, ${JSON.stringify(file)}); if (!result.ok) process.exit(2);`,
      ],
      stdout: "ignore",
      stderr: "pipe",
    }));

    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual(Array(40).fill(0));
    const projects = JSON.parse(fs.readFileSync(file, "utf8")).projects as Record<string, unknown>;
    expect(Object.keys(projects)).toHaveLength(40);
  });
  test("concurrent writers recover a crashed lock owner without lost mutations", async () => {
    const file = temporaryFile();
    const writerCount = 24;
    const staleOwner = JSON.stringify({ pid: 999_999_999, startIdentity: null });
    const legacyLock = `${file}.write-lock`;
    const lockDirectory = `${file}.write-locks`;
    const staleTicket = path.join(lockDirectory, "stale-owner.json");
    const barrier = `${file}.stale-reapers`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(lockDirectory);
    fs.mkdirSync(barrier);
    fs.writeFileSync(legacyLock, staleOwner, "utf8");
    fs.writeFileSync(staleTicket, staleOwner, "utf8");
    const modulePath = path.join(import.meta.dir, "store.ts");
    const writers = Array.from({ length: writerCount }, (_, index) => Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const fs = (await import("node:fs")).default; const path = (await import("node:path")).default; const remove = fs.rmSync.bind(fs); let gated = false; fs.rmSync = (pathname, options) => { if (!gated && (pathname === ${JSON.stringify(legacyLock)} || pathname === ${JSON.stringify(staleTicket)})) { gated = true; fs.writeFileSync(path.join(${JSON.stringify(barrier)}, String(process.pid)), ""); while (fs.readdirSync(${JSON.stringify(barrier)}).length < ${writerCount}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); } return remove(pathname, options); }; const m = await import(${JSON.stringify(modulePath)}); const result = m.patchBoard(${JSON.stringify(`recovered-${index}`)}, 0, { manual: [${JSON.stringify(`/recovered-${index}`)}] }, ${JSON.stringify(file)}); if (!result.ok) process.exit(2);`,
      ],
      stdout: "ignore",
      stderr: "pipe",
    }));

    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual(Array(writerCount).fill(0));
    const projects = JSON.parse(fs.readFileSync(file, "utf8")).projects as Record<string, unknown>;
    expect(Object.keys(projects)).toHaveLength(writerCount);
  });
  test("aged lock records recover when process birth identity is unavailable", () => {
    const file = temporaryFile();
    const lockDirectory = `${file}.write-locks`;
    const ticket = path.join(lockDirectory, "0000-reused-pid.json");
    const lock = `${file}.write-lock`;
    const owner = JSON.stringify({ pid: process.pid, startIdentity: null });
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(ticket, owner, "utf8");
    fs.writeFileSync(lock, owner, "utf8");
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(ticket, stale, stale);
    fs.utimesSync(lock, stale, stale);

    expect(patchBoard("viewer", 0, { manual: ["/recovered"] }, file)).toMatchObject({
      ok: true,
      board: { prefs: { manual: ["/recovered"] } },
    });
  });
  test("path remap clears provisional continuity roots and replays idempotently", () => {
    const file = temporaryFile();
    const project = "viewer";
    patchBoard(project, 0, { manual: ["/fork", "/target"], expanded: ["/source"] }, file);
    const first = remapBoardPaths(
      project,
      [{ from: "/source", to: "/target" }, { from: "/fork", to: "/target" }],
      { provisionalManual: ["/fork"], filePath: file },
    );
    const replay = remapBoardPaths(
      project,
      [{ from: "/source", to: "/target" }, { from: "/fork", to: "/target" }],
      { provisionalManual: ["/fork"], filePath: file },
    );
    expect(first).toMatchObject({
      revision: 2,
      pathAliases: { "/source": "/target", "/fork": "/target" },
      prefs: { manual: [], expanded: ["/target"] },
    });
    expect(replay).toEqual(first);
  });
  test("path remap derives provisional cleanup after a concurrent alias write", async () => {
    const file = temporaryFile();
    const project = "viewer";
    const ready = `${file}.reader-ready`;
    const release = `${file}.reader-release`;
    patchBoard(project, 0, { manual: ["/fork"] }, file);
    const modulePath = path.join(import.meta.dir, "store.ts");
    const writer = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const fs = (await import("node:fs")).default; const open = fs.openSync.bind(fs); let gated = false; fs.openSync = (pathname, ...args) => { if (!gated && pathname === ${JSON.stringify(`${file}.write-lock`)}) { gated = true; fs.writeFileSync(${JSON.stringify(ready)}, ""); while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); } return open(pathname, ...args); }; const m = await import(${JSON.stringify(modulePath)}); m.remapBoardPaths(${JSON.stringify(project)}, [{ from: "/source", to: "/target" }, { from: "/fork", to: "/target" }], { provisionalManual: ["/fork"], filePath: ${JSON.stringify(file)} });`,
      ],
      stdout: "ignore",
      stderr: "pipe",
    });
    while (!fs.existsSync(ready)) await Bun.sleep(1);
    const interleaved = JSON.parse(fs.readFileSync(file, "utf8"));
    interleaved.projects[project] = {
      ...interleaved.projects[project],
      revision: interleaved.projects[project].revision + 1,
      pathAliases: { "/fork": "/target" },
      prefs: { ...interleaved.projects[project].prefs, manual: ["/target"] },
    };
    fs.writeFileSync(file, JSON.stringify(interleaved, null, 2) + "\n", "utf8");
    fs.writeFileSync(release, "", "utf8");

    expect(await writer.exited).toBe(0);
    expect(boardFor(project, file)).toMatchObject({
      pathAliases: { "/fork": "/target", "/source": "/target" },
      prefs: { manual: ["/target"] },
    });
  });
  test("project placement transfer preserves destination user intent", () => {
    const file = temporaryFile();
    const paths = ["/hidden", "/manual", "/expanded"];
    mutateBoard("source", 0, [{
      kind: "remap-paths",
      pairs: paths.map((pathname) => ({ from: `/old${pathname}`, to: pathname })),
    }], file);
    mutateBoard("destination", 0, [
      { kind: "close", path: paths[0]! },
      { kind: "restore", path: paths[1]!, placement: "manual" },
      { kind: "restore", path: paths[2]!, placement: "expanded" },
    ], file);

    transferBoardPathPlacements([{
      fromProject: "source",
      toProject: "destination",
      paths,
    }], file);

    expect(boardFor("destination", file).prefs).toMatchObject({
      hidden: [paths[0]],
      manual: [paths[1]],
      expanded: [paths[2]],
    });
  });
  test("project placement transfer carries continuity aliases with manual placement", () => {
    const file = temporaryFile();
    const source = "/predecessor";
    const successor = "/successor";
    mutateBoard("source", 0, [
      { kind: "restore", path: source, placement: "manual" },
      { kind: "remap-paths", pairs: [{ from: source, to: successor }] },
    ], file);

    transferBoardPathPlacements([{
      fromProject: "source",
      toProject: "destination",
      paths: [source, successor],
    }], file);
    const repaired = remapBoardPaths("destination", [{ from: source, to: successor }], { filePath: file });

    expect(boardFor("source", file).prefs.manual).toEqual([]);
    expect(repaired).toMatchObject({
      pathAliases: { [source]: successor },
      prefs: { manual: [successor] },
    });
  });
  test("project placement transfer resolves destination intent through carried aliases", () => {
    const file = temporaryFile();
    const source = "/predecessor";
    const successor = "/successor";
    mutateBoard("source", 0, [
      { kind: "restore", path: source, placement: "expanded" },
      { kind: "remap-paths", pairs: [{ from: source, to: successor }] },
    ], file);
    mutateBoard("destination", 0, [
      { kind: "restore", path: source, placement: "manual" },
    ], file);

    transferBoardPathPlacements([{
      fromProject: "source",
      toProject: "destination",
      paths: [source, successor],
    }], file);

    expect(boardFor("destination", file)).toMatchObject({
      pathAliases: { [source]: successor },
      prefs: { manual: [successor], expanded: [] },
    });
  });
  test("many stale projects merge by original timestamp with newer membership roles winning", () => {
    const run = (migrations: Map<string, string>) => {
      const file = temporaryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const state = (
        updatedAt: string,
        prefs: Partial<{ manual: string[]; hidden: string[]; expanded: string[]; viewMode: "scheme" | "list" | null; taskPanelOpen: boolean }>,
        pathAliases: Record<string, string>,
      ) => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt,
        pathAliases,
        prefs: { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false, ...prefs },
      });
      fs.writeFileSync(file, JSON.stringify({ projects: {
        canonical: state("2026-07-10T00:01:00.000Z", { expanded: ["/base"], viewMode: "scheme" }, { "/alias": "/base" }),
        older: state("2026-07-10T00:00:00.000Z", { hidden: ["/a"] }, { "/alias": "/old" }),
        newest: state("2026-07-10T00:02:00.000Z", { manual: ["/a"], expanded: ["/b"], viewMode: "list", taskPanelOpen: true }, { "/alias": "/new" }),
      } }), "utf8");
      expect(migrateBoardProjects(migrations, file)).toBe(true);
      return JSON.parse(fs.readFileSync(file, "utf8")).projects;
    };

    const forward = run(new Map([["older", "canonical"], ["newest", "canonical"]]));
    const reverse = run(new Map([["newest", "canonical"], ["older", "canonical"]]));

    expect(forward.older).toBeUndefined();
    expect(forward.newest).toBeUndefined();
    expect(forward.canonical.prefs).toEqual({
      manual: ["/a"], hidden: [], expanded: ["/base", "/b"], favorites: [], viewMode: "list", taskPanelOpen: true,
    });
    expect(forward.canonical.pathAliases).toEqual({ "/alias": "/new" });
    expect(reverse.canonical.prefs).toEqual(forward.canonical.prefs);
    expect(reverse.canonical.pathAliases).toEqual(forward.canonical.pathAliases);
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
