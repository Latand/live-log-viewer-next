"use client";

import { useEffect, useRef, useState } from "react";

import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";

import { AccountsPanel } from "./AccountsPanel";
import { ChevronDown, Loader2 } from "./icons";
import { engineTintOf } from "./utils";

const ENGINE_LABEL: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };

/**
 * Compact per-engine account trigger in the Switchboard header (issue #40).
 * One button per engine opens the canonical {@link AccountsPanel}, sharing the
 * limits footer's direct account selection, add-account form, and sign-in
 * controls. The trigger stays mounted while account data loads or recovers, so
 * it always offers a path to Accounts. The engine name is spelled out in text
 * (tinted, never color-alone) because Claude and Codex triggers sit side by
 * side; the active account label joins it from `sm:` up, and always lives in
 * the accessible name.
 */
export function EngineAccountSwitch({ engine }: { engine: "claude" | "codex" }) {
  const state = useEngineAccounts(engine);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Outside-pointer close only; Escape is owned by the panel's dialog subtree
  // (see AccountsPanel / handleOverlayEscape) to avoid racing the Switchboard's
  // own window Escape handler.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const engineName = ENGINE_LABEL[engine];
  const tint = engineTintOf(engine);
  const activeAccount = state.accounts.find((account) => account.id === state.active);
  const label = activeAccount?.label ?? t("accounts.trigger");
  const draining = state.migration?.state === "draining";

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${t("accounts.triggerAria", { engine: engineName })} — ${label}`}
        title={`${engineName} · ${label}`}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 items-center gap-1 rounded-[7px] border border-border bg-canvas px-2 text-[11px] font-semibold hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="shrink-0 font-bold" style={{ color: tint.color }}>{engineName}</span>
        <span className="hidden max-w-32 truncate sm:inline">{label}</span>
        {draining ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" aria-hidden />
        )}
      </button>
      {open ? <AccountsPanel state={state} onClose={close} placement="header" /> : null}
    </div>
  );
}
