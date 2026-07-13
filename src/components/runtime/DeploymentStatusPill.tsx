"use client";

import { useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useRuntime } from "@/hooks/useRuntime";
import type { RuntimeSnapshot, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

/* The viewer-deploy status is internal operator info, not app UI (issue #177
   item 6): it is removed from the interface by default and never shown on the
   phone. Set `NEXT_PUBLIC_LLV_SHOW_DEPLOY_PILL=1` to surface it on desktop for
   deploy debugging. */
function deployPillEnabled(): boolean {
  return (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_LLV_SHOW_DEPLOY_PILL : undefined) === "1";
}

export function DeploymentStatusPill() {
  const { enabled, store } = useRuntime();
  const isMobile = useIsMobile();
  const show = !isMobile && deployPillEnabled();
  const [snapshotDeployments, setSnapshotDeployments] = useState<ViewerDeploymentStatus[]>([]);
  useEffect(() => {
    if (enabled || !show) return;
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
  }, [enabled, show]);
  const deployments = enabled ? Object.values(store.deployments) : snapshotDeployments;
  const deployment = [...deployments].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!show || !deployment) return null;
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
