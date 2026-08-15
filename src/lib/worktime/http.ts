import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { kyivDayBounds, previousCompleteKyivDay } from "./calculator";
import { exportStoredDailyRollup } from "./service";
import type { WorktimeStateV1 } from "./types";

interface WorktimeExportDependencies {
  readState(): WorktimeStateV1;
  now(): number;
}

export function createWorktimeExportHandler(dependencies: WorktimeExportDependencies) {
  return async function worktimeExport(request: NextRequest): Promise<NextResponse> {
    const rejection = rejectCrossOrigin(request);
    if (rejection) return rejection;
    const authority = requireOperatorAuthority(request);
    if (!authority.ok) return NextResponse.json({ error: authority.error }, { status: authority.status });
    const day = request.nextUrl.searchParams.get("day") ?? previousCompleteKyivDay(dependencies.now());
    try {
      kyivDayBounds(day);
    } catch {
      return NextResponse.json({ error: "day must use YYYY-MM-DD" }, { status: 400 });
    }
    let state: WorktimeStateV1;
    try {
      state = dependencies.readState();
    } catch {
      return NextResponse.json({ error: "worktime state is unavailable" }, { status: 500 });
    }
    if (!state.rollups[day]) return NextResponse.json({ error: `worktime rollup is unavailable for ${day}` }, { status: 404 });
    return NextResponse.json(exportStoredDailyRollup(state, day), {
      headers: { "Cache-Control": "no-store" },
    });
  };
}
