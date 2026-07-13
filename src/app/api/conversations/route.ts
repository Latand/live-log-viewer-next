import { catalogEntryToFileEntry, conversationCatalogReady, conversationCatalogSnapshot, ExpiredConversationCatalogCursorError, loadConversationCatalogPage } from "@/lib/scanner/conversationCatalog";
import { indexConversationCatalog } from "@/lib/scanner/conversationSearchIndex";
import { searchTextForTranscript } from "@/lib/scanner/describe";
import { refreshConversationCatalog } from "@/lib/scanner/discover";
import { overlaySessionProjects, overlaySessionTitles, overlaySessionTitlesYielding } from "@/lib/session/titleProjection";
import { cleanTitle } from "@/lib/title";

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
  const source = conversationCatalogSnapshot();
  const hydrateSearchText = (entry: (typeof source)[number]) => {
    const text = searchTextForTranscript(entry.path, entry.size, entry.engine);
    return {
      ...entry,
      title: entry.kind === "session" && text.title ? cleanTitle(text.title, 120) : entry.title,
      firstPrompt: text.firstPrompt ?? "",
    };
  };
  const options = {
    project: url.searchParams.get("project")?.trim() || undefined,
    query,
    cursor: url.searchParams.get("cursor"),
    limit: pageLimit(url.searchParams.get("limit")),
  };
  try {
    let page;
    if (query) {
      const indexed = await indexConversationCatalog(source, { signal: request.signal });
      const displayed = indexed.map(catalogEntryToFileEntry);
      await overlaySessionTitlesYielding(displayed);
      const displayedByPath = new Map(displayed.map((entry) => [entry.path, entry]));
      const projected = indexed.map((entry) => {
        const display = displayedByPath.get(entry.path);
        return display ? { ...entry, title: display.title, project: display.project } : entry;
      });
      page = await loadConversationCatalogPage(projected, options);
    } else {
      const projectEntries = source.map(catalogEntryToFileEntry);
      overlaySessionProjects(projectEntries);
      const projectByPath = new Map(projectEntries.map((entry) => [entry.path, entry.project]));
      const projected = source.map((entry) => ({ ...entry, project: projectByPath.get(entry.path) ?? entry.project }));
      page = await loadConversationCatalogPage(projected, options, undefined, hydrateSearchText);
      overlaySessionTitles(page.items);
    }
    return Response.json(page);
  } catch (error) {
    if (error instanceof ExpiredConversationCatalogCursorError) {
      return Response.json({ error: "conversation catalog cursor expired" }, { status: 409 });
    }
    throw error;
  }
}
