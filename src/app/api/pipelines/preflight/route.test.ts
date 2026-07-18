import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import type { PipelineRepoPreflight } from "@/lib/pipelines/types";

const { POST } = await import("./route");

function request(body: string, origin?: string): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/pipelines/preflight", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body,
  });
}

test("pipeline preflight admits a same-origin canonical repository", async () => {
  const response = await POST.withDependencies(
    request(JSON.stringify({ repoDir: "~/repo" }), "http://127.0.0.1:8898"),
    { preflight: () => ({ ok: true, repoDir: "/srv/repo", gitCommonDir: "/srv/repo/.git", worktreeParent: "/srv" }) },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, repoDir: "/srv/repo", gitCommonDir: "/srv/repo/.git", worktreeParent: "/srv" });
});

test("pipeline preflight rejects cross-origin and malformed bodies before admission", async () => {
  let calls = 0;
  const dependencies = { preflight: () => { calls += 1; return { ok: false, code: "missing", path: "/repo" } as PipelineRepoPreflight; } };

  expect((await POST.withDependencies(request("{", "http://127.0.0.1:8898"), dependencies)).status).toBe(400);
  expect((await POST.withDependencies(request("[]", "http://127.0.0.1:8898"), dependencies)).status).toBe(400);
  expect((await POST.withDependencies(request(JSON.stringify({ repoDir: "" }), "http://127.0.0.1:8898"), dependencies)).status).toBe(400);
  expect((await POST.withDependencies(request(JSON.stringify({ repoDir: "/repo" }), "https://example.com"), dependencies)).status).toBe(403);
  expect(calls).toBe(0);
});

test("pipeline preflight maps stable result codes to field errors", async () => {
  const cases: Array<{ result: Extract<PipelineRepoPreflight, { ok: false }>; status: number }> = [
    { result: { ok: false, code: "missing", path: "/missing" }, status: 400 },
    { result: { ok: false, code: "not_directory", path: "/file" }, status: 400 },
    { result: { ok: false, code: "not_git", path: "/plain" }, status: 400 },
    { result: { ok: false, code: "repo_unreadable", path: "/private" }, status: 403 },
    { result: { ok: false, code: "repo_untraversable", path: "/sealed" }, status: 403 },
    { result: { ok: false, code: "git_metadata_unwritable", path: "/repo/.git" }, status: 403 },
    { result: { ok: false, code: "worktree_parent_unwritable", path: "/srv" }, status: 403 },
  ];

  for (const item of cases) {
    const response = await POST.withDependencies(request(JSON.stringify({ repoDir: "/repo" })), { preflight: () => item.result });
    expect(response.status).toBe(item.status);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: item.result.code,
      field: "repoDir",
      path: item.result.path,
    });
  }
});
