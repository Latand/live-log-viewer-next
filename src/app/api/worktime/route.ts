import { createWorktimeExportHandler } from "@/lib/worktime/http";
import { readWorktimeState } from "@/lib/worktime/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createWorktimeExportHandler({
  readState: () => readWorktimeState(),
  now: Date.now,
});
