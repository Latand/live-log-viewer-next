import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const FIRST_PATH = "/allowed/first.jsonl";
const SECOND_PATH = "/allowed/second.jsonl";
let transcriptReads = 0;
let pidTargets = new Map<number, string | null>();

const first = { display: "agents:4.0" };
const second = { display: "agents:5.0" };
const snapshot = {
  hosts: [],
  observation: "available" as const,
  canonicalFor: (pathname: string) => (pathname === FIRST_PATH ? first : pathname === SECOND_PATH ? second : null),
};

mock.module("@/lib/agent/transcriptHost", () => ({
  readTranscriptHosts: async () => {
    transcriptReads += 1;
    return snapshot;
  },
}));
mock.module("@/lib/scanner/roots", () => ({ pathAllowed: (pathname: string) => pathname.startsWith("/allowed/") }));
mock.module("@/lib/tmux", () => ({
  resolveRequestedTmuxTarget: async (pid: number | null) => (pid === null ? null : pidTargets.get(pid) ?? null),
}));

const { POST } = await import("./route");

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/tmux/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("/api/tmux/targets projects every path from one canonical host snapshot", async () => {
  transcriptReads = 0;
  pidTargets = new Map([[11, "agents:9.0"]]);

  const response = await POST(request({
    reqs: [
      { id: "first", pid: 11, path: FIRST_PATH },
      { id: "second", pid: 12, path: SECOND_PATH },
      { id: "pid-only", pid: 11, path: "" },
    ],
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    targets: { first: "agents:4.0", second: "agents:5.0", "pid-only": "agents:9.0" },
  });
  expect(transcriptReads).toBe(1);
});
