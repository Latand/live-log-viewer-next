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
 * Build + capture: see capture.sh next to this file.
 */
import { createRoot } from "react-dom/client";

import { AgentControlStripView } from "@/components/AgentControlStrip";
import { capabilitiesFor, type StripSurface } from "@/components/agentCapabilities";
import { RuntimePill } from "@/components/RuntimePill";
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

function App() {
  if (view === "claude") {
    return <Shell file={claudeFile} surface="structured" runtimeSettings={CLAUDE_CAP} rv={structuredView("claude-broker")} />;
  }
  if (view === "resume") {
    return <Shell file={{ ...codexFile, proc: null, pid: null } as FileEntry} surface="resume" rv={null} />;
  }
  return <Shell file={codexFile} surface="structured" runtimeSettings={CODEX_CAP} rv={structuredView("codex-app-server")} />;
}

const root = document.getElementById("root")!;
root.style.cssText = "display:flex;flex-direction:column;min-height:100vh;padding:0 12px;";
createRoot(root).render(<App />);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await sleep(150);
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
