import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

const originalToken = process.env.LLV_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = originalToken;
});

function remote(authorization: string): NextRequest {
  return new NextRequest("http://viewer.example/api/agent/snapshot", { headers: { host: "viewer.example", "x-forwarded-for": "203.0.113.10", authorization } });
}

test("remote agent access accepts the exact Bearer LLV_TOKEN", () => {
  process.env.LLV_TOKEN = "viewer-token";
  expect(proxy(remote("Bearer viewer-token")).headers.get("x-middleware-next")).toBe("1");
  expect(proxy(remote("Bearer wrong-token")).status).toBe(403);
});
