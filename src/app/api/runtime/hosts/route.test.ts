import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { procBackend } from "@/lib/proc";
import { noteStructuredHostTargets, resetResourcesForTests, type StructuredHostKillRef } from "@/lib/resources";

import { POST } from "./route";

/**
 * Every kill here runs against a process tree this file spawned itself: a
 * detached `sh` leading its own process group with two sleeping children under
 * it — the same shape as a host's shell wrapper plus its descendants. No test
 * in this file may reach a real agent host, so nothing reads the operator's
 * registry or runtime either.
 */
const fixtures: ChildProcess[] = [];

function spawnFixtureTree(): { pid: number; startIdentity: string | null } {
  const child = spawn("/bin/sh", ["-c", "sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" });
  fixtures.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture tree did not start");
  return { pid, startIdentity: procBackend.processIdentity(pid) };
}

async function settle(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

function ref(over: Partial<StructuredHostKillRef> & Pick<StructuredHostKillRef, "pid">): StructuredHostKillRef {
  return {
    startIdentity: null,
    engine: "claude",
    /* No session id: an orphaned host, the class that has no registry row to
       retire — which is exactly what keeps this test off the registry. */
    sessionId: null,
    conversationId: null,
    seat: false,
    turnBusy: false,
    owned: false,
    lastActiveAt: null,
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/hosts", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  for (const child of fixtures.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone: the test under it did its job */
    }
  }
  resetResourcesForTests();
});

test("a target outside the last snapshot is refused before any signal", async () => {
  const tree = spawnFixtureTree();
  noteStructuredHostTargets([]);

  const response = await POST(post({ action: "kill", target: `structured:pid:${tree.pid}` }));

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("refresh") });
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
});

test("a listed target naming the viewer's own process chain is still refused", async () => {
  noteStructuredHostTargets([{ target: "structured:pid:viewer", ref: ref({ pid: process.pid }) }]);

  const response = await POST(post({ action: "kill", target: "structured:pid:viewer" }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("viewer") });
});

test("killing a listed host takes the whole tree down and consumes the target", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  const descendants = await settle(() => procBackend.ppidMap().size > 0
    && [...procBackend.ppidMap()].filter(([, ppid]) => ppid === tree.pid).length === 2);
  expect(descendants).toBeTrue();
  const children = [...procBackend.ppidMap()].filter(([, ppid]) => ppid === tree.pid).map(([pid]) => pid);
  noteStructuredHostTargets([{ target, ref: ref({ pid: tree.pid, startIdentity: tree.startIdentity }) }]);

  const response = await POST(post({ action: "kill", target }));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, target, remaining: 0 });
  expect(await settle(() => !procBackend.pidAlive(tree.pid))).toBeTrue();
  for (const child of children) {
    expect(await settle(() => !procBackend.pidAlive(child)), `descendant ${child}`).toBeTrue();
  }

  /* The pid is the kernel's to reuse now, so the same POST must not pass again. */
  const replay = await POST(post({ action: "kill", target }));
  expect(replay.status).toBe(400);
});

test("a live orchestrator seat is only killed when the operator ticks it", async () => {
  const tree = spawnFixtureTree();
  const target = "structured:codex:seat";
  const seat = { target, ref: ref({ pid: tree.pid, startIdentity: tree.startIdentity, engine: "codex", seat: true }) };
  noteStructuredHostTargets([seat]);

  const refused = await POST(post({ action: "kill", target }));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("orchestrator seat") });
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();

  const ticked = await POST(post({ action: "kill", target, includeSeat: true }));
  expect(ticked.status).toBe(200);
  expect(await settle(() => !procBackend.pidAlive(tree.pid))).toBeTrue();
});

test("a recycled pid fails the process fence instead of killing the new owner", async () => {
  const tree = spawnFixtureTree();
  const target = `structured:pid:${tree.pid}`;
  noteStructuredHostTargets([{ target, ref: ref({ pid: tree.pid, startIdentity: "1:not-this-process" }) }]);

  const response = await POST(post({ action: "kill", target }));

  expect(response.status).toBe(409);
  expect(procBackend.pidAlive(tree.pid)).toBeTrue();
});

test("a cross-origin kill is refused", async () => {
  const response = await POST(post({ action: "kill", target: "structured:pid:1" }, {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  }));

  expect(response.status).toBe(403);
});
