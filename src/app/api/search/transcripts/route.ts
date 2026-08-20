import {
  InvalidTranscriptSearchCursorError,
  searchTranscripts,
} from "@/lib/search/transcriptSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pageLimit(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : undefined;
}

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (!query) return Response.json({ error: "q is required" }, { status: 400 });
  try {
    return Response.json(searchTranscripts({
      query,
      project: url.searchParams.get("project")?.trim() || undefined,
      cursor: url.searchParams.get("cursor"),
      limit: pageLimit(url.searchParams.get("limit")),
    }));
  } catch (error) {
    if (error instanceof InvalidTranscriptSearchCursorError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
