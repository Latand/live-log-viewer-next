import { TriangleAlert } from "lucide-react";

import type { TmuxEndpointHealth } from "@/lib/tmux";

export function SupervisorHealthAlert({ health }: { health: TmuxEndpointHealth }) {
  if (health.status === "healthy") return null;
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-3 z-50 flex max-w-[min(92vw,760px)] -translate-x-1/2 items-start gap-2 rounded-xl border border-[#e0ae45]/60 bg-[#fff7df] px-3 py-2 text-xs font-semibold text-[#74520b] shadow-card"
      data-system-health="tmux-degraded"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{health.message} Expected endpoint: <code>{health.expectedTmpdir}</code>.</span>
    </div>
  );
}
