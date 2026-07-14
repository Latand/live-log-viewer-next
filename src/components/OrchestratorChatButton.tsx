"use client";

import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

import { openOrchestratorConversation, orchestratorHash } from "./orchestratorChat";

type Phase = "idle" | "busy" | "error";

/** Board-header entry to the built-in Orchestrator (issue #182): resolves the
    persistent orchestrator conversation (spawning it on first use) and
    navigates to its `#c=` deep link, which the Viewer resolves and opens. */
export function OrchestratorChatButton() {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [phase, setPhase] = useState<Phase>("idle");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* Ref-level re-entrancy guard: a double click lands before the busy render
     commits, and two concurrent resolves could spawn two orchestrators. */
  const busyRef = useRef(false);
  const open = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("busy");
    try {
      const conversationId = await openOrchestratorConversation();
      window.location.hash = orchestratorHash(conversationId);
      if (mountedRef.current) setPhase("idle");
    } catch {
      if (mountedRef.current) setPhase("error");
    } finally {
      busyRef.current = false;
    }
  };

  const label = phase === "busy" ? t("orch.starting") : phase === "error" ? t("orch.error") : t("orch.chat");
  return (
    <button
      type="button"
      disabled={phase === "busy"}
      aria-label={t("orch.open")}
      title={phase === "error" ? t("orch.error") : t("orch.open")}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
        phase === "error"
          ? "border-warning/45 bg-warning-soft text-warning hover:bg-warning/15"
          : "border-accent/40 bg-accent-soft text-accent hover:bg-accent/15"
      } ${isMobile ? "min-h-11" : "py-1"}`}
      onClick={open}
    >
      <Bot className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}
