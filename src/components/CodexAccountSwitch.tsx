"use client";

import { useEffect, useRef, useState } from "react";

import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";

import { AccountsPanel } from "./AccountsPanel";
import { ChevronDown, Loader2 } from "./icons";

/**
 * Compact Codex account trigger in the Switchboard header. One button opens the
 * canonical {@link AccountsPanel} — the exact preview → confirm → migrate surface
 * the limits footer uses — so the two never diverge and there is no second,
 * bare-switch semantics (issue #40). The trigger stays mounted while account data
 * loads or recovers, so it always offers a path to Accounts.
 */
export function CodexAccountSwitch() {
  const state = useEngineAccounts("codex");
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
        aria-label={t("accounts.triggerAria", { engine: "Codex" })}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 items-center gap-1 rounded-[7px] border border-line bg-bg px-2 text-[11px] font-semibold hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="max-w-36 truncate">{label}</span>
        {draining ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-dim" aria-hidden />
        )}
      </button>
      {open ? <AccountsPanel state={state} onClose={close} placement="header" /> : null}
    </div>
  );
}
