import { NextRequest, type NextResponse } from "next/server";

import { productionSpawnCommandDependencies, spawnSuggestions } from "@/lib/agent/spawnCommand";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import type { ApiError } from "@/lib/types";

import { executeAdmittedSpawnRequest } from "./membership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return spawnSuggestions(req);
}

export const POST = Object.assign(
  async (req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> => await executeAdmittedSpawnRequest(req),
  {
    withDependencies: executeAdmittedSpawnRequest,
    productionDependencies: productionSpawnCommandDependencies,
  },
);
