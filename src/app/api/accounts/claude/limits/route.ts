import type { NextRequest } from "next/server";

import { handleLimitsRefresh } from "../../limitsRefresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Re-read one Claude account's live limits now (issue #1418). */
export async function POST(req: NextRequest) {
  return handleLimitsRefresh("claude", req);
}
