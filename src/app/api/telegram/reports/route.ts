import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { validReportChatId, validReportTime, type TelegramReportSettings } from "@/lib/telegram/reportContracts";
import { ensureTelegramReportScheduler, telegramReportRunner } from "@/lib/telegram/reportRunner";
import { connectorReadPort } from "@/lib/telegram/reportSources";
import { readReportText, sanitizeReportSettings, updateTelegramReports } from "@/lib/telegram/reportStore";
import { localDayKey, scheduledRunDue } from "@/lib/telegram/reportSchedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Daily Reports API (issue #1086): the settings and history the panel
 * renders (GET), one report body by id (GET `?report=<id>`), and three actions
 * (POST) — save settings, run now, and discover the operator's groups for the
 * source picker.
 *
 * Report bodies are served only by explicit id, never in the list payload, so
 * the panel's ordinary polling never carries the operator's Telegram content.
 * Every response is sanitized state; nothing here returns a message body, a
 * private-dialog identifier, or a session value.
 */

function failure(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

/* A run id is only ever a file-name component here; the class is what keeps
   it one — no separators, no dots, nothing that could climb out of the
   telegram state directory. */
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function GET(req: NextRequest) {
  try {
    /* The panel's own poll is what keeps the scheduler alive in this process;
       the first ensure also catches up a slot missed while it was down. */
    ensureTelegramReportScheduler();
    const runner = telegramReportRunner();
    const requested = new URL(req.url).searchParams.get("report");
    if (requested) {
      if (!RUN_ID.test(requested)) return failure(400, "invalid_request", "Unknown report");
      const report = readReportText(requested);
      if (report === null) return failure(404, "report_missing", "That report is no longer stored");
      return NextResponse.json({ report });
    }
    return NextResponse.json({ reports: runner.payload() });
  } catch {
    return failure(500, "status_failed", "Telegram reports are unavailable");
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { action?: unknown; settings?: unknown };
  try { body = await req.json() as typeof body; } catch { return failure(400, "invalid_json", "Invalid JSON"); }
  const runner = telegramReportRunner();
  try {
    switch (body.action) {
      case "settings": {
        const raw = body.settings as Partial<TelegramReportSettings> | undefined;
        if (!raw || typeof raw !== "object") return failure(400, "invalid_request", "Settings are required");
        if (raw.time !== undefined && !validReportTime(raw.time)) return failure(400, "invalid_request", "Time must be HH:MM");
        if (Array.isArray(raw.groups) && raw.groups.some((group) => !validReportChatId((group as { id?: unknown })?.id))) {
          return failure(400, "invalid_request", "Group ids are invalid");
        }
        const settings = sanitizeReportSettings(raw);
        updateTelegramReports((state) => {
          const wasEnabled = state.settings.enabled;
          state.settings = settings;
          /* Enabling after today's slot has passed must not fire a run on the
             spot: stamp the day so the first scheduled run is the next one.
             Run now stays available for "I want it right now". */
          if (!wasEnabled && settings.enabled
            && scheduledRunDue({ now: Date.now(), settings, cursor: { ...state.cursor, lastScheduledDay: null } })) {
            state.cursor.lastScheduledDay = localDayKey(Date.now());
          }
        });
        ensureTelegramReportScheduler();
        return NextResponse.json({ reports: runner.payload() });
      }
      case "run-now": {
        /* Returns as soon as the run is durable: the source pass behind it is
           tens of seconds of sequential connector reads, and the panel follows
           the `running` row rather than a held-open request. */
        const launched = await runner.runNow();
        ensureTelegramReportScheduler();
        if (!launched.ok) {
          return NextResponse.json({ error: "Report run could not start", code: launched.code, reports: runner.payload() }, { status: 409 });
        }
        return NextResponse.json({ reports: runner.payload(), runId: launched.runId }, { status: 202 });
      }
      case "groups": {
        /* One bounded listing for the source picker. It reaches the connector,
           so it is an explicit action rather than part of the poll. */
        const chats = await connectorReadPort().listChats({ kind: "group", limit: 100 });
        return NextResponse.json({ groups: chats.map((chat) => ({ id: chat.id, title: chat.title })) });
      }
      default:
        return failure(400, "invalid_action", "Unknown reports action");
    }
  } catch {
    return failure(500, "action_failed", "Telegram reports action failed");
  }
}
