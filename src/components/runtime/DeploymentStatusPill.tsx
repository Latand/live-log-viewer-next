"use client";

import { useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useRuntime } from "@/hooks/useRuntime";
import type { RuntimeSnapshot, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

export function DeploymentStatusPill() {
  const { enabled, store } = useRuntime();
  const isMobile = useIsMobile();
  const [snapshotDeployments, setSnapshotDeployments] = useState<ViewerDeploymentStatus[]>([]);
  useEffect(() => {
    if (enabled) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/runtime/snapshot", { headers: { accept: "application/json" } });
        if (!response.ok) return;
        const snapshot = await response.json() as RuntimeSnapshot;
        if (active) setSnapshotDeployments(snapshot.deployments);
      } catch { /* runtime host may be disabled */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled]);
  const deployments = enabled ? Object.values(store.deployments) : snapshotDeployments;
  const deployment = [...deployments].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  /* Reserved space, phone only (finding 4): while the pill is live it publishes
     a bottom inset that the board's docked sections (collapsed workers / quiet
     conversations) pad against, so the toast sits in its own strip below them and
     never overlaps their rows — not merely tap-through. Cleared when it hides. */
  const hasReservation = isMobile && Boolean(deployment);
  useEffect(() => {
    if (!hasReservation) return;
    const root = document.documentElement;
    root.style.setProperty("--llv-deploy-inset", "calc(2.75rem + env(safe-area-inset-bottom))");
    return () => {
      root.style.removeProperty("--llv-deploy-inset");
    };
  }, [hasReservation]);
  if (!deployment) return null;
  const label = deployment.phase.replaceAll("-", " ");
  const tone = deployment.phase === "succeeded"
    ? "border-ok/45 text-ok"
    : deployment.phase === "failed" || deployment.phase === "rolled-back"
      ? "border-[#d06b5d]/45 text-[#a33d31]"
      : "border-accent/45 text-accent";
  return (
    /* Purely informational — never a hit-target. On the phone the board reserves
       `--llv-deploy-inset` below its docked sections so this strip has its own
       room; `pointer-events-none` is a belt-and-braces guard, and the safe-area
       inset lifts it clear of the home bar. */
    <div
      className={`pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-40 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 truncate rounded-full border bg-panel/95 px-3 py-1 text-[11px] font-semibold shadow-card backdrop-blur ${tone}`}
      role="status"
      title={deployment.error ?? `Revision ${deployment.revision.slice(0, 12)}`}
    >
      Viewer deploy · {label} · {deployment.revision.slice(0, 7)}
    </div>
  );
}
