import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { deleteProjectFiles, loadProjectConversations } from "./ProjectTrash";

function entry(index: number): FileEntry {
  return { path: `/sessions/${index}.jsonl` } as FileEntry;
}

test("project deletion loads and removes every conversation beyond the scheme cap", async () => {
  const catalog = Array.from({ length: 205 }, (_, index) => entry(index));
  const deleted: string[] = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { paths: string[] };
      deleted.push(...body.paths);
      return Response.json({ ok: true, deleted: body.paths.length });
    }
    if (init?.method === "DELETE") {
      deleted.push(new URL(input, "http://viewer").searchParams.get("path") ?? "");
      return Response.json({ ok: true });
    }
    const url = new URL(input, "http://viewer");
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const items = catalog.slice(start, start + 100);
    const nextCursor = start + items.length < catalog.length ? String(start + items.length) : null;
    return Response.json({ items, nextCursor, total: catalog.length });
  };

  const complete = await loadProjectConversations("large project", fetcher);
  const failed = await deleteProjectFiles("large project", complete, fetcher);

  expect(complete).toHaveLength(205);
  expect(failed).toBe(0);
  expect(deleted).toEqual(catalog.map((file) => file.path));
});

test("project deletion preflights the uncapped targets before removing any transcript", async () => {
  const catalog = Array.from({ length: 205 }, (_, index) => entry(index));
  const preflighted: string[] = [];
  const deleted: string[] = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { paths: string[] };
      preflighted.push(...body.paths);
      return Response.json({ error: "agent is still running" }, { status: 409 });
    }
    if (init?.method === "DELETE") {
      deleted.push(new URL(input, "http://viewer").searchParams.get("path") ?? "");
      return Response.json({ ok: true });
    }
    return Response.json({ items: [], nextCursor: null, total: 0 });
  };

  const failed = await deleteProjectFiles("large project", catalog, fetcher);

  expect(preflighted).toEqual(catalog.map((file) => file.path));
  expect(deleted).toEqual([]);
  expect(failed).toBe(catalog.length);
});
