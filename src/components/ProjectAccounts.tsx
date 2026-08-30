"use client";

import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";

/** One engine's block of the project view served by /api/account-project-bindings. */
export interface ProjectAccountsEngineView {
  engine: "claude" | "codex";
  restricted: boolean;
  allowed: { accountId: string; label: string }[];
  carrying: { accountId: string; label: string }[];
}

export interface ProjectAccountsView {
  project: string;
  engines: ProjectAccountsEngineView[];
}

/** Crash-safe read of the route's project view; anything malformed renders nothing. */
export function parseProjectAccountsView(body: unknown): ProjectAccountsView | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.project !== "string" || !record.project) return null;
  const engines = record.engines;
  if (!engines || typeof engines !== "object") return null;
  const parsed = (["claude", "codex"] as const).flatMap((engine) => {
    const block = (engines as Record<string, unknown>)[engine];
    if (!block || typeof block !== "object") return [];
    const view = block as Record<string, unknown>;
    const accounts = (value: unknown) => Array.isArray(value)
      ? value.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          return typeof entry.accountId === "string" && entry.accountId
            ? [{ accountId: entry.accountId, label: typeof entry.label === "string" && entry.label ? entry.label : entry.accountId }]
            : [];
        })
      : [];
    return [{
      engine,
      restricted: view.restricted === true,
      allowed: accounts(view.allowed),
      carrying: accounts(view.carrying),
    }];
  });
  return { project: record.project, engines: parsed };
}

/**
 * The project side of #1279's relation: which accounts this project may use,
 * and which of them are carrying its work right now.
 *
 * It stays silent for a project that is neither fenced nor busy — the common
 * case, and one where a permanent "any account" chip in the header would be
 * noise. A restricted project always renders, because there the fence is
 * exactly what a reader needs in order to understand a parked stage.
 */
export function ProjectAccounts({ project }: { project: string }) {
  const [view, setView] = useState<ProjectAccountsView | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    void (async () => {
      try {
        const response = await fetch(`/api/account-project-bindings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
        if (!response.ok) return;
        const parsed = parseProjectAccountsView(await response.json());
        if (live && parsed && parsed.project === project) setView(parsed);
      } catch {
        // A failed read leaves the strip absent rather than guessing at a fence.
      }
    })();
    return () => { live = false; };
  }, [project]);

  return <ProjectAccountsStrip view={view} />;
}

/** The rendering half, separated so it can be exercised without a fetch. */
export function ProjectAccountsStrip({ view }: { view: ProjectAccountsView | null }) {
  const { t } = useLocale();
  const shown = (view?.engines ?? []).filter((engine) => engine.restricted || engine.carrying.length > 0);
  if (!view || !shown.length) return null;
  const project = view.project;
  return (
    <div data-project-accounts={project} className="flex min-w-0 flex-wrap items-center gap-1 text-[10px]">
      <span className="font-semibold text-muted">{t("projectAccounts.label")}</span>
      {shown.map((engine) => {
        const carrying = new Set(engine.carrying.map((account) => account.accountId));
        /* A carrier outside the allowed set is still shown, and still marked as
           carrying: it is a session that started before the binding existed,
           and hiding it would make the fence look retroactive. */
        const rows = [
          ...engine.allowed,
          ...engine.carrying.filter((account) => !engine.allowed.some((item) => item.accountId === account.accountId)),
        ];
        return (
          <span key={engine.engine} className="flex min-w-0 items-center gap-1">
            <span className="font-semibold text-muted">{engine.engine}</span>
            {engine.restricted ? null : (
              <span className="rounded-full border border-border bg-canvas px-1.5 py-0.5 font-semibold text-secondary">
                {t("projectAccounts.any")}
              </span>
            )}
            {(engine.restricted ? rows : engine.carrying).map((account) => (
              <span
                key={`${engine.engine}:${account.accountId}`}
                title={carrying.has(account.accountId) ? t("projectAccounts.carryingAria", { label: account.label }) : account.accountId}
                {...(carrying.has(account.accountId) ? { "data-project-account-carrying": account.accountId } : {})}
                className={`max-w-[160px] truncate rounded-full border px-1.5 py-0.5 font-semibold ${
                  carrying.has(account.accountId)
                    ? "border-accent/45 bg-accent/10 text-primary"
                    : "border-border bg-canvas text-secondary"
                }`}
              >
                {account.label}
                {carrying.has(account.accountId) ? ` · ${t("projectAccounts.carrying")}` : ""}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}
