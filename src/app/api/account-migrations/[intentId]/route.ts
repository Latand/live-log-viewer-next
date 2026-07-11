import { NextRequest } from "next/server";

import { updateMigrationAction } from "./action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, context: { params: Promise<{ intentId: string }> }) {
  return updateMigrationAction(req, context);
}
