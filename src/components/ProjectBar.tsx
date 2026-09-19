"use client";

import { Bot, ListTodo, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

/*
 * The project board's one header bar (#1801, docs/design/board-header.md).
 *
 * One 48 px row, eight groups in reading order: where am I, what is happening,
 * one spacer, find, view, create, panels, more, and the Viewer's attention
 * island in the right reserve. Every control is 32 px in one of three variants:
 * outlined, pressed (`aria-pressed="true"`), and the quiet icon of the ⋯
 * trigger. Hover only strengthens the border, so pressed stays the one
 * accent-coloured state. The kanban board draws the bar with its own groups in
 * the middle; the leaves without a board draw the same bar here, with the same
 * two ends.
 */

/** At or above this bar width the controls carry their labels and the account switches sit in
    the bar; below it they are icons and the accounts move into ⋯. Measured on a seeded home, the
    uk labels with two account switches and a short project name need about 1 640 px of bar
    (the island's 252 px of padding and reserve included); 1 700 leaves room for a longer name. */
export const BAR_WIDE_MIN = 1700;

export const BAR_CONTROL =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border px-3 text-[12px] font-semibold shadow-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
export const BAR_OUTLINED = "border-border bg-card text-primary hover:border-strong";
export const BAR_PRESSED = "border-accent/45 bg-accent/10 text-accent";
const BAR_QUIET =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-transparent text-secondary transition-colors hover:border-border hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

const BAR_ICON = "h-[15px] w-[15px] shrink-0";

/** A row of the ⋯ menu. */
export const BAR_MENU_ROW =
  "flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] font-semibold text-primary hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent";

/** Whether a bar is wide enough for labelled controls, measured on the bar itself. */
export function useBarWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = () => setWide(element.getBoundingClientRect().width >= BAR_WIDE_MIN);
    apply();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

/**
 * The create group: `+ Task` and `+ Agent`, or one `+` opening a two-row menu
 * when the bar is narrow. `reserve` draws the same group invisible and inert on
 * the leaves that create nothing (Conversations), so the view switch and
 * everything right of it keep their x when the operator changes view.
 */
export function BarCreateGroup({ wide, task, agent, onMenu, menuOpen = false, reserve = false }: {
  wide: boolean;
  task?: { onClick: () => void; expanded: boolean } | null;
  agent?: { onClick: () => void; disabled: boolean } | null;
  /** Narrow: opens the create menu under the `+`. */
  onMenu?: (anchor: HTMLElement) => void;
  menuOpen?: boolean;
  reserve?: boolean;
}) {
  const { t } = useLocale();
  const control = `${BAR_CONTROL} ${BAR_OUTLINED} disabled:cursor-not-allowed disabled:opacity-50`;
  if (reserve) {
    return (
      <div className="invisible flex shrink-0 items-center gap-2" data-bar-group="create" data-bar-create-reserve="" aria-hidden inert>
        {wide ? (
          <>
            <span className={control}><Plus className={BAR_ICON} aria-hidden />{t("dash.task")}</span>
            <span className={control}><Plus className={BAR_ICON} aria-hidden />{t("dash.agent")}</span>
          </>
        ) : <span className={`${control} w-8 px-0`}><Plus className={BAR_ICON} aria-hidden /></span>}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2" data-bar-group="create">
      {wide || !onMenu ? (
        <>
          {task ? (
            <button type="button" className={control} data-new-task="" data-bar-control="" aria-label={t("dash.newTask")} aria-expanded={task.expanded} onClick={task.onClick}>
              <Plus className={BAR_ICON} aria-hidden />{t("dash.task")}
            </button>
          ) : null}
          {agent ? (
            <button type="button" className={control} data-new-agent="" data-bar-control="" aria-label={t("dash.newConvo")} disabled={agent.disabled} onClick={agent.onClick}>
              <Plus className={BAR_ICON} aria-hidden />{t("dash.agent")}
            </button>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          className={`${control} w-8 px-0`}
          data-bar-create=""
          data-bar-control=""
          aria-label={t("dash.create")}
          title={t("dash.create")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <Plus className={BAR_ICON} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The two panel switches: the orchestrator dock and the task panel. Icon only (with the count) when narrow. */
export function BarPanelToggles({ wide, orchestrator, tasks }: {
  wide: boolean;
  orchestrator: { open: boolean; onToggle: () => void } | null;
  tasks: { open: boolean; count: number; onToggle: () => void };
}) {
  const { t } = useLocale();
  return (
    <div className="flex shrink-0 items-center gap-2" data-bar-group="panels">
      {orchestrator ? (
        <button
          type="button"
          onClick={orchestrator.onToggle}
          aria-pressed={orchestrator.open}
          aria-label={t("orchPanel.toggleAria")}
          title={t("orchPanel.toggleAria")}
          data-orchestrator-toggle
          data-bar-control=""
          className={`${BAR_CONTROL} ${orchestrator.open ? BAR_PRESSED : BAR_OUTLINED} ${wide ? "" : "px-2"}`}
        >
          <Bot className={BAR_ICON} aria-hidden />
          {wide ? t("orchPanel.title") : null}
        </button>
      ) : null}
      <button
        type="button"
        onClick={tasks.onToggle}
        aria-pressed={tasks.open}
        aria-label={t("tasks.panelToggleAria")}
        title={t("tasks.panelToggleAria")}
        data-task-panel-toggle=""
        data-bar-control=""
        className={`${BAR_CONTROL} ${tasks.open ? BAR_PRESSED : BAR_OUTLINED} ${wide ? "" : "px-2"}`}
      >
        <ListTodo className={BAR_ICON} aria-hidden />
        {wide ? t("tasks.panelTitle") : null}
        {tasks.count ? <span className="font-normal text-muted tabular-nums">{tasks.count}</span> : null}
      </button>
    </div>
  );
}

/**
 * The ⋯ menu: everything the bar holds that is not used every minute. Its rows
 * are the controls themselves, so a confirm or a levels panel opens in place
 * and the menu stays open until the operator leaves it. `rows` receives a
 * `close` for the rows whose action is done in one click.
 */
export function BarMoreMenu({ rows }: { rows: (close: () => void) => ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <span ref={container} className="relative inline-flex shrink-0" data-bar-group="more">
      <button
        ref={trigger}
        type="button"
        data-bar-more=""
        data-bar-control=""
        aria-label={t("dash.more")}
        title={t("dash.more")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={`${BAR_QUIET} ${open ? "border-border bg-well text-primary" : ""}`}
      >
        <MoreHorizontal className={BAR_ICON} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("dash.more")}
          data-bar-more-menu=""
          onKeyDown={(event) => { handleOverlayEscape(event, close); }}
          className={`absolute right-0 top-full z-50 mt-1 flex w-64 flex-col rounded-control border border-border bg-card p-1 shadow-2 ${MENU_RULES}`}
        >
          {rows(close)}
        </div>
      ) : null}
    </span>
  );
}

/* A rule sits only between two groups that both drew a row: a group whose rows
   all stood down (Archive and Delete while agents run, accounts on a quiet
   project) is empty and hidden, and never leaves a rule behind. */
const MENU_RULES =
  "[&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:mt-1 [&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:border-t [&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:border-border [&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:pt-1";

/** One group of ⋯ rows. */
export function BarMenuGroup({ name, children }: { name: string; children: ReactNode }) {
  return <div role="group" data-bar-menu-group={name} className="flex flex-col gap-0.5 empty:hidden">{children}</div>;
}

/**
 * The same bar on the leaves the kanban board does not draw (Conversations, the
 * empty project, the loading skeleton): the project's two ends around this
 * leaf's status line, its one search, the view switch and the create group's
 * reserve.
 */
export function DashboardBar({ lead, status, find, view, create, trail }: {
  lead: (wide: boolean) => ReactNode;
  status: (wide: boolean) => ReactNode;
  find: (wide: boolean) => ReactNode;
  view: (wide: boolean) => ReactNode;
  create: (wide: boolean) => ReactNode;
  trail: (wide: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useBarWide(ref);
  return (
    <div
      ref={ref}
      data-project-bar=""
      data-bar-tier={wide ? "wide" : "narrow"}
      className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card pl-4 pr-[236px]"
    >
      <div className={`flex shrink items-center gap-2 ${wide ? "" : "min-w-12"}`} data-bar-group="where">{lead(wide)}</div>
      {status(wide)}
      <span aria-hidden className="min-w-0 flex-1" />
      {find(wide)}
      <div className="flex shrink-0 items-center gap-2 empty:hidden" data-bar-group="view">{view(wide)}</div>
      {create(wide)}
      <div className="flex shrink-0 items-center gap-4" data-bar-group="trail">{trail(wide)}</div>
    </div>
  );
}
