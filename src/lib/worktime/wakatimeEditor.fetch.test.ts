import { describe, expect, test } from "bun:test";

import { fetchWakatimeEditorEvidence } from "./wakatimeEditor";

const DAY = "2026-08-14";
const REAL_AT = Date.parse("2026-08-14T09:00:00.000Z") / 1_000;

describe("WakaTime raw editor ingestion", () => {
  test("fetches a Kyiv-safe date envelope and keeps credentials out of evidence", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const credential = "fixture-secret-value";
    const evidence = await fetchWakatimeEditorEvidence(DAY, credential, async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const date = new URL(String(url)).searchParams.get("date");
      const data = date === DAY
        ? [
            { entity: "/repo/a.ts", type: "file", category: "coding", project: "project-a", time: REAL_AT },
            { entity: "/repo/a.ts", type: "file", category: "coding", project: "project-a", time: REAL_AT + 300 },
            { entity: "agent-log-viewer/codex/session", type: "app", category: "ai coding", project: "project-a", time: REAL_AT + 600 },
            { entity: "agent-log-viewer/codex/session", type: "app", category: "ai coding", project: "project-a", time: REAL_AT + 720 },
          ]
        : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    expect(requests.map((request) => new URL(request.url).searchParams.get("date"))).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
    expect(requests.every((request) => request.authorization === `Basic ${Buffer.from(credential).toString("base64")}`)).toBe(true);
    expect(evidence.intervals).toEqual([expect.objectContaining({ project: "project-a" })]);
    expect(evidence.excludedSyntheticMs).toBe(120_000);
    expect(JSON.stringify(evidence)).not.toContain(credential);
    expect(JSON.stringify(evidence)).not.toContain("/repo/a.ts");
  });

  test("fails closed on an incomplete WakaTime response", async () => {
    await expect(fetchWakatimeEditorEvidence(DAY, "fixture", async () => (
      new Response(JSON.stringify({ data: "invalid" }), { status: 200 })
    ))).rejects.toThrow("invalid WakaTime heartbeat response");
  });
});
