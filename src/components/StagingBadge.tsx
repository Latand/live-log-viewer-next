"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { useLocale } from "@/lib/i18n";

interface StagingIdentity {
  staging: boolean;
  revision: string | null;
}

/**
 * Always-visible marker of a staging instance (#659). The flag is runtime
 * state (the same image serves prod and staging), so it arrives from
 * /api/staging instead of a build-time constant. Prod instances render
 * nothing.
 */
export function StagingBadge() {
  const { t } = useLocale();
  const [identity, setIdentity] = useState<StagingIdentity | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/staging")
      .then(async (response) => (response.ok ? response.json() as Promise<StagingIdentity> : null))
      .then((payload) => { if (!cancelled && payload) setIdentity(payload); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!identity?.staging) return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-1.5 z-40 -translate-x-1/2">
      <Badge tone="warning" data-staging-badge title={t("staging.badgeTitle")} className="shadow-1 backdrop-blur">
        <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
        <span>{t("staging.badge")}</span>
        {identity.revision ? <span className="font-normal text-muted">· {identity.revision.slice(0, 7)}</span> : null}
      </Badge>
    </div>
  );
}
