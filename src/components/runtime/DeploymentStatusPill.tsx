"use client";

import { useEffect, useState } from "react";

import { useRuntime } from "@/hooks/useRuntime";
import type { RuntimeSnapshot, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

export function DeploymentStatusPill() {
  const { enabled, store } = useRuntime();
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
  if (!deployment) return null;
  const label = deployment.phase.replaceAll("-", " ");
  const tone = deployment.phase === "succeeded"
    ? "border-ok/45 text-ok"
    : deployment.phase === "failed" || deployment.phase === "rolled-back"
      ? "border-[#d06b5d]/45 text-[#a33d31]"
      : "border-accent/45 text-accent";
  return (
    <div
      className={`fixed bottom-3 left-1/2 z-40 -translate-x-1/2 rounded-full border bg-panel/95 px-3 py-1 text-[11px] font-semibold shadow-card backdrop-blur ${tone}`}
      role="status"
      title={deployment.error ?? `Revision ${deployment.revision.slice(0, 12)}`}
    >
      Viewer deploy · {label} · {deployment.revision.slice(0, 7)}
    </div>
  );
}
