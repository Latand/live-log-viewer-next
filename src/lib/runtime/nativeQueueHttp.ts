import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";
import type { NativeQueueSnapshot } from "./nativeCodexQueue";
import { parseRuntimeCommand } from "./commands";
import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { structuredHostsEnabled } from "./flags";
import { admitRuntimeImagePayload, type RuntimeImageAdmissionResult } from "./runtimeImageAdmission";
import { runtimeImageStore, type RuntimeImageUpload } from "./runtimeImageStore";
import type { StructuredImageRef } from "./structuredContent";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

interface Dependencies {
  client(): RuntimeHostClient | null;
  enabled(): boolean;
  kick(): void;
  admitImages(images: unknown): RuntimeImageAdmissionResult;
  storeImages(uploads: readonly RuntimeImageUpload[]): StructuredImageRef[];
  nativeSnapshot?(conversationId: string): Promise<NativeQueueSnapshot | null>;
}
const defaults: Dependencies = {
  client: runtimeHostClient, enabled: structuredHostsEnabled, kick: kickStructuredDeliveryQueue,
  admitImages: (images) => admitRuntimeImagePayload({ images }),
  storeImages: (uploads) => runtimeImageStore().putMany(uploads),
  nativeSnapshot: async (id) => {
    const native = structuredDeliveryHostForConversation(id)?.nativeQueue;
    if (!native) return null;
    try { return await native.queue.refresh(); } catch { return native.queue.read(); }
  },
};

/** Admissions return as soon as the journal commits; no native RPC on this hop. */
export async function handleNativeQueue(request: NextRequest, dependencies: Dependencies = defaults): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  if (!dependencies.enabled()) return NextResponse.json({ error: "structured hosts are disabled" }, { status: 503 });
  const client = dependencies.client();
  if (!client?.nativeQueueRead) return NextResponse.json({ error: "native queue journal is unavailable" }, { status: 503 });
  if (request.method === "GET") {
    const conversationId = request.nextUrl.searchParams.get("conversationId");
    if (!conversationId || !/^conversation_[a-zA-Z0-9_-]+$/.test(conversationId)) return NextResponse.json({ error: "conversationId is invalid" }, { status: 400 });
    try {
      const [entries, native] = await Promise.all([
        client.nativeQueueRead(conversationId), dependencies.nativeSnapshot?.(conversationId) ?? null,
      ]);
      return NextResponse.json({ entries, native });
    } catch {
      return NextResponse.json({ error: "native queue history is unavailable" }, { status: 503 });
    }
  }
  let command;
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  /* #1629: the composer stages attachments as bytes, exactly as it does for an
     ordinary send, so a queued message must be able to carry them. The bytes are
     admitted and content-addressed HERE and the command carries refs — the same
     road `/api/runtime/send` takes, and the reason the command's own 256 KiB
     ceiling bounds the command rather than the attachment. */
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const payload = body as Record<string, unknown>;
    /* #1117: this route is the operator's own composer surface, exactly as
       `/api/runtime/send` is, so authorship is stamped HERE and never read off
       the body — a queued message keeps the same provenance a sent one has. */
    body = { ...payload, origin: { kind: "operator" } };
    if (Array.isArray(payload.images) && payload.images.some((image) => image && typeof image === "object" && "base64" in image)) {
      const admitted = dependencies.admitImages(payload.images);
      if (admitted.error) return NextResponse.json({ error: admitted.error.error }, { status: admitted.error.status });
      body = { ...(body as Record<string, unknown>), images: dependencies.storeImages(admitted.images) };
    }
  }
  try { command = parseRuntimeCommand("native-queue", body); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "invalid native queue command" }, { status: 400 }); }
  try {
    const result = await client.command(command);
    if (result.receipt.status === "queued" || result.receipt.status === "pending") dependencies.kick();
    return NextResponse.json(result, { status: result.receipt.status === "rejected" ? 409 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "native queue admission is unavailable";
    const conflict = /idempotency|revision changed|frozen or unresolved|ownership changed/.test(message);
    return NextResponse.json({ error: message, recovery: "query or replay the original Viewer idempotency key" }, { status: conflict ? 409 : 503 });
  }
}
