import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    ok: true,
    name: "Agent Log Viewer", version: 1,
    capabilities: [{ name: "viewer.snapshot", method: "POST", path: "/api/agent/snapshot", description: "Read the active browser view without mutating it.", example: "curl -sS http://127.0.0.1:8898/api/agent/snapshot -H 'content-type: application/json' --data '{\"schemaVersion\":1}'" }],
    auth: "Loopback calls are trusted. Remote callers require Authorization: Bearer $LLV_TOKEN.",
    multiDevice: "The latest eligible interaction is selected and alternatives are reported. Send view.resolution=require-explicit to reject close races.",
  }, { headers: { "Cache-Control": "no-store" } });
}
