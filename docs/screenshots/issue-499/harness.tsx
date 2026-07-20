/**
 * Acceptance harness for issue #499 — mobile structured composer: reliable
 * Send + one obvious model/reasoning pill.
 *
 * Unlike the static #390 harness, this mounts the REAL `TmuxComposer` against
 * a scripted wire: the runtime bus is enabled and fed a production-shaped
 * `/api/runtime/snapshot` carrying one hosted codex-app-server session for a
 * Viewer-launched conversation (`spawnOrigin: "viewer"`), and `/api/runtime/send`
 * answers with the delivered receipt echoing the per-turn `runtime` settings —
 * exactly the journal echo shipped with this issue. Interactions (open the
 * pill, type, submit) run as real DOM events inside the page, so the captured
 * states are the product of the production components, hooks, and capability
 * matrix, not a reconstruction.
 *
 *   ?view=rest|sheet|popover|typed|blocked|dead|images|receipt&lang=en|uk&theme=light|dark
 *
 * `dead` mirrors the BranchPane composition for a dead structured host (the
 * recovery banner above the composer, Send still admitting durably); `images`
 * pastes a synthetic 1×1 PNG through the collapsed fold to prove the mobile
 * intake path and the bounded tray.
 *
 * Every interactive view appends its observations (send bodies, receipts) to
 * the hidden `#verify-log` JSON node; capture.sh re-runs the page with
 * --dump-dom and asserts on that log, so the screenshots and the behavioral
 * checks come from one execution path. All data is synthetic and
 * publication-safe.
 */
import { createRoot } from "react-dom/client";

import { DeadHostBanner } from "@/components/runtime/DeadHostBanner";
import { TmuxComposer } from "@/components/TmuxComposer";
import { setLocale, translate, type Locale, type MessageKey } from "@/lib/i18n";
import type { RuntimeSendSettings } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "rest";
const lang = (params.get("lang") ?? "en") as Locale;
const theme = params.get("theme") ?? "light";

document.documentElement.dataset.theme = theme;
setLocale(lang);
const t = (key: MessageKey, values?: Record<string, string | number>) => translate(lang, key, values);

/* A fresh capture must not inherit a previous run's persisted state
   (file:// shares one localStorage across every harness page). */
localStorage.clear();
sessionStorage.clear();
localStorage.setItem("llv_runtime_ui", "1");

const CONVERSATION_ID = "conversation_viewer499accept";

/* The Viewer-launched conversation card: spawn lineage marker + conversation
   identity exactly as the scanner projects a structured launch once its
   transcript is adopted. Synthetic, publication-safe values throughout. */
const viewerFile: FileEntry = {
  path: "/codex-viewer-499.jsonl",
  root: "codex-sessions",
  name: "codex-viewer-499.jsonl",
  project: "viewer",
  title: "Viewer-launched conversation",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: Math.floor(Date.now() / 1000) - 300,
  size: 1,
  activity: "live",
  proc: "running",
  pid: null,
  conversationId: CONVERSATION_ID,
  spawnOrigin: "viewer",
  model: "gpt-5.6-sol",
  effort: "high",
  fast: false,
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

/* A prior pill selection for the send/receipt views: the structured commit
   persists both the concrete draft (the pill face) and the sparse profile
   (what `sendRuntimeFrom` rides on the next message). */
const SELECTED: RuntimeSendSettings = { model: "gpt-5.6-sol", effort: "xhigh", fast: true };
if (view === "typed" || view === "receipt") {
  localStorage.setItem(`llvAgentRuntime:${CONVERSATION_ID}`, JSON.stringify({ model: SELECTED.model, effort: SELECTED.effort, fast: SELECTED.fast }));
  localStorage.setItem(`llvAgentRuntime:${CONVERSATION_ID}:profile`, JSON.stringify(SELECTED));
}

/* ------------------------------------------------------------------ *
 * Scripted wire                                                       *
 * ------------------------------------------------------------------ */

const verifyLog: Record<string, unknown>[] = [];
function logVerify(entry: Record<string, unknown>): void {
  verifyLog.push(entry);
  let node = document.getElementById("verify-log");
  if (!node) {
    node = document.createElement("script");
    node.id = "verify-log";
    (node as HTMLScriptElement).type = "application/json";
    document.body.append(node);
  }
  node.textContent = JSON.stringify(verifyLog);
}

const runtimeSession = {
  conversationId: CONVERSATION_ID,
  sessionKey: { engine: "codex", sessionId: "codex-thread-499" },
  hostKind: "codex-app-server",
  host: view === "dead" ? "dead" : "hosted",
  turn: "idle",
  provenance: "structured",
  revision: 4,
  attentionIds: [],
  recentReceipts: [],
  accountId: null,
  parentConversationId: null,
  flowId: null,
  workflowId: null,
  cwd: "/home/user/projects/viewer",
  artifactPath: viewerFile.path,
  capabilities: {
    steer: true,
    structuredAttention: true,
    imageInput: { supported: true },
    runtimeSettings: { perTurnEffort: true, perTurnModel: false },
  },
  activeTurnId: null,
};

const snapshot = {
  schemaVersion: 1,
  snapshotSeq: 42,
  retentionFloorSeq: 0,
  serverTime: new Date().toISOString(),
  runtime: { hostEpoch: 1, health: "ok" },
  filesRevision: 7,
  structuredHostsEnabled: true,
  sessions: view === "blocked" ? [] : [runtimeSession],
  attentions: [],
  recentOperations: [],
  edges: [],
  flows: [],
  workflows: [],
  tasks: [],
  deployments: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as Response;
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/runtime/snapshot")) return jsonResponse(200, snapshot);
  if (url === "/api/tmux/targets") return jsonResponse(200, { targets: {} });
  if (url === "/api/runtime/send") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { idempotencyKey: string; text: string; runtime?: RuntimeSendSettings };
    /* Mirrors the runtime-host journal echo (issue #499): the delivered send
       receipt carries the per-turn settings snapshot it was admitted with. */
    const receipt = {
      operationId: `op_${body.idempotencyKey}`,
      idempotencyKey: body.idempotencyKey,
      conversationId: CONVERSATION_ID,
      kind: "send",
      status: "delivered",
      text: body.text,
      imageCount: 0,
      ...(body.runtime ? { runtime: body.runtime } : {}),
      at: new Date().toISOString(),
      revision: 1,
    };
    logVerify({ kind: "send-request", runtime: body.runtime ?? null, text: body.text });
    logVerify({ kind: "send-receipt", receipt });
    return jsonResponse(200, { operationId: receipt.operationId, receipt });
  }
  if (url === "/api/tmux") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    logVerify({ kind: "tmux-request", action: body.action ?? null });
    return jsonResponse(200, { ok: true, outcome: "pending", operationId: "op_reconfigure_499" });
  }
  logVerify({ kind: "unexpected-request", url });
  return jsonResponse(404, { error: `unexpected request: ${url}` });
}) as typeof fetch;

/* The SSE stream stays silently open: the snapshot alone drives these states. */
class QuietEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  addEventListener(): void {}
  close(): void {}
}
(window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;

/* ------------------------------------------------------------------ *
 * Shell + drivers                                                     *
 * ------------------------------------------------------------------ */

function Shell() {
  return (
    <div className="flex flex-col rounded-surface border border-border bg-card" style={{ margin: "auto auto 16px", width: "100%", maxWidth: 720 }}>
      <div className="border-b border-border p-3 text-ui text-muted" style={{ minHeight: 96 }}>
        …transcript…
      </div>
      {/* BranchPane composition for a dead structured host: the banner owns
          recovery while the composer's durable admission stays available. */}
      {view === "dead" ? <DeadHostBanner file={viewerFile} /> : null}
      <TmuxComposer
        file={viewerFile}
        {...(view === "dead" ? { deadHost: true } : {})}
        {...(view === "blocked" ? { sendBlockedReason: t("strip.resolving") } : {})}
      />
    </div>
  );
}

const mount = document.getElementById("root")!;
mount.style.display = "flex";
mount.style.minHeight = "100dvh";
mount.style.padding = "12px";
createRoot(mount).render(<Shell />);

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitFor<T>(read: () => T | null, label: string, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  logVerify({ kind: "driver-timeout", label });
  throw new Error(`harness driver timed out waiting for ${label}`);
}

async function drive(): Promise<void> {
  if (view === "rest") {
    const pill = await waitFor(() => document.querySelector("[data-runtime-pill]"), "runtime pill");
    logVerify({ kind: "state", view, pillVisible: Boolean(pill) });
    return;
  }
  if (view === "blocked") {
    const blocked = await waitFor(() => document.querySelector('[data-testid="composer-send-blocked"]'), "inline blocked reason");
    const recover = blocked.querySelector("button");
    logVerify({ kind: "state", view, blockedInline: true, recoverAction: Boolean(recover), reason: blocked.textContent?.trim() ?? "" });
    return;
  }
  if (view === "dead") {
    /* The banner owns recovery; the composer stays live for durable text
       admission (structured recovery), so the operator is never stranded. */
    const banner = await waitFor(() => document.querySelector("[data-dead-host-banner]"), "dead-host banner");
    const send = await waitFor(
      () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.sendToAgent")}"]`),
      "send button",
    );
    const textarea = await waitFor(() => document.querySelector("textarea"), "composer textarea");
    typeInto(textarea, "Recover and continue this task.");
    logVerify({
      kind: "state",
      view,
      bannerVisible: Boolean(banner),
      recoveryActions: banner.querySelectorAll("button").length,
      sendAriaDisabled: send.getAttribute("aria-disabled"),
    });
    return;
  }
  if (view === "images") {
    const textarea = await waitFor(() => document.querySelector("textarea"), "composer textarea");
    /* Paste a synthetic 1×1 PNG through the collapsed fold — the mobile image
       intake that must work with the picker undisclosed. Publication-safe
       generated bytes, no real capture. */
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], "synthetic-pixel.png", { type: "image/png" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    const tile = await waitFor(
      () => document.querySelector('[data-testid="attachment-tile"][data-status="ready"]'),
      "ready attachment tile",
    );
    const send = await waitFor(
      () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.sendToAgent")}"]`),
      "send button",
    );
    logVerify({ kind: "state", view, tileReady: Boolean(tile), sendAriaDisabled: send.getAttribute("aria-disabled") });
    return;
  }
  if (view === "sheet" || view === "popover") {
    const pill = await waitFor(() => document.querySelector<HTMLButtonElement>("[data-runtime-pill]"), "runtime pill");
    pill.click();
    const surface = await waitFor(
      () => document.querySelector(view === "sheet" ? "[data-runtime-sheet]" : "[data-runtime-popover]"),
      `${view} surface`,
    );
    logVerify({ kind: "state", view, pickerOpen: Boolean(surface) });
    return;
  }
  if (view === "typed" || view === "receipt") {
    const textarea = await waitFor(() => document.querySelector("textarea"), "composer textarea");
    const send = await waitFor(
      () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.sendToAgent")}"]`),
      "send button",
    );
    logVerify({ kind: "state", view, phase: "before-typing", sendAriaDisabled: send.getAttribute("aria-disabled") });
    typeInto(textarea, "Verify the pill selection rides this message.");
    /* One frame: a discrete input event flushes synchronously in React, so the
       enabled Send is observable immediately after the dispatch returns —
       nothing async sits between the keystroke and the button. */
    logVerify({ kind: "state", view, phase: "after-typing", sendAriaDisabled: send.getAttribute("aria-disabled") });
    const pill = document.querySelector("[data-runtime-pill]");
    logVerify({
      kind: "state",
      view,
      phase: "pill-face",
      face: pill?.getAttribute("aria-label") ?? null,
      storedDraft: localStorage.getItem(`llvAgentRuntime:${CONVERSATION_ID}`),
      storedProfile: localStorage.getItem(`llvAgentRuntime:${CONVERSATION_ID}:profile`),
    });
    if (view === "typed") return;
    textarea.closest("form")!.requestSubmit();
    await waitFor(() => document.querySelector("[data-delivery-echo]"), "delivered echo row");
    logVerify({ kind: "state", view, phase: "delivered", echoVisible: true });
    return;
  }
  logVerify({ kind: "state", view, error: "unknown view" });
}

void drive().catch(() => {});
