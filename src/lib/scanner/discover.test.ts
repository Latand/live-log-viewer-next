import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "../accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "../agent/registry";
import type { RootKey } from "../types";
import { conversationCatalogSnapshot } from "./conversationCatalog";
import { discoverFiles, discoverFilesWithProjectCatalog } from "./discover";
import { projectForCwd } from "./describe";
import { PROJECT_RESOLUTION_VERSION, projectResolutionStateKey } from "./projectState";
import { FILE_CAP } from "./roots";
import { DEFAULT_SCHEME_CARDS_PER_PROJECT } from "./schemeWindow";

async function writeFixture(pathname: string, content: string, mtimeSeconds: number): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, content);
  await utimes(pathname, mtimeSeconds, mtimeSeconds);
}

test("pure project-catalog discovery leaves the state directory unchanged", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-pure-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    await discoverFilesWithProjectCatalog(roots, undefined, { persist: false });
    expect(existsSync(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"))).toBe(false);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("persisted scheme metadata excludes unbounded first-prompt text", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-bounded-catalog-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const marker = "PROMPT_TAIL_MUST_STAY_OUT_OF_SCHEME_STATE";
    const prompt = `Readable title ${"x".repeat(2_000)} ${marker}`;
    const transcript = path.join(roots["claude-projects"], "bounded", "session.jsonl");
    await writeFixture(transcript, JSON.stringify({ type: "user", message: { content: prompt } }) + "\n", 1_700_000_000);
    const transcriptStat = await stat(transcript);
    await mkdir(process.env.LLV_STATE_DIR, { recursive: true });
    await writeFile(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"), JSON.stringify({
      version: 1,
      resolutionVersion: PROJECT_RESOLUTION_VERSION,
      files: {
        [transcript]: {
          rootName: "claude-projects",
          size: transcriptStat.size,
          mtimeMs: transcriptStat.mtimeMs,
          stateKey: projectResolutionStateKey(),
          project: "bounded",
          kind: "session",
          session: true,
        },
      },
    }));

    await discoverFilesWithProjectCatalog(roots);

    const persisted = await readFile(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"), "utf8");
    expect(persisted).not.toContain(marker);
    expect(conversationCatalogSnapshot().find((entry) => entry.path === transcript)?.firstPrompt).toBe("");
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("a legacy cached Claude subagent is migrated into the conversation catalog", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-legacy-subagent-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const subagent = path.join(roots["claude-projects"], "legacy-project", "session", "subagents", "agent-child.jsonl");
    await writeFixture(subagent, JSON.stringify({ type: "user", message: { content: "Legacy child prompt" } }) + "\n", 1_700_000_010);
    const subagentStat = await stat(subagent);
    await mkdir(process.env.LLV_STATE_DIR, { recursive: true });
    await writeFile(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"), JSON.stringify({
      version: 1,
      resolutionVersion: PROJECT_RESOLUTION_VERSION,
      files: {
        [subagent]: {
          rootName: "claude-projects",
          size: subagentStat.size,
          mtimeMs: subagentStat.mtimeMs,
          stateKey: projectResolutionStateKey(),
          project: "legacy-project",
          kind: "subagent",
          session: false,
        },
      },
    }));

    const scan = await discoverFilesWithProjectCatalog(roots);
    const persisted = JSON.parse(await readFile(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"), "utf8"));

    expect(conversationCatalogSnapshot().map((entry) => entry.path)).toContain(subagent);
    expect(scan.projectCatalog).toContainEqual({ project: "legacy-project", conversations: 1, smt: 1_700_000_010 });
    expect(persisted.version).toBe(2);
    expect(persisted.files[subagent].session).toBe(true);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("project catalog omits task-only residue from a clean state", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-task-residue-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const taskPath = path.join(roots["claude-tasks"], "orphan-project", "missing-session", "tasks", "task.output");
    await writeFixture(taskPath, "finished\n", 1_700_000_000);

    const scan = await discoverFilesWithProjectCatalog(roots);

    expect(scan.files.some((entry) => entry.path === taskPath)).toBe(true);
    expect(scan.projectCatalog).toEqual([]);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("project and conversation catalogs retain a project whose only transcript is a subagent", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-subagent-project-"));
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const subagent = path.join(roots["claude-projects"], "project-only-child", "session", "subagents", "agent-child.jsonl");
    await writeFixture(subagent, JSON.stringify({ type: "user", message: { content: "Child prompt" } }) + "\n", 1_700_000_000);

    const scan = await discoverFilesWithProjectCatalog(roots);

    expect(scan.projectCatalog).toContainEqual({ project: "project-only-child", conversations: 1, smt: 1_700_000_000 });
    expect(conversationCatalogSnapshot().map((entry) => entry.path)).toContain(subagent);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFiles preserves scanner filters, mtime ordering, and the per-project scheme cap", async () => {
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

    expect(entries).toHaveLength(DEFAULT_SCHEME_CARDS_PER_PROJECT + 2);
    expect(entries[0]?.path).toBe(taskPath);
    expect(entries.slice(1, -1).map((entry) => entry.name)).toEqual(
      Array.from({ length: DEFAULT_SCHEME_CARDS_PER_PROJECT }, (_, offset) => {
        const index = FILE_CAP - 1 - offset;
        return `session-${String(index).padStart(3, "0")}.jsonl`;
      }),
    );
    expect(entries.at(-1)?.name).toBe(path.join("project-a", "sid-a", "subagents", "agent-mirrored.jsonl"));
    expect(entries.some((entry) => entry.name === "session-000.jsonl")).toBe(false);
    expect(entries.some((entry) => entry.name === "session-001.jsonl")).toBe(false);
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

test("discoverFiles applies the card cap independently to each visible project", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-fair-cap-"));
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const startedAt = 1_700_000_000;
    for (let index = 0; index < FILE_CAP; index += 1) {
      await writeFixture(
        path.join(roots["codex-sessions"], `flood-${String(index).padStart(3, "0")}.jsonl`),
        JSON.stringify({ type: "session_meta", payload: { cwd: path.join(os.homedir(), "Projects", "project-a") } }) + "\n",
        startedAt + index,
      );
    }
    const quietPaths: string[] = [];
    for (let index = 0; index < DEFAULT_SCHEME_CARDS_PER_PROJECT + 2; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `quiet-${String(index).padStart(3, "0")}.jsonl`);
      quietPaths.push(pathname);
      await writeFixture(
        pathname,
        JSON.stringify({ type: "session_meta", payload: { cwd: path.join(os.homedir(), "Projects", "project-b") } }) + "\n",
        startedAt - 100 + index,
      );
    }

    const entries = await discoverFiles(roots);
    const visibleQuietPaths = entries.filter((entry) => entry.project === "project-b").map((entry) => entry.path);

    expect(entries).toHaveLength(DEFAULT_SCHEME_CARDS_PER_PROJECT * 2);
    expect(visibleQuietPaths).toEqual(quietPaths.slice(-DEFAULT_SCHEME_CARDS_PER_PROJECT).reverse());
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

test("discoverFiles counts a dual-root Codex rollout once and prefers the account copy", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-codex-duplicate-"));
  try {
    const defaultRoot = path.join(base, "codex-default");
    const accountRoot = path.join(base, "codex-account");
    const claudeProjects = path.join(base, "claude-projects");
    const claudeTasks = path.join(base, "claude-tasks");
    await Promise.all([defaultRoot, accountRoot, claudeProjects, claudeTasks].map((root) => mkdir(root, { recursive: true })));
    const rolloutName = "rollout-2026-07-13T10-00-00-019fa123-4567-7890-abcd-ef0123456789.jsonl";
    const defaultFile = path.join(defaultRoot, "2026", "07", "13", rolloutName);
    const accountFile = path.join(accountRoot, "2026", "07", "13", rolloutName);
    await writeFixture(
      defaultFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: path.join(os.homedir(), "Projects", "default-project") } }) + "\n",
      20,
    );
    await writeFixture(
      accountFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: path.join(os.homedir(), "Projects", "account-project") } }) + "\n",
      10,
    );

    const scan = await discoverFilesWithProjectCatalog(
      [
        ["codex-sessions", defaultRoot],
        ["codex-sessions", accountRoot],
        ["claude-projects", claudeProjects],
        ["claude-tasks", claudeTasks],
      ],
      undefined,
      { persist: false },
    );

    expect(scan.files).toHaveLength(1);
    expect(scan.files[0]).toMatchObject({ path: accountFile, project: "account-project" });
    expect(scan.projectCatalog).toContainEqual({ project: "account-project", conversations: 1, smt: 10 });
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

    expect(entries).toHaveLength(DEFAULT_SCHEME_CARDS_PER_PROJECT + 1);
    expect(entries[0]?.path).toBe(childPath);
    expect(entries.some((entry) => entry.path === parentPath)).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFilesWithProjectCatalog keeps quiet projects in the recent cap", async () => {
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

    expect(scan.files.some((entry) => entry.path === oldPath)).toBe(true);
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

test("registry launch projects govern scheme caps and the uncapped project catalog", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-launch-project-cap-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  const registry = new AgentRegistry(path.join(base, "registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const paths: string[] = [];
    for (let index = 0; index < DEFAULT_SCHEME_CARDS_PER_PROJECT * 2; index += 1) {
      const scannerProject = index % 2 === 0 ? "scanner-a" : "scanner-b";
      const pathname = path.join(roots["claude-projects"], scannerProject, `session-${index}.jsonl`);
      paths.push(pathname);
      await writeFixture(pathname, JSON.stringify({ type: "user", message: { content: `Prompt ${index}` } }) + "\n", 1_700_030_000 + index);
    }
    registry.reconcileConversations(paths.map((pathname, index) => ({
      engine: "claude" as const,
      path: pathname,
      accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: base, project: "effective-project" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt: new Date((1_700_030_000 + index) * 1000).toISOString(),
    })));

    const scan = await discoverFilesWithProjectCatalog(roots);

    expect(scan.files.filter((entry) => entry.project === "effective-project")).toHaveLength(DEFAULT_SCHEME_CARDS_PER_PROJECT);
    expect(scan.projectCatalog).toEqual([{
      project: "effective-project",
      conversations: DEFAULT_SCHEME_CARDS_PER_PROJECT * 2,
      smt: 1_700_030_000 + DEFAULT_SCHEME_CARDS_PER_PROJECT * 2 - 1,
    }]);
  } finally {
    setAgentRegistryForTests(null);
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("discoverFilesWithProjectCatalog keeps a selected project inside the scheme card cap", async () => {
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
    const quietPaths: string[] = [];
    for (let index = 0; index < DEFAULT_SCHEME_CARDS_PER_PROJECT + 2; index += 1) {
      const quietPath = path.join(roots["claude-projects"], projectSlug, `quiet-session-${index}.jsonl`);
      quietPaths.push(quietPath);
      await writeFixture(quietPath, JSON.stringify({ type: "user", message: { content: "Quiet project" } }) + "\n", startedAt - 20 + index);
    }
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

    expect(overviewScan.files.filter((entry) => entry.project === "stikon-dispatcher")).toHaveLength(DEFAULT_SCHEME_CARDS_PER_PROJECT);
    expect(selectedScan.projectCatalog.find((entry) => entry.project === "stikon-dispatcher")).toEqual({
      project: "stikon-dispatcher",
      conversations: DEFAULT_SCHEME_CARDS_PER_PROJECT + 2,
      smt: startedAt - 20 + DEFAULT_SCHEME_CARDS_PER_PROJECT + 1,
    });
    expect(selectedScan.files.filter((entry) => entry.project === "stikon-dispatcher").map((entry) => entry.path)).toEqual(
      quietPaths.slice(-DEFAULT_SCHEME_CARDS_PER_PROJECT).reverse(),
    );
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
    expect(first.files.some((entry) => entry.path === sessionPath)).toBe(true);
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

test("discoverFilesWithProjectCatalog heals pre-resolver catalog and board project keys", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-catalog-heal-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  try {
    const stateDir = path.join(base, "state");
    process.env.LLV_STATE_DIR = stateDir;
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all([...Object.values(roots), stateDir].map((root) => mkdir(root, { recursive: true })));

    const repo = path.join(os.homedir(), ".agents", "tools", "catalog-heal-repo");
    const deletedWorktree = path.join(repo, ".worktrees", "deleted-branch");
    const slug = deletedWorktree.replace(/[^a-zA-Z0-9]/g, "-");
    const sessionPath = path.join(roots["claude-projects"], slug, "session-id.jsonl");
    const taskPath = path.join(roots["claude-tasks"], slug, "session-id", "tasks", "task.output");
    const codexPath = path.join(roots["codex-sessions"], "codex.jsonl");
    const deletedCodexCwd = path.join(
      os.homedir(),
      ".codex",
      "worktrees",
      "deleted-catalog-fixture",
      "CelestiaCompose",
      "worktrees",
      "deleted-child",
    );
    await writeFixture(
      sessionPath,
      JSON.stringify({ type: "user", cwd: deletedWorktree, message: { content: "Heal catalog" } }) + "\n",
      1_700_040_000,
    );
    await writeFixture(taskPath, "finished\n", 1_700_040_001);
    await writeFixture(
      codexPath,
      JSON.stringify({ type: "session_meta", payload: { cwd: deletedCodexCwd } }) + "\n",
      1_700_040_002,
    );

    const canonicalProject = projectForCwd(repo)!;
    const staleProject = projectForCwd(deletedWorktree.replace(".worktrees", "old-worktrees"))!;
    const staleCodexProject = "-codex-worktrees-deleted-catalog-fixture-CelestiaCompose";
    const stateKey = projectResolutionStateKey();
    const cached = async (rootName: RootKey, pathname: string, project: string, kind: string, session: boolean) => {
      const fileStat = await stat(pathname);
      return { rootName, size: fileStat.size, mtimeMs: fileStat.mtimeMs, stateKey, project, kind, session };
    };
    await writeFile(
      path.join(stateDir, "project-catalog.json"),
      JSON.stringify({
        version: 1,
        resolutionVersion: 0,
        files: {
          [sessionPath]: await cached("claude-projects", sessionPath, staleProject, "session", true),
          [taskPath]: await cached("claude-tasks", taskPath, staleProject, "background", false),
          [codexPath]: await cached("codex-sessions", codexPath, staleCodexProject, "session", true),
        },
      }),
    );
    const boardState = (manual: string[]) => ({
      schemaVersion: 1,
      revision: 1,
      updatedAt: "2026-07-10T00:00:00.000Z",
      pathAliases: {},
      prefs: { manual, hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    });
    const boardFile = path.join(stateDir, "board.json");
    const boardValue = { projects: {
        [canonicalProject]: boardState(["/canonical"]),
        [staleProject]: boardState(["/stale"]),
        [staleCodexProject]: boardState([]),
    } };
    await writeFile(boardFile, "{ corrupt");

    const preview = await discoverFilesWithProjectCatalog(roots);

    expect(preview.projectCatalog.some((entry) => entry.project === staleProject || entry.project === staleCodexProject)).toBe(false);
    const deferredCatalog = JSON.parse(await readFile(path.join(stateDir, "project-catalog.json"), "utf8"));
    expect(deferredCatalog.resolutionVersion).toBe(0);
    expect(deferredCatalog.files[sessionPath].project).toBe(staleProject);

    await writeFile(boardFile, JSON.stringify(boardValue));

    const scan = await discoverFilesWithProjectCatalog(roots);

    expect(scan.projectCatalog.some((entry) => entry.project === staleProject || entry.project === staleCodexProject)).toBe(false);
    expect(scan.projectCatalog.find((entry) => entry.project === canonicalProject)).toMatchObject({ conversations: 1 });
    expect(scan.projectCatalog.find((entry) => entry.project === "CelestiaCompose")).toMatchObject({ conversations: 1 });
    expect(scan.files.find((entry) => entry.path === taskPath)?.project).toBe(canonicalProject);

    const persistedCatalog = JSON.parse(await readFile(path.join(stateDir, "project-catalog.json"), "utf8"));
    expect(persistedCatalog.files[sessionPath].project).toBe(canonicalProject);
    expect(persistedCatalog.files[taskPath].project).toBe(canonicalProject);
    expect(persistedCatalog.files[codexPath].project).toBe("CelestiaCompose");
    const persistedBoard = JSON.parse(await readFile(path.join(stateDir, "board.json"), "utf8"));
    expect(persistedBoard.projects[staleProject]).toBeUndefined();
    expect(persistedBoard.projects[staleCodexProject]).toBeUndefined();
    expect(persistedBoard.projects[canonicalProject].prefs.manual).toEqual(["/canonical", "/stale"]);
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("catalog healing preserves board state for a source project with surviving conversations", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-catalog-split-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  try {
    const stateDir = path.join(base, "state");
    process.env.LLV_STATE_DIR = stateDir;
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all([...Object.values(roots), stateDir].map((root) => mkdir(root, { recursive: true })));

    const sourceProject = "legacy-shared";
    const retiredProject = "retired-legacy-project";
    const retainedPath = path.join(roots["codex-sessions"], "retained.jsonl");
    const movedPath = path.join(roots["codex-sessions"], "moved.jsonl");
    const retiredPath = path.join(roots["codex-sessions"], "retired.jsonl");
    const canonicalRepo = path.join(os.homedir(), ".agents", "tools", "catalog-split-repo");
    const canonicalProject = projectForCwd(canonicalRepo)!;
    await writeFixture(
      retainedPath,
      JSON.stringify({ type: "session_meta", payload: { cwd: path.join(os.homedir(), "Projects", sourceProject) } }) + "\n",
      1_700_050_000,
    );
    await writeFixture(
      movedPath,
      JSON.stringify({ type: "session_meta", payload: { cwd: path.join(canonicalRepo, ".worktrees", "deleted") } }) + "\n",
      1_700_050_001,
    );
    await writeFixture(
      retiredPath,
      JSON.stringify({ type: "session_meta", payload: { cwd: path.join(os.homedir(), "Projects", sourceProject) } }) + "\n",
      1_700_050_002,
    );
    const stateKey = projectResolutionStateKey();
    const cached = async (pathname: string, project = sourceProject) => {
      const fileStat = await stat(pathname);
      return {
        rootName: "codex-sessions",
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        stateKey,
        project,
        kind: "session",
        session: true,
      };
    };
    await writeFile(path.join(stateDir, "project-catalog.json"), JSON.stringify({
      version: 1,
      resolutionVersion: 0,
      files: {
        [retainedPath]: await cached(retainedPath),
        [movedPath]: await cached(movedPath),
        [retiredPath]: await cached(retiredPath, retiredProject),
      },
    }));
    const sourceBoard = {
      schemaVersion: 1,
      revision: 1,
      updatedAt: "2026-07-10T00:00:00.000Z",
      pathAliases: {},
      prefs: { manual: ["/source"], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    };
    await writeFile(path.join(stateDir, "board.json"), JSON.stringify({ projects: {
      [sourceProject]: sourceBoard,
      [retiredProject]: { ...sourceBoard, prefs: { ...sourceBoard.prefs, manual: ["/retired"] } },
    } }));

    const scan = await discoverFilesWithProjectCatalog(roots);

    expect(scan.projectCatalog.find((entry) => entry.project === sourceProject)).toMatchObject({ conversations: 2 });
    expect(scan.projectCatalog.find((entry) => entry.project === canonicalProject)).toMatchObject({ conversations: 1 });
    const board = JSON.parse(await readFile(path.join(stateDir, "board.json"), "utf8"));
    expect(board.projects[sourceProject]?.prefs.manual).toEqual(["/source", "/retired"]);
    expect(board.projects[retiredProject]).toBeUndefined();
    expect(board.projects[canonicalProject]).toBeUndefined();
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
});

test("demoted archived predecessors rank below live transcripts for the recency cap", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-discover-demote-"));
  try {
    const roots: Record<RootKey, string> = {
      "codex-sessions": path.join(base, "codex-sessions"),
      "claude-projects": path.join(base, "claude-projects"),
      "claude-tasks": path.join(base, "claude-tasks"),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const startedAt = 1_700_030_000;
    /* The newest transcript is an archived migration predecessor; the oldest
       is a live conversation that the plain mtime cap would evict. */
    const archivedPath = path.join(roots["codex-sessions"], "archived-predecessor.jsonl");
    await writeFixture(archivedPath, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n", startedAt + DEFAULT_SCHEME_CARDS_PER_PROJECT + 10);
    const oldestLivePath = path.join(roots["codex-sessions"], "oldest-live.jsonl");
    await writeFixture(oldestLivePath, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n", startedAt - 10);
    for (let index = 0; index < DEFAULT_SCHEME_CARDS_PER_PROJECT - 1; index += 1) {
      const pathname = path.join(roots["codex-sessions"], `live-${String(index).padStart(3, "0")}.jsonl`);
      await writeFixture(pathname, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n", startedAt + index);
    }

    const entries = await discoverFiles(roots, new Set([archivedPath]));

    /* Every live transcript makes the cap; the archived predecessor yields its
       slot despite carrying the freshest mtime. */
    expect(entries).toHaveLength(DEFAULT_SCHEME_CARDS_PER_PROJECT);
    expect(entries.some((entry) => entry.path === oldestLivePath)).toBe(true);
    expect(entries.some((entry) => entry.path === archivedPath)).toBe(false);

    /* With slack under the cap the archived predecessor still rides along. */
    const withSlack = await discoverFiles(roots, new Set([archivedPath, oldestLivePath]));
    expect(withSlack.some((entry) => entry.path === archivedPath)).toBe(true);

    /* A fresh `#f=` deep link carries no selected project; pinning the exact
       path keeps the demoted predecessor in the capped feed so the link can
       resolve its conversation id. */
    const pinnedScan = await discoverFilesWithProjectCatalog(roots, undefined, { demote: new Set([archivedPath]), pin: new Set([archivedPath]) });
    expect(pinnedScan.files.some((entry) => entry.path === archivedPath)).toBe(true);
    const pinnedProject = pinnedScan.files.find((entry) => entry.path === archivedPath)?.project;
    expect(pinnedScan.projectCatalog.find((entry) => entry.project === pinnedProject)?.conversations)
      .toBe(DEFAULT_SCHEME_CARDS_PER_PROJECT);

    /* Project selection leaves the scheme window bounded; the explicit pin
       above is the route that admits an excluded predecessor. */
    const project = withSlack.find((entry) => entry.path === archivedPath)?.project ?? "other";
    const selected = await discoverFilesWithProjectCatalog(roots, project, { demote: new Set([archivedPath]) });
    expect(selected.files.some((entry) => entry.path === archivedPath)).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
