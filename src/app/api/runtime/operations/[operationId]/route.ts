import { NextRequest, NextResponse } from "next/server";

import { handleRuntimeDiscard, handleRuntimeOperationQuery, handleRuntimeRetry } from "@/lib/runtime/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OperationRouteContext = {
  params: Promise<{ operationId: string }>;
};

export async function GET(_request: Request, context: OperationRouteContext): Promise<NextResponse> {
  const { operationId } = await context.params;
  return handleRuntimeOperationQuery(operationId);
}

export async function POST(request: NextRequest, context: OperationRouteContext): Promise<NextResponse> {
  const { operationId } = await context.params;
  return handleRuntimeRetry(request, operationId);
}

export async function DELETE(request: NextRequest, context: OperationRouteContext): Promise<NextResponse> {
  const { operationId } = await context.params;
  return handleRuntimeDiscard(request, operationId);
}
