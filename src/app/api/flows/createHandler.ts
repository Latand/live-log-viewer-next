import { NextRequest, NextResponse } from "next/server";

import { createFlowFromRequest } from "@/lib/flows/commands";
import type { CreateFlowRequest, FlowsResponse } from "@/lib/flows/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { conversationEntryForPath } from "@/lib/scanner/conversationEntry";
import type { ApiError, FileEntry } from "@/lib/types";

type FlowCreateResult = Awaited<ReturnType<typeof createFlowFromRequest>>;

export interface FlowCreateRouteDependencies {
  resolveEntry: (pathname: string) => FileEntry | null;
  createFlow: (body: CreateFlowRequest, entries: FileEntry[]) => Promise<FlowCreateResult>;
}

const DEFAULT_DEPENDENCIES: FlowCreateRouteDependencies = {
  resolveEntry: conversationEntryForPath,
  createFlow: createFlowFromRequest,
};

export async function postFlow(
  req: NextRequest,
  dependencies: FlowCreateRouteDependencies = DEFAULT_DEPENDENCIES,
): Promise<NextResponse<{ ok: true; flow: FlowsResponse["flows"][number] } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: CreateFlowRequest;
  try {
    body = (await req.json()) as CreateFlowRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.implementerPath !== "string" || !body.implementerPath) {
    return NextResponse.json({ error: "implementerPath is required" }, { status: 400 });
  }

  try {
    const entry = dependencies.resolveEntry(body.implementerPath);
    if (!entry) return NextResponse.json({ error: "implementer transcript is unknown" }, { status: 404 });
    const result = await dependencies.createFlow(body, [entry]);
    if (!result.flow) return NextResponse.json({ error: result.error ?? "could not create flow" }, { status: result.status ?? 400 });
    return NextResponse.json({ ok: true, flow: result.flow }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
