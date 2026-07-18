/**
 * Static acceptance harness for the issue #406 timer-boundary change.
 *
 * Renders the REAL `TurnStatusBar` — the pinned bottom working-status slot —
 * inside a faithful pane shell against the production CSS bundle, in both of
 * its states:
 *
 *   ?view=running|finished&lang=en|uk&theme=light|dark
 *
 * running:  «working… · 4:32» — live label, bounce dots, 1 Hz timer from the
 *           initiating-prompt boundary the scanner now derives under the
 *           shared meta/command classification contract.
 * finished: «Worked for 12m 30s» — the frozen total between the boundaries.
 *
 * Build + capture: see capture.sh next to this file.
 */
import { Sparkle } from "lucide-react";
import { createRoot } from "react-dom/client";

import { TurnStatusBar } from "@/components/TurnStatusBar";
import { setLocale, translate, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "running";
const lang = (params.get("lang") ?? "en") as Locale;
const theme = params.get("theme") ?? "light";

document.documentElement.dataset.theme = theme;
setLocale(lang);

const now = Date.now();
const file: Pick<FileEntry, "lastTurn" | "activity"> =
  view === "finished"
    ? { activity: "idle", lastTurn: { startedAt: now - 900_000, endedAt: now - 150_000 } }
    : { activity: "live", lastTurn: { startedAt: now - 272_000, endedAt: null } };

function Shell() {
  return (
    // The status bar is pinned OUTSIDE the transcript scroller in the real
    // pane; the shell mirrors that: scroller placeholder above, bar below.
    // Scaffolding uses inline styles — the production CSS only carries
    // app-used utilities.
    <div
      className="flex flex-col rounded-surface border border-border bg-card"
      style={{ margin: "24px auto", width: "calc(100% - 24px)", maxWidth: 720 }}
    >
      <div className="p-3 text-ui text-muted" style={{ minHeight: 160 }}>…transcript…</div>
      <TurnStatusBar
        file={file}
        workingLabel={translate(lang, "status.working")}
        workingIcon={Sparkle}
        compact={window.matchMedia("(max-width: 767px)").matches}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
