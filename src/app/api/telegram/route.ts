import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { saveTelegramApiCredentials, validTelegramApiCredentials } from "@/lib/telegram/packaging";
import { ensureTelegramReportScheduler } from "@/lib/telegram/reportRunner";
import { telegramService } from "@/lib/telegram/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole Telegram connection API (issue #1059), deliberately narrow:
 * status (GET, `?fresh=1` runs a health check) and six actions (POST):
 * start, password, credentials, cancel, logout, delete. The `credentials`
 * action (#1070) is the one inbound path that carries an operator-entered
 * secret (api_id + api_hash) — validated, then persisted owner-only. Every
 * RESPONSE is the sanitized TelegramStatusPayload: no session string, no API
 * credential, and no raw upstream error ever leaves this boundary, in a GET
 * payload or otherwise.
 */

function failure(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  try {
    /* The footer row polls this route from every open Viewer, which is what
       keeps the Daily Report scheduler (#1086) alive in this process and
       catches up a slot that passed while it was down. */
    ensureTelegramReportScheduler();
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    if (fresh) {
      const rejected = rejectCrossOrigin(req);
      if (rejected) return rejected;
    }
    const service = telegramService();
    const telegram = fresh ? await service.checkHealth() : service.status();
    return NextResponse.json({ telegram });
  } catch {
    return failure(500, "status_failed", "Telegram status is unavailable");
  }
}

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { action?: unknown; operationId?: unknown; password?: unknown; apiId?: unknown; apiHash?: unknown };
  try { body = await req.json() as typeof body; } catch { return failure(400, "invalid_json", "Invalid JSON"); }
  const service = telegramService();
  try {
    switch (body.action) {
      case "start":
        return NextResponse.json({ telegram: await service.startLogin() }, { status: 202 });
      case "password": {
        if (typeof body.operationId !== "string" || typeof body.password !== "string") {
          return failure(400, "invalid_request", "Operation id and password are required");
        }
        return NextResponse.json({ telegram: await service.submitPassword(body.operationId, body.password) });
      }
      case "cancel": {
        if (typeof body.operationId !== "string") return failure(400, "invalid_request", "Operation id is required");
        return NextResponse.json({ telegram: await service.cancelLogin(body.operationId) });
      }
      case "credentials": {
        /* #1070: operator-entered api_id/api_hash land in the same
           telegram.json the connector reads. Validation happens before any
           write, and the response is the ordinary sanitized status payload —
           the hash never comes back. */
        if (!validTelegramApiCredentials(body.apiId, body.apiHash)) {
          return failure(400, "invalid_credentials", "Telegram API credentials are invalid");
        }
        saveTelegramApiCredentials(body.apiId as string, body.apiHash as string);
        return NextResponse.json({ telegram: service.credentialsSaved() });
      }
      case "logout":
        return NextResponse.json({ telegram: await service.logout() });
      case "delete":
        return NextResponse.json({ telegram: await service.deleteLocalSession() });
      default:
        return failure(400, "invalid_action", "Unknown Telegram action");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram action failed";
    if (message === "a Telegram login operation is already running") return failure(409, "login_busy", message);
    if (message === "a Telegram login operation is running") return failure(409, "login_busy", message);
    if (message === "Telegram login operation is unavailable") return failure(404, "unknown_operation", message);
    if (message === "Telegram login is not awaiting a password") return failure(409, "not_awaiting_password", message);
    if (message === "Telegram password is invalid") return failure(400, "invalid_request", message);
    return failure(500, "action_failed", "Telegram action failed");
  }
}
