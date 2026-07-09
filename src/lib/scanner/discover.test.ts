import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import type { RootKey } from "../types";
import { discoverFiles, discoverFilesWithProjectCatalog } from "./discover";
import { FILE_CAP } from "./roots";

async function writeFixture(pathname: string, content: string, mtimeSeconds: number): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, content);
  await utimes(pathname, mtimeSeconds, mtimeSeconds);
}

test("discoverFiles preserves scanner filters, mtime ordering, and the cap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-"));
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const startedAt = 1_700_000_000;
    for (let index = 0; index < FILE_CAP; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `session-${String(index).padStart(3, "0")}.jsonl`);
      await writeFixture(
        pathname,
        JSON.stringify({ payload: { cwd: "/home/user/project" }, type: "session" }) + "\n",
        startedAt + index,
      );
    }

    const taskPath = path.join(roots["claude-tasks"], "project-a", "sid-a", "tasks", "keep.output");
    await writeFixture(taskPath, "", startedAt + FILE_CAP + 10);

    await writeFixture(path.join(roots["codex-sessions"], "too-new.bin"), "skip", startedAt + FILE_CAP + 20);
    await writeFixture(path.join(roots["codex-sessions"], "empty.jsonl"), "", startedAt + FILE_CAP + 30);
    await writeFixture(
      path.join(roots["claude-projects"], "project-a", "sid-a", "tool-results", "tool.jsonl"),
      "{}\n",
      startedAt + FILE_CAP + 40,
    );
    await writeFixture(
      path.join(roots["claude-tasks"], "project-a", "sid-a", "scratchpad.txt"),
      "skip\n",
      startedAt + FILE_CAP + 50,
    );
    await writeFixture(
      path.join(roots["claude-tasks"], "project-a", "sid-a", "tasks", "mirrored.output"),
      "skip\n",
      startedAt + FILE_CAP + 60,
    );
    await writeFixture(
      path.join(roots["claude-projects"], "project-a", "sid-a", "subagents", "agent-mirrored.jsonl"),
      "{}\n",
      startedAt - 1,
    );

    const entries = await discoverFiles(roots);

    expect(entries).toHaveLength(FILE_CAP);
    expect(entries[0]?.path).toBe(taskPath);
    expect(entries.slice(1).map((entry) => entry.name)).toEqual(
      Array.from({ length: FILE_CAP - 1 }, (_, offset) => {
        const index = FILE_CAP - 1 - offset;
        return `session-${String(index).padStart(3, "0")}.jsonl`;
      }),
    );
    expect(entries.some((entry) => entry.name === "session-000.jsonl")).toBe(false);
    expect(entries.map((entry) => entry.path)).toEqual([...entries].sort((a, b) => b.mtime - a.mtime).map((entry) => entry.path));
    expect(entries.every((entry) => entry.path !== path.join(roots["codex-sessions"], "too-new.bin"))).toBe(true);
    expect(entries.every((entry) => entry.path !== path.join(roots["codex-sessions"], "empty.jsonl"))).toBe(true);
    expect(entries.every((entry) => !entry.path.includes(path.sep + "tool-results" + path.sep))).toBe(true);
    expect(entries.every((entry) => !entry.path.endsWith("scratchpad.txt"))).toBe(true);
    expect(entries.every((entry) => !entry.path.endsWith("mirrored.output"))).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFiles merges multiple Codex session roots without duplicate paths", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-codex-accounts-"));
  try {
    const first = path.join(base, "codex-default");
    const second = path.join(base, "codex-work");
    const claudeProjects = path.join(base, "claude-projects");
    const claudeTasks = path.join(base, "claude-tasks");
    await Promise.all([first, second, claudeProjects, claudeTasks].map((root) => mkdir(root, { recursive: true })));
    const firstFile = path.join(first, "first.jsonl");
    const secondFile = path.join(second, "second.jsonl");
    await writeFixture(firstFile, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n", 10);
    await writeFixture(secondFile, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n", 20);

    const entries = await discoverFiles([
      ["codex-sessions", first],
      ["codex-sessions", second],
      ["claude-projects", claudeProjects],
      ["claude-tasks", claudeTasks],
    ]);

    expect(entries.map((entry) => entry.path)).toEqual([secondFile, firstFile]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFiles keeps native Codex spawn parents outside the recent cap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-parent-"));
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const parentId = "019f421e-02e1-73e0-9b77-bebde063f10a";
    const childId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
    const startedAt = 1_700_010_000;
    const parentPath = path.join(roots["codex-sessions"], "2026", "07", "08", `rollout-parent-${parentId}.jsonl`);
    const childPath = path.join(roots["codex-sessions"], "2026", "07", "08", `rollout-child-${childId}.jsonl`);
    await writeFixture(parentPath, JSON.stringify({ type: "session_meta", payload: { id: parentId, cwd: "/repo" } }) + "\n", startedAt - 10);
    await writeFixture(
      childPath,
      JSON.stringify({ type: "session_meta", payload: { id: childId, parent_thread_id: parentId, cwd: "/repo" } }) + "\n",
      startedAt + FILE_CAP + 10,
    );
    for (let index = 0; index < FILE_CAP - 1; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `filler-${String(index).padStart(3, "0")}.jsonl`);
      await writeFixture(pathname, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n", startedAt + index);
    }

    const entries = await discoverFiles(roots);

    expect(entries).toHaveLength(FILE_CAP + 1);
    expect(entries[0]?.path).toBe(childPath);
    expect(entries.some((entry) => entry.path === parentPath)).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFilesWithProjectCatalog keeps projects outside the recent cap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-catalog-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  try {
    process.env.LLV_STATE_DIR = path.join(base, "state");
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const startedAt = 1_700_020_000;
    const oldProjectSlug = "-" + path.join(os.homedir(), "Projects", "Pr-Gram").split(path.sep).filter(Boolean).join("-");
    const oldPath = path.join(roots["claude-projects"], oldProjectSlug, "old-session.jsonl");
    await writeFixture(oldPath, JSON.stringify({ type: "user", message: { content: "Old project" } }) + "\n", startedAt - 10);
    for (let index = 0; index < FILE_CAP; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `fresh-${String(index).padStart(3, "0")}.jsonl`);
      await writeFixture(
        pathname,
        JSON.stringify({ type: "session_meta", payload: { cwd: "/home/latand/Projects/fresh-project" } }) + "\n",
        startedAt + index,
      );
    }

    const scan = await discoverFilesWithProjectCatalog(roots);

    expect(scan.files.some((entry) => entry.path === oldPath)).toBe(false);
    expect(scan.projectCatalog.find((entry) => entry.project === "Pr-Gram")).toEqual({
      project: "Pr-Gram",
      conversations: 1,
      smt: startedAt - 10,
    });
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFilesWithProjectCatalog hydrates a selected project outside the recent cap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-selected-project-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  try {
    process.env.LLV_STATE_DIR = path.join(base, "state");
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const startedAt = 1_700_025_000;
    const projectSlug = "-" + path.join(os.homedir(), "Projects", "stikon-dispatcher").split(path.sep).filter(Boolean).join("-");
    const quietPath = path.join(roots["claude-projects"], projectSlug, "quiet-session.jsonl");
    await writeFixture(quietPath, JSON.stringify({ type: "user", message: { content: "Quiet project" } }) + "\n", startedAt - 10);
    for (let index = 0; index < FILE_CAP; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `fresh-${String(index).padStart(3, "0")}.jsonl`);
      await writeFixture(
        pathname,
        JSON.stringify({ type: "session_meta", payload: { cwd: "/home/latand/Projects/fresh-project" } }) + "\n",
        startedAt + index,
      );
    }

    const overviewScan = await discoverFilesWithProjectCatalog(roots);
    const selectedScan = await discoverFilesWithProjectCatalog(roots, "stikon-dispatcher");

    expect(overviewScan.files.some((entry) => entry.path === quietPath)).toBe(false);
    expect(selectedScan.projectCatalog.find((entry) => entry.project === "stikon-dispatcher")).toEqual({
      project: "stikon-dispatcher",
      conversations: 1,
      smt: startedAt - 10,
    });
    expect(selectedScan.files.some((entry) => entry.path === quietPath && entry.project === "stikon-dispatcher")).toBe(true);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFilesWithProjectCatalog refreshes cached projects when flow state changes", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-catalog-state-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  try {
    const stateDir = path.join(base, "state");
    process.env.LLV_STATE_DIR = stateDir;
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const startedAt = 1_700_030_000;
    const staleCwd = path.join(os.homedir(), ".agents", "tools", "live-log-viewer-workflows");
    const canonicalCwd = path.join(os.homedir(), ".agents", "tools", "live-log-viewer-next");
    const staleSlug = "-" + staleCwd.split(path.sep).filter(Boolean).join("-");
    const staleProject = staleSlug.slice(("-" + os.homedir().split(path.sep).filter(Boolean).join("-") + "-").length);
    const sessionPath = path.join(roots["claude-projects"], staleSlug, "old-session.jsonl");
    await writeFixture(sessionPath, JSON.stringify({ type: "user", message: { content: "Old project" } }) + "\n", startedAt - 10);
    for (let index = 0; index < FILE_CAP; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `fresh-${String(index).padStart(3, "0")}.jsonl`);
      await writeFixture(
        pathname,
        JSON.stringify({ type: "session_meta", payload: { cwd: "/home/latand/Projects/fresh-project" } }) + "\n",
        startedAt + index,
      );
    }

    const first = await discoverFilesWithProjectCatalog(roots);
    expect(first.files.some((entry) => entry.path === sessionPath)).toBe(false);
    expect(first.projectCatalog.some((entry) => entry.project === staleProject)).toBe(true);

    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "flows.json"),
      JSON.stringify({
        flows: [
          {
            project: "live-log-viewer-next",
            cwd: canonicalCwd,
            implementerPath: sessionPath,
            rounds: [],
          },
        ],
      }),
    );

    const second = await discoverFilesWithProjectCatalog(roots);
    expect(second.projectCatalog.some((entry) => entry.project === staleProject)).toBe(false);
    expect(second.projectCatalog.find((entry) => entry.project === "live-log-viewer-next")).toMatchObject({
      conversations: 1,
      smt: startedAt - 10,
    });
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});
