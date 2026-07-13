import { conversationCatalogReady, conversationCatalogSnapshot, loadConversationCatalogPage } from "@/lib/scanner/conversationCatalog";
import { firstPromptForTranscript } from "@/lib/scanner/describe";
import { refreshConversationCatalog } from "@/lib/scanner/discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pageLimit(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!conversationCatalogReady()) await refreshConversationCatalog();
  const query = url.searchParams.get("q")?.trim() || undefined;
  const catalog = query
    ? conversationCatalogSnapshot().map((entry) => entry.firstPrompt ? entry : {
      ...entry,
      firstPrompt: firstPromptForTranscript(entry.path, entry.size, entry.engine),
    })
    : conversationCatalogSnapshot();
  const page = await loadConversationCatalogPage(catalog, {
    project: url.searchParams.get("project")?.trim() || undefined,
    query,
    cursor: url.searchParams.get("cursor"),
    limit: pageLimit(url.searchParams.get("limit")),
  });
  return Response.json(page);
}
