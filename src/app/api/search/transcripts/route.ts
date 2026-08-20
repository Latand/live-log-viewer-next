import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import {
  InvalidTranscriptSearchCursorError,
  searchTranscripts,
  type TranscriptSearchItem,
  type TranscriptSpeaker,
} from "@/lib/search/transcriptSearch";
import { cleanTitle } from "@/lib/title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A search result carries the conversation's own title so a row can name the
    conversation it will open, not just the file it was cut from. Null when the
    catalog knows no title for that transcript. */
export interface TranscriptSearchRow extends TranscriptSearchItem {
  title: string | null;
}

function pageLimit(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : undefined;
}

/** `user` is the operator's own prompts, `assistant` the agents' replies; the
    absent param searches both. An unrecognised value is rejected rather than
    silently widened — a typo must not quietly return everything. */
function parseSpeaker(value: string | null): TranscriptSpeaker | null | undefined {
  const speaker = value?.trim();
  if (!speaker) return undefined;
  return speaker === "user" || speaker === "assistant" ? speaker : null;
}

/** Titles for the ≤100 rows of one page, read off the in-memory conversation
    catalog the ordinary `/api/files` scan publishes (`publishConversationCatalogForScan`).
    One pass over the snapshot: no transcript is reopened, no scan is triggered
    — a search must never pay for a full catalog rebuild — and a viewer whose
    catalog has not landed yet simply serves rows without a title. */
function titlesForPaths(paths: ReadonlySet<string>): Map<string, string> {
  const titles = new Map<string, string>();
  if (!paths.size) return titles;
  for (const entry of conversationCatalogSnapshot()) {
    if (paths.has(entry.path) && entry.title.trim()) titles.set(entry.path, cleanTitle(entry.title, 100));
  }
  return titles;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ error: "q is required" }, { status: 400 });
  const speaker = parseSpeaker(url.searchParams.get("speaker"));
  if (speaker === null) return Response.json({ error: "speaker must be user or assistant" }, { status: 400 });
  let page;
  try {
    page = searchTranscripts({
      query,
      project: url.searchParams.get("project")?.trim() || undefined,
      speaker,
      cursor: url.searchParams.get("cursor"),
      limit: pageLimit(url.searchParams.get("limit")),
    });
  } catch (error) {
    if (error instanceof InvalidTranscriptSearchCursorError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  const titles = titlesForPaths(new Set(page.items.map((item) => item.transcriptPath)));
  const items: TranscriptSearchRow[] = page.items.map((item) => ({
    ...item,
    title: titles.get(item.transcriptPath) ?? null,
  }));
  return Response.json({ ...page, items });
}
