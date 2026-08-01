import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { systemScheduler } from "@/lib/deadline";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { resolveSiblings } from "@/lib/view/siblings";

import { postSnapshot } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const SNAPSHOT_DEADLINE_MS = 10_000;

const productionDependencies = {
  completedFileScan,
  resolveSiblings,
  snapshotTitleConversations: (conversationIds: readonly string[]) => agentRegistry().snapshotTitleConversations(conversationIds),
  snapshotSpawns: (launchIds: readonly string[]) => agentRegistry().snapshotSpawns(launchIds),
  snapshotDeadlineMs: SNAPSHOT_DEADLINE_MS,
  scheduler: systemScheduler,
} satisfies Parameters<typeof postSnapshot>[1];

export async function POST(request: NextRequest): Promise<NextResponse> {
  return postSnapshot(request, productionDependencies);
}
