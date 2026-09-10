import { NextRequest } from "next/server";
import { handleNativeQueue } from "@/lib/runtime/nativeQueueHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { return handleNativeQueue(request); }
export function POST(request: NextRequest) { return handleNativeQueue(request); }
