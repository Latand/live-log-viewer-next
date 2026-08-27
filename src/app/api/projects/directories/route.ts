import { NextRequest, NextResponse } from "next/server";

import { suggestDirectories } from "@/lib/projects/directorySuggestions";
import { suggestionRoots } from "@/lib/projects/suggestionRoots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Directory suggestions for the create-project form (issue #1223).
 *
 * The rail's picker filters a list it is handed, and a project that does not
 * exist yet is exactly what no such list carries — so the list comes from
 * here, from the filesystem, bounded to the directories where the viewer's
 * projects already live. `q` is what the operator has typed so far: a path
 * completes inside those roots, anything else filters what they hold.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(
    { dirs: suggestDirectories(query, suggestionRoots()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
