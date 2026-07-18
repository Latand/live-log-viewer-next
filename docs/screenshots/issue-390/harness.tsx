/**
 * Static acceptance harness for the issue #390 composer runtime pill.
 *
 * Renders the REAL presentational pieces — `AgentControlStripView` (structured
 * strip without the retired badge) and `RuntimePill` (face, popover panels,
 * 390 px sheet) — inside a faithful composer shell, against the production CSS
 * bundle. Driven by query params so one page yields every §12 state:
 *
 *   ?view=rest|popover|model|speed|claude|resume|sheet&lang=en|uk&theme=light|dark
 *
 * Issue #405 additions:
 *   ?view=applying    — live-tmux reconfigure converging (spinner on the pill)
 *   ?view=apply-error — live-tmux reconfigure failed (danger face)
 *   ?view=before      — static reconstruction of the RETIRED pre-#390 strip
 *                       (badge + raw selects + Apply) for the §12.8 pair
 *   ?view=stage       — the stage placeholder's RuntimeControlsView row
 *
 * Build + capture: see capture.sh next to this file.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { AgentControlStripView } from "@/components/AgentControlStrip";
import { capabilitiesFor, type StripSurface } from "@/components/agentCapabilities";
import { RuntimeControlsView, type RuntimeDraft } from "@/components/AgentRuntimeControls";
import { RuntimePill } from "@/components/RuntimePill";
import { SELECT_RECIPE } from "@/components/ui/Select";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { setLocale, translate, type Locale, type MessageKey } from "@/lib/i18n";
import type { RuntimeSettingsCapability } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "rest";
const lang = (params.get("lang") ?? "en") as Locale;
const theme = params.get("theme") ?? "light";

document.documentElement.dataset.theme = theme;
setLocale(lang);
const t = (key: MessageKey, values?: Record<string, string | number>) => translate(lang, key, values);

const codexFile: FileEntry = {
  path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "codex",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
  proc: "running", pid: 10, conversationId: "conversation_demo", model: "gpt-5.6-sol", effort: "low", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;
const claudeFile: FileEntry = {
  ...codexFile, path: "/claude.jsonl", root: "claude-projects", name: "claude.jsonl", fmt: "claude",
  engine: "claude", conversationId: "conversation_claude", model: "fable", effort: "high",
} as FileEntry;
const liveFile: FileEntry = {
  ...codexFile, path: "/live.jsonl", name: "live.jsonl", conversationId: "conversation_live", effort: "low",
} as FileEntry;

/* #405 state seeding, before render. A fresh capture must not inherit a
   previous run's persisted pill state (file:// shares one localStorage). */
localStorage.clear();
if (view === "applying") {
  // A reconfigure to medium is confirming while the pane still reports low —
  // the pill face shows the draft with the spinner replacing the chevron.
  localStorage.setItem("llvAgentRuntime:conversation_live", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  localStorage.setItem("llvAgentRuntime:conversation_live:phase", "confirming");
}
if (view === "apply-error") {
  // The scripted selection below hits this stub and fails: the face reverts to
  // the observed runtime and paints text-danger (§6).
  window.fetch = (async () => ({
    ok: false,
    json: async () => ({ ok: false, error: "tmux reconfigure failed" }),
  })) as unknown as typeof fetch;
}

const structuredView = (hostKind: "codex-app-server" | "claude-broker"): RuntimeSessionView => ({
  session: { hostKind, host: "hosted" } as RuntimeSessionView["session"],
  uiState: {} as RuntimeSessionView["uiState"],
  attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true,
});

const CODEX_CAP: RuntimeSettingsCapability = { perTurnEffort: true, perTurnModel: false };
const CLAUDE_CAP: RuntimeSettingsCapability = { perTurnEffort: false, perTurnModel: false };

function Shell({ file, surface, runtimeSettings, rv }: {
  file: FileEntry;
  surface: StripSurface;
  runtimeSettings?: RuntimeSettingsCapability | null;
  rv: RuntimeSessionView | null;
}) {
  const caps = capabilitiesFor(file, rv);
  return (
    // The composer is pinned to the bottom in the real pane; anchoring the
    // card low gives the upward-opening popover its natural room. Scaffolding
    // uses inline styles — the production CSS only carries app-used utilities.
    <div
      className="flex flex-col rounded-surface border border-border bg-card"
      style={{ margin: "auto auto 24px", width: "100%", maxWidth: 720 }}
    >
      <div className="border-b border-border p-3 text-ui text-muted" style={{ minHeight: 120 }}>…transcript…</div>
      <AgentControlStripView
        t={t}
        isMobile={window.matchMedia("(max-width: 767px)").matches}
        caps={caps}
        layout="full"
        compactArmed={false}
        stopBusy={false}
        compactBusy={false}
        overflowOpen={false}
        onStop={() => {}}
        onCompact={() => {}}
        onTerminal={() => {}}
        onToggleOverflow={() => {}}
        status={null}
      />
      {/* The composer shell (§3.5 recipe): sunken input + quiet bottom row. */}
      <form className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 py-2">
        <div className="flex items-end gap-1 rounded-control border border-border bg-sunken py-1 pl-2.5 pr-1">
          <textarea rows={1} readOnly placeholder={t("composer.placeholderSend")} className="min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-ui leading-[18px] text-primary placeholder:text-muted focus-visible:outline-none" />
          <button type="button" className="inline-flex shrink-0 items-center justify-center rounded-control border border-accent bg-accent p-2 text-white" aria-label={t("composer.sendToAgent")}>▶</button>
        </div>
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <RuntimePill file={file} surface={surface} runtimeSettings={runtimeSettings} />
          </div>
          <button type="button" className="inline-flex shrink-0 items-center justify-center rounded-control p-2 text-muted" aria-label={t("composer.addImages")}>🖼</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Static reconstruction of the RETIRED pre-#390 strip (commit `a30dd395~1`):
 * the «структурований» ModeChip, the raw model/effort selects and the Apply
 * button. No product code renders this anymore — it exists only as the
 * "before" half of the §12.8 before/after evidence pair, using the retired
 * markup's own class recipes.
 */
function BeforeShell() {
  const uk = lang === "uk";
  const mobileNow = window.matchMedia("(max-width: 767px)").matches;
  return (
    <div
      className="flex flex-col rounded-surface border border-border bg-card"
      style={{ margin: "auto auto 24px", width: "100%", maxWidth: 720 }}
    >
      <div className="border-b border-border p-3 text-ui text-muted" style={{ minHeight: 120 }}>…transcript…</div>
      <div className="flex items-center gap-1.5 border-t border-border bg-card px-2.5 py-1.5">
        <span className="inline-flex min-w-0 items-center gap-1 rounded-control bg-sunken px-1.5 py-1 text-caption font-semibold text-secondary">
          <span aria-hidden>▣</span>
          <span className="truncate">{uk ? "структурований" : "structured"}</span>
        </span>
        {mobileNow ? (
          /* The retired mobile face: one 44px pill in front of a bottom sheet. */
          <button type="button" className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-canvas px-2.5 text-label font-semibold text-secondary">
            <span aria-hidden>🎚</span>
            <span className="max-w-[38vw] truncate">GPT-5.6-Sol · {uk ? "високі" : "high"}</span>
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1">
            <select className={SELECT_RECIPE} defaultValue="sol">
              <option value="sol">GPT-5.6-Sol</option>
            </select>
            <select className={SELECT_RECIPE} defaultValue="high">
              <option value="high">{uk ? "високі" : "high"}</option>
            </select>
            <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-canvas px-1.5 text-[9.5px] font-semibold text-muted">
              ✓ {uk ? "Застосувати" : "Apply"}
            </button>
          </span>
        )}
      </div>
      <form className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 py-2">
        <div className="flex items-end gap-1 rounded-control border border-border bg-sunken py-1 pl-2.5 pr-1">
          <textarea rows={1} readOnly placeholder={t("composer.placeholderSend")} className="min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-ui leading-[18px] text-primary placeholder:text-muted focus-visible:outline-none" />
          <button type="button" className="inline-flex shrink-0 items-center justify-center rounded-control border border-accent bg-accent p-2 text-white" aria-label={t("composer.sendToAgent")}>▶</button>
        </div>
        <div className="flex items-center justify-end gap-1.5">
          <button type="button" className="inline-flex shrink-0 items-center justify-center rounded-control p-2 text-muted" aria-label={t("composer.addImages")}>🖼</button>
        </div>
      </form>
    </div>
  );
}

/** The stage placeholder's runtime row exactly as StagePlaceholderPane mounts
    it (#405): the shared RuntimeControlsView inside the sunken reasoning row —
    at 390px the row wraps and every control inflates to the 44px target. */
function StageShell() {
  const [runtime, setRuntime] = useState<RuntimeDraft>({ model: "fable", effort: "high", fast: false });
  return (
    <section
      className="flex flex-col overflow-hidden rounded-control border-2 border-dashed border-border bg-card shadow-1"
      style={{ margin: "auto auto 24px", width: "100%", maxWidth: 720 }}
    >
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-border" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-muted">Builder · {t("pipelineSlot.stageOf", { k: 2, n: 3 })}</span>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-sunken px-2.5 py-1.5">
        <span className="shrink-0 text-caption font-semibold text-muted">{t("draft.reasoning")}</span>
        <RuntimeControlsView
          engine="claude"
          draft={runtime}
          state="idle"
          error=""
          showSpeed={false}
          withDefaults
          onEdit={(update) => setRuntime(update)}
          onApply={() => {}}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
        <span className="max-w-[380px] text-ui leading-5 text-muted">{t("pipelineSlot.waiting", { role: "Builder" })}</span>
      </div>
    </section>
  );
}

function App() {
  if (view === "claude") {
    return <Shell file={claudeFile} surface="structured" runtimeSettings={CLAUDE_CAP} rv={structuredView("claude-broker")} />;
  }
  if (view === "resume") {
    return <Shell file={{ ...codexFile, proc: null, pid: null } as FileEntry} surface="resume" rv={null} />;
  }
  if (view === "applying" || view === "apply-error") {
    return <Shell file={liveFile} surface="live-root" rv={null} />;
  }
  if (view === "before") return <BeforeShell />;
  if (view === "stage") return <StageShell />;
  return <Shell file={codexFile} surface="structured" runtimeSettings={CODEX_CAP} rv={structuredView("codex-app-server")} />;
}

const root = document.getElementById("root")!;
root.style.cssText = "display:flex;flex-direction:column;min-height:100vh;padding:0 12px;";
createRoot(root).render(<App />);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await sleep(150);
  if (view === "apply-error") {
    /* Drive the real failure path: open the pill, select a different tier, let
       the stubbed reconfigure fail. Desktop closes the popover on selection;
       the mobile sheet stays open, so the script closes it via the backdrop to
       reveal the danger-painted pill. */
    (document.querySelector("[data-runtime-pill]") as HTMLElement | null)?.click();
    await sleep(150);
    const desktopRow = document.querySelector('[data-runtime-row="tier"][data-runtime-value="tier-medium"]') as HTMLElement | null;
    const sheetRow = [...document.querySelectorAll("[data-runtime-sheet-row]")]
      .find((el) => el.textContent?.trim() === translate(lang, "reasoningTier.medium")) as HTMLElement | undefined;
    (desktopRow ?? sheetRow)?.click();
    await sleep(300);
    (document.querySelector('[role="presentation"]') as HTMLElement | null)?.click();
    return;
  }
  const open = view === "popover" || view === "model" || view === "speed" || view === "claude" || view === "resume" || view === "sheet";
  if (!open) return;
  (document.querySelector("[data-runtime-pill]") as HTMLElement | null)?.click();
  await sleep(150);
  if (view === "model" || view === "speed") {
    const row = [...document.querySelectorAll('[data-runtime-row="submenu"]')]
      .find((el) => el.getAttribute("data-runtime-value") === view) as HTMLElement | undefined;
    row?.click();
  }
})();
