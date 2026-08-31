"use client";

import { useEffect, useState } from "react";

import { EngineAccountSwitch } from "./EngineAccountSwitch";

/** One engine's block of the project view served by /api/account-project-bindings. */
export interface ProjectAccountsEngineView {
  engine: "claude" | "codex";
  restricted: boolean;
  allowed: { accountId: string; label: string }[];
  carrying: { accountId: string; label: string }[];
  /** Accounts somebody deliberately chose from outside the pool, newest first. */
  outsidePool: { accountId: string; label: string; at: string; actor: "operator" | "agent" }[];
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
    const outsidePool = Array.isArray(view.outsidePool)
      ? view.outsidePool.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.accountId !== "string" || !entry.accountId) return [];
          return [{
            accountId: entry.accountId,
            label: typeof entry.label === "string" && entry.label ? entry.label : entry.accountId,
            at: typeof entry.at === "string" ? entry.at : "",
            actor: entry.actor === "agent" ? "agent" as const : "operator" as const,
          }];
        })
      : [];
    return [{
      engine,
      restricted: view.restricted === true,
      allowed: accounts(view.allowed),
      carrying: accounts(view.carrying),
      outsidePool,
    }];
  });
  return { project: record.project, engines: parsed };
}

/**
 * The project side of #1279's relation: which accounts this project may use,
 * which of them are carrying its work right now, and which were deliberately
 * chosen from outside that set.
 *
 * It stays silent for a project that is neither fenced nor busy. Relevant
 * engines each get one compact active-account switch; project pool, carrier,
 * and out-of-pool detail moves into that switch's panel (#1331).
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
  const shown = (view?.engines ?? []).filter((engine) =>
    engine.restricted || engine.carrying.length > 0 || engine.outsidePool.length > 0);
  if (!view || !shown.length) return null;
  return (
    <div data-project-accounts={view.project} className="flex min-w-0 shrink-0 items-center gap-1">
      {shown.map((engine) => (
        <EngineAccountSwitch
          key={engine.engine}
          engine={engine.engine}
          projectContext={{
            project: view.project,
            restricted: engine.restricted,
            allowed: engine.allowed,
            carrying: engine.carrying,
            outsidePool: engine.outsidePool,
          }}
        />
      ))}
    </div>
  );
}
