import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import {
  buildImagePayload,
  collectImagePayloads,
  deleteInboxImages,
  forgetResumePane,
  killPane,
  knownLivePids,
  liveResumePane,
  resolveTarget,
  resumeSpecFor,
  sendInterrupt,
  sendText,
  sendToResumedAgent,
} from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TargetResponse {
  target: string | null;
}

interface SendResponse {
  ok: true;
  target: string;
  imagePaths?: string[];
  /** Set when the message booted a fresh agent window instead of an existing pane. */
  spawned?: boolean;
}

interface InterruptResponse {
  ok: true;
  target: string;
}

/** Resolves and revalidates a request pid against the scanner's live set. */
async function targetForKnownPid(pid: number): Promise<string | null | "unknown"> {
  const live = await knownLivePids();
  if (!live.has(pid)) return "unknown";
  return resolveTarget(pid);
}

/**
 * Live pane of a conversation, for an interrupt or a kill. The pid comes from
 * the scanner's own entry for the path — a client-supplied pid is ignored
 * (like /api/proc), since resolving it directly would let any same-origin
 * caller reach an unrelated agent's pane. Never boots a fresh agent window:
 * both actions only make sense against a pane that already exists.
 */
async function livePaneTarget(filePath: string): Promise<string | null> {
  const entry = (await listFiles()).find((item) => item.path === filePath);
  if (entry && entry.pid !== null) {
    const target = await resolveTarget(entry.pid);
    if (target !== null) return target;
  }
  const pane = await liveResumePane(filePath);
  return pane ? pane.display : null;
}

export async function GET(req: NextRequest): Promise<NextResponse<TargetResponse | ApiError>> {
  const pidRaw = req.nextUrl.searchParams.get("pid");
  const filePath = req.nextUrl.searchParams.get("path") ?? "";
  const pid = Number(pidRaw);
  const hasPid = Number.isInteger(pid) && pid > 0;
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "потрібен pid або path" }, { status: 400 });
  }
  if (hasPid) {
    const target = await targetForKnownPid(pid);
    if (target !== "unknown" && target !== null) return NextResponse.json({ target });
  }
  /* A finished conversation has no pid, but its resume window may still run. */
  if (filePath && pathAllowed(filePath)) {
    const pane = await liveResumePane(filePath);
    if (pane) return NextResponse.json({ target: pane.display });
  }
  return NextResponse.json({ target: null });
}

export async function POST(req: NextRequest): Promise<NextResponse<SendResponse | InterruptResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { pid?: unknown; path?: unknown; text?: unknown; image?: unknown; images?: unknown; action?: unknown };
  try {
    body = (await req.json()) as {
      pid?: unknown;
      path?: unknown;
      text?: unknown;
      image?: unknown;
      images?: unknown;
      action?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const pid = Number(body.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;
  const filePath = typeof body.path === "string" ? body.path : "";
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "потрібен pid або path" }, { status: 400 });
  }

  if (body.action === "interrupt") {
    if (!filePath || !pathAllowed(filePath)) {
      return NextResponse.json({ error: "для переривання потрібен path розмови" }, { status: 400 });
    }
    const target = await livePaneTarget(filePath);
    if (target === null) {
      return NextResponse.json({ error: "немає активного пейна агента для переривання" }, { status: 409 });
    }
    try {
      await sendInterrupt(target);
      return NextResponse.json({ ok: true, target });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  if (body.action === "resume") {
    if (!filePath || !pathAllowed(filePath)) {
      return NextResponse.json({ error: "для відкриття потрібен path розмови" }, { status: 400 });
    }
    const entry = (await listFiles()).find((item) => item.path === filePath);
    if (!entry) return NextResponse.json({ error: "файл невідомий переглядачу" }, { status: 403 });
    const spec = resumeSpecFor(entry.root, entry.path);
    if (!spec) return NextResponse.json({ error: "цю розмову неможливо відновити" }, { status: 409 });
    try {
      const sent = await sendToResumedAgent(entry.path, spec, "");
      return NextResponse.json({ ok: true, target: sent.target, spawned: sent.spawned });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  /* Closing a chat card also puts out its tmux pane. A missing pane is fine —
     the conversation may have never had one or it died already; the close is
     then a pure UI removal and still succeeds. */
  if (body.action === "kill") {
    if (!filePath || !pathAllowed(filePath)) {
      return NextResponse.json({ error: "для закриття потрібен path розмови" }, { status: 400 });
    }
    const entry = (await listFiles()).find((item) => item.path === filePath);
    /* A branch column shares the root conversation's pane: killing it from a
       branch close would take the whole agent down along with the root card
       that is still on screen. Only a root conversation may kill a pane. */
    if (entry && entry.parent) {
      return NextResponse.json({ ok: true, target: "" });
    }
    const target = await livePaneTarget(filePath);
    if (target === null) {
      return NextResponse.json({ ok: true, target: "" });
    }
    try {
      await killPane(target);
      forgetResumePane(filePath);
      return NextResponse.json({ ok: true, target });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  const text = typeof body.text === "string" ? body.text : "";
  const { images, error: imageError } = collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }
  if (!text.trim() && !images.length) {
    return NextResponse.json({ error: "порожнє повідомлення" }, { status: 400 });
  }

  let target: string | null = null;
  if (hasPid) {
    const resolved = await targetForKnownPid(pid);
    if (resolved === "unknown" && !filePath) {
      return NextResponse.json({ error: "процес невідомий переглядачу" }, { status: 403 });
    }
    target = resolved === "unknown" ? null : resolved;
  }

  /* Saved paths stay visible to the catch-all: a delivery that fails after
     the images hit disk deletes them so a retry cannot duplicate files. */
  let imagePaths: string[] = [];
  try {
    /* Images are only saved to the inbox once a deliverable destination is
       confirmed below — every early 409/403 return above and below happens
       before any file touches disk, so a rejected request never orphans one. */
    if (target !== null) {
      const bundle = buildImagePayload(text.trim(), images);
      imagePaths = bundle.imagePaths;
      await sendText(target, bundle.payload);
      return NextResponse.json({ ok: true, target, ...(imagePaths.length ? { imagePaths } : {}) });
    }

    /* No live pane: reopen the conversation as a fresh agent window in the
       user's current tmux session and type the prompt there. */
    if (!filePath || !pathAllowed(filePath)) {
      return NextResponse.json({ error: "процес не у tmux-сесії" }, { status: 409 });
    }
    const all = await listFiles();
    const entry = all.find((item) => item.path === filePath);
    if (!entry) {
      return NextResponse.json({ error: "файл невідомий переглядачу" }, { status: 403 });
    }
    const spec = resumeSpecFor(entry.root, entry.path);
    if (spec) {
      const bundle = buildImagePayload(text.trim(), images);
      imagePaths = bundle.imagePaths;
      const sent = await sendToResumedAgent(entry.path, spec, bundle.payload);
      return NextResponse.json({ ok: true, target: sent.target, spawned: sent.spawned, ...(imagePaths.length ? { imagePaths } : {}) });
    }

    /* Subagents and other child records have no resumable session of their
       own: the message relays through the root conversation — into its live
       pane when it runs, through a resume window otherwise. */
    const byPath = new Map(all.map((item) => [item.path, item]));
    const seen = new Set<string>();
    let root = entry;
    while (root.parent && byPath.has(root.parent) && !seen.has(root.path)) {
      seen.add(root.path);
      root = byPath.get(root.parent)!;
    }
    if (root.path === entry.path) {
      return NextResponse.json({ error: "цю розмову неможливо відновити" }, { status: 409 });
    }
    /* Resolved before saving anything: the root's live pane or resume spec
       must exist, or the request is rejected without ever writing an image. */
    const rootTarget = root.pid !== null ? await resolveTarget(root.pid) : null;
    const rootSpec = rootTarget === null ? resumeSpecFor(root.root, root.path) : null;
    if (rootTarget === null && !rootSpec) {
      return NextResponse.json({ error: "коренева сесія недоступна для повідомлення" }, { status: 409 });
    }
    const bundle = buildImagePayload(text.trim(), images);
    imagePaths = bundle.imagePaths;
    const relayText = `Повідомлення від користувача для твоєї гілки «${entry.title.slice(0, 100)}» — передай або обробʼи сам:\n${bundle.payload}`;
    const imageField = imagePaths.length ? { imagePaths } : {};
    if (rootTarget !== null) {
      await sendText(rootTarget, relayText);
      return NextResponse.json({ ok: true, target: rootTarget, ...imageField });
    }
    const sent = await sendToResumedAgent(root.path, rootSpec!, relayText);
    return NextResponse.json({ ok: true, target: sent.target, spawned: sent.spawned, ...imageField });
  } catch (error) {
    deleteInboxImages(imagePaths);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
