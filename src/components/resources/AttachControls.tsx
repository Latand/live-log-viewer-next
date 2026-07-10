"use client";

import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { Check, Eye, Loader2, RotateCw, Terminal } from "../icons";
import {
  type AttachKind,
  type AttachStatus,
  copiedKey,
  isRecoverable,
  performAttachCopy,
  reasonKey,
} from "./attach";

/** How long the checkmark confirmation lingers — matches CopyButton. */
const COPIED_MS = 1_400;

function AttachButton({
  kind,
  label,
  hint,
  status,
  disabled,
  onCopy,
}: {
  kind: AttachKind;
  label: string;
  hint: string;
  status: AttachStatus | null;
  disabled: boolean;
  onCopy: (kind: AttachKind) => void;
}) {
  const mine = status?.kind === kind ? status : null;
  const loading = mine?.phase === "loading";
  const copied = mine?.phase === "copied";
  const Icon = kind === "readonly" ? Eye : Terminal;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={hint}
      onClick={() => onCopy(kind)}
      className={[
        "inline-flex min-h-[44px] items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] font-semibold sm:min-h-0 sm:py-1",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-wait disabled:opacity-50",
        copied ? "border-ok/50 text-ok" : "border-line text-dim hover:bg-bg hover:text-accent",
      ].join(" ")}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : copied ? (
        <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
      ) : (
        <Icon className="h-3.5 w-3.5" aria-hidden />
      )}
      <span>{label}</span>
    </button>
  );
}

/** Stateless render of the attach cluster — two copy buttons plus the inline
    status/recovery line. Split out from the stateful {@link AttachControls} so
    every visual state renders deterministically from props (no timers, no
    fetch) in tests. */
export function AttachControlsView({
  status,
  onCopy,
  onRefresh,
}: {
  status: AttachStatus | null;
  onCopy: (kind: AttachKind) => void;
  onRefresh: () => void;
}) {
  const { t } = useLocale();
  const busy = status?.phase === "loading";
  const error = status?.phase === "error" ? status : null;
  const copied = status?.phase === "copied" ? status : null;
  const recoverable = error !== null && isRecoverable(error.reason);
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <AttachButton
          kind="attach"
          label={t("attach.attach")}
          hint={t("attach.hint")}
          status={status}
          disabled={busy}
          onCopy={onCopy}
        />
        <AttachButton
          kind="readonly"
          label={t("attach.readonly")}
          hint={t("attach.readonlyHint")}
          status={status}
          disabled={busy}
          onCopy={onCopy}
        />
        {busy ? (
          <span role="status" className="text-[10.5px] text-dim">
            {t("attach.loading")}
          </span>
        ) : null}
        {copied ? (
          <span role="status" className="text-[10.5px] font-semibold text-ok">
            {t(copiedKey(copied.kind))}
          </span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" aria-live="assertive" className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-err">
          <span className="min-w-0">{t(reasonKey(error.reason))}</span>
          {recoverable ? (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-[8px] border border-err/40 px-2 font-semibold text-err hover:bg-err/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/40 sm:min-h-0 sm:py-0.5"
            >
              <RotateCw className="h-3 w-3" aria-hidden />
              {t("attach.refresh")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Per-row Attach / Read-only copy actions for a resource pane. The command is
    resolved at click time against the same-origin `?attach=1` route keyed by
    the row's stable `target`, then copied — nothing is cached, so a copy always
    reflects the pane's current display coordinate and endpoint. A refresh on a
    stale/restarted failure re-polls the snapshot through the panel's own
    loader. */
export function AttachControls({ target, onRefresh }: { target: string; onRefresh: () => void }) {
  const [status, setStatus] = useState<AttachStatus | null>(null);
  const alive = useRef(true);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  const copy = (kind: AttachKind) => {
    /* Ignore a second click while a resolve is in flight — one round-trip at a
       time keeps the confirmation honest and avoids racing clipboard writes. */
    if (status?.phase === "loading") return;
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    setStatus({ phase: "loading", kind });
    void performAttachCopy(target, kind).then((result) => {
      if (!alive.current) return;
      if (result.ok) {
        setStatus({ phase: "copied", kind });
        copiedTimer.current = window.setTimeout(() => {
          if (alive.current) setStatus(null);
        }, COPIED_MS);
      } else {
        setStatus({ phase: "error", kind, reason: result.reason });
      }
    });
  };

  const refresh = () => {
    setStatus(null);
    void onRefresh();
  };

  return <AttachControlsView status={status} onCopy={copy} onRefresh={refresh} />;
}
