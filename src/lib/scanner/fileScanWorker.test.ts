import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scheduleTranscriptIndex, waitForTranscriptIndexIdleForTests } from "@/lib/search/transcriptFeed";
import { searchTranscripts } from "@/lib/search/transcriptSearch";

import { conversationCatalogSnapshot, replaceConversationCatalog } from "./conversationCatalog";
import { collectFileScanInWorker, fileScanWorkerEnabled } from "./fileScanWorker";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureWorker(source: string): { directory: string; workerPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-"));
  directories.push(directory);
  const workerPath = path.join(directory, "worker.mjs");
  fs.writeFileSync(workerPath, source);
  return { directory, workerPath };
}

test("production file scans use the worker boundary and test scans stay direct", () => {
  expect(fileScanWorkerEnabled({ NODE_ENV: "production" })).toBe(true);
  expect(fileScanWorkerEnabled({ NODE_ENV: "test" })).toBe(false);
  expect(fileScanWorkerEnabled({ NODE_ENV: "production", LLV_FILE_SCANNER_WORKER: "1" })).toBe(false);
  expect(fileScanWorkerEnabled({ NODE_ENV: "production", LLV_FILE_SCANNER_WORKER_DISABLED: "1" })).toBe(false);
});

test("worker scan streams the resource scope, keeps the caller event loop live, and returns completion", async () => {
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      const resource = { files: [], projectCatalog: [], complete: true };
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "resource", snapshot: resource }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "complete",
            snapshot: { files: [], projectCatalog: [{ id: "project-one", name: "one", path: "/one" }], complete: true },
          }) + "\\n");
        }, 20);
      }, 20);
    });
  `);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const resources: unknown[] = [];
  try {
    const snapshot = await collectFileScanInWorker(
      { persist: false, persistIndex: false },
      (resource) => resources.push(resource),
      {
        launch: { executable: process.execPath, workerPath },
        cwd: directory,
        timeoutMs: 2_000,
      },
    );
    expect(resources).toEqual([{ files: [], projectCatalog: [], complete: true }]);
    expect(snapshot.projectCatalog).toHaveLength(1);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(timer);
  }
});

test("a current incomplete worker scan schedules a non-deleting transcript feed", async () => {
  const transcript = {
    path: "/sessions/indexed.jsonl",
    root: "codex-sessions",
    name: "indexed.jsonl",
    project: "repo-indexed",
    title: "indexed",
    firstPrompt: "",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    mtime: 1_780_000_000,
    size: 100,
  };
  const completion = JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [transcript], complete: false },
  });
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => process.stdout.write(${JSON.stringify(`${completion}\n`)}));
  `);
  const feeds: unknown[] = [];

  await collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 2_000,
      transcriptIndexScheduler: (feed) => { feeds.push(feed); },
    },
  );

  expect(feeds).toEqual([{
    complete: false,
    sources: [{
      path: transcript.path,
      project: transcript.project,
      engine: transcript.engine,
      size: transcript.size,
      mtimeMs: transcript.mtime * 1_000,
    }],
  }]);
});

test("an obsolete worker scan finishing last cannot delete newer transcript index results", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-overlap-"));
  directories.push(directory);
  const previousEnvironment = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LLV_STATE_DIR: process.env.LLV_STATE_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.HOME = path.join(directory, "home");
  process.env.XDG_CONFIG_HOME = path.join(directory, "config");
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.TMPDIR = path.join(directory, "tmp");
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });

  const transcript = (name: string, body: string) => {
    const pathname = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(pathname, `${JSON.stringify({
      type: "user",
      timestamp: "2026-08-20T09:00:00.000Z",
      message: { content: body },
    })}\n`);
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      root: "claude-projects",
      name: path.basename(pathname),
      project: "repo-overlap",
      title: name,
      firstPrompt: "",
      engine: "claude",
      kind: "session",
      fmt: "claude",
      mtime: stat.mtimeMs / 1_000,
      size: stat.size,
    };
  };
  const older = transcript("older", "obsoleteinventorymarker");
  const newer = transcript("newer", "newerinventorymarker");
  const completion = (entry: ReturnType<typeof transcript>) => `${JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [entry], complete: true },
  })}\n`;
  const worker = (entry: ReturnType<typeof transcript>, delayMs: number) => fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => setTimeout(() => {
      process.stdout.write(${JSON.stringify(completion(entry))});
    }, ${delayMs}));
  `);
  const olderWorker = worker(older, 250);
  const newerWorker = worker(newer, 0);
  const scheduledPaths: string[][] = [];
  const schedule = (feed: Parameters<typeof scheduleTranscriptIndex>[0]) => {
    scheduledPaths.push(feed.sources.map((entry) => entry.path));
    scheduleTranscriptIndex(feed, { force: true });
  };

  try {
    await waitForTranscriptIndexIdleForTests();
    const olderScan = collectFileScanInWorker(
      { persist: false, persistIndex: false },
      undefined,
      {
        launch: { executable: process.execPath, workerPath: olderWorker.workerPath },
        cwd: olderWorker.directory,
        timeoutMs: 2_000,
        transcriptIndexScheduler: schedule,
      },
    );
    const newerScan = collectFileScanInWorker(
      { persist: false, persistIndex: false },
      undefined,
      {
        launch: { executable: process.execPath, workerPath: newerWorker.workerPath },
        cwd: newerWorker.directory,
        timeoutMs: 2_000,
        transcriptIndexScheduler: schedule,
      },
    );

    await newerScan;
    await waitForTranscriptIndexIdleForTests();
    expect(searchTranscripts({ query: "newerinventorymarker" }).items).toHaveLength(1);

    await olderScan;
    await waitForTranscriptIndexIdleForTests();
    expect(scheduledPaths).toEqual([[newer.path]]);
    expect(searchTranscripts({ query: "newerinventorymarker" }).items).toHaveLength(1);
  } finally {
    await waitForTranscriptIndexIdleForTests();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("worker scans publish a Claude transcript that appears in a previously sessionless project directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-file-scan-worker-late-session-"));
  directories.push(directory);
  const home = path.join(directory, "home");
  const stateDir = path.join(directory, "state");
  const temporaryDir = path.join(directory, "tmp");
  const repository = path.join(directory, "late-session-repository");
  const encodedCwd = repository.replaceAll(path.sep, "-");
  const projectDirectory = path.join(home, ".claude", "projects", encodedCwd);
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = https://example.invalid/team/late-session-repository.git",
    "",
  ].join("\n"));
  fs.mkdirSync(projectDirectory, { recursive: true });
  fs.mkdirSync(temporaryDir, { recursive: true });
  fs.mkdirSync(path.join(temporaryDir, `claude-${process.getuid?.() ?? 1000}`));
  fs.writeFileSync(path.join(projectDirectory, "historical.jsonl.wakatime"), "{}\n");
  replaceConversationCatalog([]);
  const runtime = {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      LLV_STATE_DIR: stateDir,
      TMPDIR: temporaryDir,
      NODE_ENV: "production" as const,
      LLV_AGENT_REGISTRY_SQLITE: "off",
    },
    timeoutMs: 10_000,
  };

  const before = await collectFileScanInWorker({ persist: false, persistIndex: true }, undefined, runtime);
  expect(before.files).toEqual([]);

  const transcript = path.join(projectDirectory, "late-session.jsonl");
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", cwd: repository, message: { content: "late session" } })}\n`,
  );
  const after = await collectFileScanInWorker({ persist: false, persistIndex: true }, undefined, runtime);

  expect(after.complete).toBe(true);
  expect(after.files.some((entry) => entry.path === transcript)).toBe(true);
  expect(conversationCatalogSnapshot()).toContainEqual(expect.objectContaining({
    path: transcript,
    project: expect.stringMatching(/^repo-[0-9a-f]{32}$/),
  }));
});

test("a completion frame followed by worker failure preserves the published conversation catalog", async () => {
  const retained = {
    path: "/sessions/retained.jsonl",
    root: "codex-sessions" as const,
    name: "retained.jsonl",
    project: "repo-retained",
    title: "retained",
    firstPrompt: "",
    engine: "codex" as const,
    kind: "session",
    fmt: "codex" as const,
    mtime: 1_780_000_000,
    size: 100,
  };
  const replacement = { ...retained, path: "/sessions/replacement.jsonl", name: "replacement.jsonl", title: "replacement" };
  const completion = JSON.stringify({
    type: "complete",
    snapshot: { files: [], projectCatalog: [], conversationCatalog: [replacement], complete: true },
  });
  const { directory, workerPath } = fixtureWorker(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write(${JSON.stringify(`${completion}\n`)}, () => {
        process.exitCode = 1;
      });
    });
  `);
  replaceConversationCatalog([retained]);
  let transcriptIndexFeeds = 0;

  await expect(collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 2_000,
      transcriptIndexScheduler: () => { transcriptIndexFeeds += 1; },
    },
  )).rejects.toThrow("file scanner worker exited before completion");

  expect(conversationCatalogSnapshot()).toEqual([retained]);
  expect(transcriptIndexFeeds).toBe(0);
});

test("aborting a worker scan kills the child and releases its timer and listener", async () => {
  const { directory, workerPath } = fixtureWorker(`
    import fs from "node:fs";
    fs.writeFileSync(new URL("worker.pid", import.meta.url), String(process.pid));
    process.stdin.resume();
    process.stdin.on("end", () => setInterval(() => {}, 1_000));
  `);
  const pidFile = path.join(directory, "worker.pid");
  const controller = new AbortController();
  const signal = controller.signal as AbortSignal & {
    addEventListener: AbortSignal["addEventListener"];
    removeEventListener: AbortSignal["removeEventListener"];
  };
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  let listeners = 0;
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return addEventListener(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return removeEventListener(...args);
  }) as AbortSignal["removeEventListener"];
  let timers = 0;

  const scan = collectFileScanInWorker(
    { persist: false, persistIndex: false },
    undefined,
    {
      launch: { executable: process.execPath, workerPath },
      cwd: directory,
      timeoutMs: 30_000,
      signal,
      scheduler: {
        setTimeout: (handler, ms) => {
          timers += 1;
          return setTimeout(handler, ms);
        },
        clearTimeout: (handle) => {
          timers -= 1;
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      },
    },
  );

  for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(fs.existsSync(pidFile)).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();

  await expect(scan).rejects.toMatchObject({ name: "AbortError" });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(timers).toBe(0);
  expect(listeners).toBe(0);
});
