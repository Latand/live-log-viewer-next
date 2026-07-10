"use client";

import { useEffect, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, FoldVertical, Loader2, Play, Square, SquareTerminal, X } from "@/components/icons";
import { Check, Plus } from "lucide-react";

import { Hint } from "@/components/Hint";
import { useComposer } from "@/hooks/useComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRuntimeReceiptsForArtifact } from "@/hooks/useRuntime";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import { getLocale, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { ComposerBar } from "./ComposerBar";
import { ImagePickerButton } from "./imageAttachments";
import { ReceiptChip } from "./runtime/ReceiptChip";
import { mintIdempotencyKey } from "./runtime/runtimeModel";

interface SentEntry {
  id: number;
  text: string;
  at: number;
  /** How the message left: into an existing pane or by booting a new window. */
  via: "pane" | "spawn";
}

const SENT_LIMIT = 8;
const SPAWN_TTL_MS = 90_000;
const PANE_TTL_MS = 10 * 60_000;
const sentKey = (path: string) => "llvSent:" + path;

function readSent(path: string): SentEntry[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(sentKey(path)) ?? "[]") as SentEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Conversations that accept a message without a live pane: root sessions
    reopen through resume; subagents relay through their root conversation. */
function canMessageWithoutPane(file: FileEntry): boolean {
  if (file.root === "claude-projects") return file.kind === "session" || file.kind === "subagent";
  return file.root === "codex-sessions";
}

const draftKey = (path: string) => "llvDraft:" + path;
const COMPOSE_EVENT = "llv-compose-draft";

/**
 * Drops text into a conversation's composer from outside (the link-arrow
 * gesture): the stored draft grows and any mounted composer for that path
 * reloads it and takes focus, so the user types their ask right where the
 * context landed. With no composer on screen the draft simply waits in
 * sessionStorage for the next mount.
 */
export function appendComposerDraft(path: string, text: string) {
  const key = draftKey(path);
  const prev = sessionStorage.getItem(key) ?? "";
  sessionStorage.setItem(key, prev.trim() ? prev.replace(/\s*$/, "") + "\n\n" + text : text);
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { path } }));
}

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString(getLocale() === "uk" ? "uk-UA" : "en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

/**
 * Chat-style composer pinned under the feed. A live pane gets the text typed
 * straight into its tmux pane; a finished resumable conversation boots a new
 * agent window in the current tmux session with the text as the first prompt.
 * Sent messages stay visible as a queue above the input until dismissed.
 */
export function TmuxComposer({ file, pollPaused = false }: { file: FileEntry; pollPaused?: boolean }) {
  const { t } = useLocale();
  /* An off-screen or far-zoom pane skips the pane-resolution poll; the last
     known target keeps the composer usable the moment it comes back. */
  const target = useTmuxTarget(file.pid, canMessageWithoutPane(file) ? file.path : undefined, !pollPaused);
  /* Column reshuffles can remount the composer mid-typing; the draft lives in
     sessionStorage so the text survives the remount. */
  const composer = useComposer({
    initialText: () => (typeof window === "undefined" ? "" : sessionStorage.getItem(draftKey(file.path)) ?? ""),
    persistText: (value) => {
      if (value) sessionStorage.setItem(draftKey(file.path), value);
      else sessionStorage.removeItem(draftKey(file.path));
    },
    submit: (overrideText) => send(overrideText),
  });
  const { text, textRef, setText, setTextState, inputRef, setStatus, busy, setBusy, voiceSending, attachments } = composer;
  const isMobile = useIsMobile();
  /* The phone folds the secondary controls (target chip, interrupt, compact,
     images) behind one toggle: mic and send stay, the row stops crowding. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  /* Two-step compact: the first click arms the button, only the second sends
     /compact — a stray click must never condense a live agent's context. */
  const [compactArmed, setCompactArmed] = useState(false);
  const [sent, setSent] = useState<SentEntry[]>([]);
  /* One idempotency key per message draft: reused verbatim on a retry (never a
     second send) and re-minted after a successful delivery. Passed to the send
     so the runtime host can round-trip it once the structured plane is on; the
     legacy /api/tmux route ignores the extra field. */
  const idempotencyKey = useRef<string>(mintIdempotencyKey());
  /* Durable receipts for this session from the runtime bus (empty while the bus
     is disabled or the session is legacy/unhosted). */
  const runtimeReceipts = useRuntimeReceiptsForArtifact(file.path);

  useEffect(() => {
    if (!compactArmed) return;
    const timer = window.setTimeout(() => setCompactArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [compactArmed]);

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => setSent(readSent(file.path)), [file.path]);

  /* A link-arrow drop appended to the stored draft; reload it and put the
     caret at the end so the ask can be typed straight away. Goes through the
     stable ref/setter pair rather than setText — the draft is already
     persisted, and the closure must not go stale between events. */
  useEffect(() => {
    const onCompose = (event: Event) => {
      if ((event as CustomEvent<{ path?: string }>).detail?.path !== file.path) return;
      const next = sessionStorage.getItem(draftKey(file.path)) ?? "";
      textRef.current = next;
      setTextState(next);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [file.path, inputRef, setTextState, textRef]);

  /* The queue drains itself: a pane message is delivered once the transcript
     grew after the send moment; a spawn prompt lands in a fresh window whose
     transcript is a different file, so it expires by time instead. A pane
     relay into a subagent that has since finished never grows its transcript
     again, so pane entries also fall back to a TTL, just a longer one than
     spawn entries since a live pane can legitimately go quiet for a while. */
  useEffect(() => {
    const prune = () =>
      setSent((prev) => {
        const next = prev.filter((entry) => {
          if (entry.via === "pane") return file.mtime * 1000 < entry.at + 2_000 && Date.now() - entry.at < PANE_TTL_MS;
          return Date.now() - entry.at < SPAWN_TTL_MS;
        });
        if (next.length !== prev.length) sessionStorage.setItem(sentKey(file.path), JSON.stringify(next));
        return next.length !== prev.length ? next : prev;
      });
    prune();
    const timer = setInterval(prune, 5_000);
    return () => clearInterval(timer);
  }, [file.mtime, file.path]);

  const resumable = canMessageWithoutPane(file);
  if (target === null && !resumable) return null;
  const spawnMode = target === null;
  const relayMode = spawnMode && file.root === "claude-projects" && file.kind === "subagent";

  const persistSent = (next: SentEntry[]) => {
    setSent(next);
    sessionStorage.setItem(sentKey(file.path), JSON.stringify(next));
  };

  const send = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    if (busy || voiceSending || (!payloadText.trim() && !attachments.images.length)) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pid: file.pid ?? undefined,
          path: file.path,
          text: payloadText,
          idempotencyKey: idempotencyKey.current,
          images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        imagePaths?: string[];
        target?: string;
        spawned?: boolean;
        outcome?: "delivered-to-live" | "resumed" | "failed";
      };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? t("common.failedSend") });
        return;
      }
      const imgCount = attachments.images.length;
      const entry: SentEntry = {
        id: Date.now(),
        text: payloadText.trim() || (imgCount ? t("composer.imagesCount", { count: imgCount }) : ""),
        at: Date.now(),
        via: json.outcome === "resumed" || json.spawned ? "spawn" : "pane",
      };
      persistSent([...sent, entry].slice(-SENT_LIMIT));
      idempotencyKey.current = mintIdempotencyKey(); // next draft is a new message
      setText("");
      attachments.clear();
      setStatus({
        kind: "ok",
        text: json.outcome === "resumed" || json.spawned
          ? t("composer.spawned", { target: json.target ?? "" })
          : json.imagePaths?.length
            ? t("composer.sentPaths", { count: json.imagePaths.length })
            : t("common.sent"),
      });
      inputRef.current?.focus();
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "interrupt", path: file.path }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? t("composer.failedInterrupt") });
        return;
      }
      setStatus({ kind: "ok", text: t("composer.escapeSent") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setInterrupting(false);
    }
  };

  /* Types /compact into the live pane; the compaction band then appears in
     the feed on its own once the transcript grows the marker. */
  const compact = async () => {
    if (compacting) return;
    setCompacting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "compact", path: file.path }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? t("composer.failedCompact") });
        return;
      }
      setStatus({ kind: "ok", text: t("composer.compactSent") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setCompacting(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send();
  };

  const modeChip = (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-full bg-chip px-1.5 py-1 font-mono text-[9.5px] font-semibold text-[#555]"
      title={relayMode ? t("composer.titleRelay") : spawnMode ? t("composer.titleSpawnResumed") : `tmux ${target}`}
    >
      {relayMode ? (
        <>
          <ArrowUpToLine className="h-3 w-3 shrink-0" aria-hidden /> {t("composer.root")}
        </>
      ) : spawnMode ? (
        <>
          <Play className="h-3 w-3 shrink-0" aria-hidden /> resume
        </>
      ) : (
        <>
          <SquareTerminal className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">{target}</span>
        </>
      )}
    </span>
  );

  const liveControls = !spawnMode ? (
    <>
      <Hint label={t("composer.interruptTitle")}>
        <button
          type="button"
          aria-label={t("composer.interruptAria")}
          disabled={interrupting}
          onClick={() => void interrupt()}
          className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
        >
          {interrupting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Square className="h-4 w-4" fill="currentColor" aria-hidden />}
        </button>
      </Hint>
      <Hint label={compactArmed ? t("composer.compactConfirmTitle") : t("composer.compactTitle")}>
        <button
          type="button"
          aria-label={compactArmed ? t("composer.compactConfirmTitle") : t("composer.compactAria")}
          disabled={compacting}
          onClick={() => {
            if (!compactArmed) {
              setCompactArmed(true);
              return;
            }
            setCompactArmed(false);
            void compact();
          }}
          className={`inline-flex shrink-0 items-center justify-center gap-1 rounded-[8px] border p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
            compactArmed
              ? "border-[#0d9488] bg-[#e3f4f0] text-[#0b7c72]"
              : "border-line bg-panel text-dim hover:border-[#0d9488]/50 hover:text-[#0b7c72]"
          }`}
        >
          {compacting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : compactArmed ? (
            <>
              <Check className="h-4 w-4" aria-hidden />
              <span className="text-[10.5px] font-bold">{t("composer.compactConfirm")}</span>
            </>
          ) : (
            <FoldVertical className="h-4 w-4" aria-hidden />
          )}
        </button>
      </Hint>
    </>
  ) : null;

  const canQuickAck = !spawnMode || relayMode;
  const quickAckDisabled = busy || voiceSending || attachments.images.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-[#fbfbfd] px-2.5 py-2"
      aria-label={spawnMode ? t("composer.spawnAria") : t("composer.sendAria", { target: target ?? "" })}
    >
      {sent.length ? (
        <div className="flex flex-col gap-0.5" aria-label={t("composer.queueAria")}>
          {sent.map((entry) => (
            <div key={entry.id} className="flex items-center justify-end gap-1.5">
              <span
                className="min-w-0 max-w-[85%] truncate rounded-[10px] rounded-br-[3px] bg-[#ecebfb] px-2 py-0.5 text-[11px] text-[#333]"
                title={entry.text}
              >
                {entry.text}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[9.5px] text-dim">
                {entry.via === "spawn" ? <Play className="h-2.5 w-2.5" aria-hidden /> : <ArrowRight className="h-2.5 w-2.5" aria-hidden />}
                {hhmm(entry.at)}
              </span>
              <button
                type="button"
                aria-label={t("composer.removeFromQueue")}
                className="inline-flex shrink-0 items-center rounded px-0.5 text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => persistSent(sent.filter((item) => item.id !== entry.id))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ComposerBar
        composer={composer}
        placeholder={relayMode ? t("composer.placeholderRelay") : spawnMode ? t("composer.placeholderSpawn") : t("composer.placeholderSend")}
        textareaAriaLabel={t("composer.textAria")}
        imageAriaLabel={t("composer.addImages")}
        sendLabelIdle={spawnMode ? t("composer.launchAgent") : t("composer.sendToAgent")}
        sendLabelRecording={t("composer.stopAndSend")}
        sendTitleRecording={t("composer.stopAndSendTitle")}
        sendIdleClassName="border-accent bg-accent hover:opacity-90"
        sendMenuLabel={t("composer.sendMenuTitle")}
        sendMenuActions={
          canQuickAck
            ? [
                {
                  id: "quick-ack",
                  label: t("composer.quickAckLabel"),
                  description: t("composer.quickAck"),
                  disabled: quickAckDisabled,
                  tone: "ok",
                  onSelect: () => void send(t("composer.quickAck")),
                },
              ]
            : []
        }
        showImage={!isMobile}
        receipts={
          runtimeReceipts.length
            ? runtimeReceipts.map((receipt) => <ReceiptChip key={receipt.operationId} receipt={receipt} />)
            : undefined
        }
        leftSlot={
          isMobile ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                aria-expanded={toolsOpen}
                aria-label={t("composer.moreTools")}
                title={t("composer.moreTools")}
                onClick={() => setToolsOpen((value) => !value)}
                className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Plus className={`h-4 w-4 transition-transform ${toolsOpen ? "rotate-45" : ""}`} aria-hidden />
              </button>
              {toolsOpen ? (
                <>
                  {modeChip}
                  {liveControls}
                  <ImagePickerButton
                    ariaLabel={t("composer.addImages")}
                    className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    onFiles={attachments.addFiles}
                  />
                </>
              ) : null}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              {modeChip}
              {liveControls}
            </div>
          )
        }
      />
    </form>
  );
}
