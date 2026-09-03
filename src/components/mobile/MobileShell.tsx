"use client";

import { ChevronDown, ChevronLeft, Ellipsis, Search, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { ConnectionState } from "@/components/runtime/runtimeModel";
import { useRuntimeBusState } from "@/hooks/useRuntime";
import { useLocale } from "@/lib/i18n";

import { MobileAccountsPanel } from "../AccountsPanel";
import { MobileReceipt } from "./MobileReceipt";
import { screenKey, topScreen, useMobileNav, useMobileNavStore, type MobileScreenKind, type MobileSheetName } from "./mobileNav";

/*
 * The phone shell (docs/design/mobile-v2/README.md §2, §3.2–§3.4, §5): one bar,
 * one banner slot, one primary surface, the receipt in flow above the dock,
 * and the open sheet last. Every phone screen — the board today; the
 * conversation, pipelines, pipeline and accounts screens as their lanes land —
 * mounts through this component, so the bar budget, the banner precedence and
 * the navigation contract are decided once.
 *
 * The bar at 390 px: `[‹ 44] [title ≥ 190] [⚠ ~52] [search 44] [⋯ 44]` with
 * 2 px gaps and 4 px side padding. Left: back, or nothing. Middle: the title
 * cell, which is itself the switcher. Right: at most three 44 px targets, in
 * this order and only when relevant — the attention badge (count > 0), search
 * (board only), ⋯. The title cell is the ONE elastic cell; `titleCellWidth`
 * is the arithmetic the capture's `title` gate measures in Chromium.
 */

export const BAR_PX = 52;
export const TARGET_PX = 44;
export const BAR_GAP_PX = 2;
export const BAR_PAD_PX = 4;
/** The attention pill with a one-digit count: 3 px wrapper padding each side,
    10 px pill padding each side, a 13 px glyph, a 4 px gap and one digit. */
export const ATTENTION_PX = 52;
export const TITLE_MIN_PX = 190;

export interface BarTargets {
  back: boolean;
  attention: boolean;
  search: boolean;
  menu: boolean;
}

/** The title cell's width at `viewport` px with these targets present. */
export function titleCellWidth(viewport: number, targets: BarTargets): number {
  const fixed = [targets.back ? TARGET_PX : 0, targets.attention ? ATTENTION_PX : 0, targets.search ? TARGET_PX : 0, targets.menu ? TARGET_PX : 0];
  const present = fixed.filter((w) => w > 0);
  const gaps = present.length * BAR_GAP_PX;
  return viewport - 2 * BAR_PAD_PX - present.reduce((sum, w) => sum + w, 0) - gaps;
}

export type BannerKind = "offline" | "degraded" | "arrival";

/** One banner slot, one thing at a time: offline, then runtime degraded, then
    a decision that arrived while the operator reads something else. The board
    never shows an arrival (README §2 rule 3, §4.6): its queue is the first
    section and the bar's badge carries the count, so on the board the slot
    holds runtime states only. */
export function bannerKind(enabled: boolean, connection: ConnectionState, hasArrival: boolean, screen: MobileScreenKind): BannerKind | null {
  if (enabled && connection === "offline") return "offline";
  if (enabled && connection === "degraded") return "degraded";
  return hasArrival && screen !== "board" ? "arrival" : null;
}

/** What the Viewer plumbs into every shell screen: the queue count for the
    badge, the arrival for the banner slot, the search palette, and the sheets
    it owns (the project switcher, the attention queue). */
export interface MobileShellHost {
  attentionCount: number;
  /** The arrival banner for the slot, or null. Runtime states outrank it. */
  arrival: ReactNode;
  /** The sheet for a name the host owns; null for one it does not. */
  renderSheet: (name: MobileSheetName, close: () => void) => ReactNode;
}

export type SheetRenderer = (name: MobileSheetName, close: () => void) => ReactNode;

/** What an enclosing shell offers a screen mounted inside it: the Viewer's
    host (the attention badge, the arrival banner, the sheets it owns), the
    owner's own sheet renderer, and the claim a nested screen makes when it
    renders the bar itself.

    This is the seam between the shell (lane 1) and the screens that land in
    later lanes. The board mounts the conversation screen INSIDE its own shell
    (lane 2's leaf choice), and the conversation screen owns the bar — its
    title cell, its meta line, its `⋯` (lane 3, README §3.2, §4.2). Rather than
    the board guessing at another screen's bar, the screen mounts its own
    MobileShell and CLAIMS the chrome; the shell around it yields its bar,
    banner slot, receipt and sheet for as long as the claim stands, and passes
    down the host and its own sheets so the inner bar still carries the badge,
    the arrival banner and the board's `⋯` rows. Exactly one bar exists at a
    time, and no screen has to be composed by another screen's owner. */
export interface MobileShellChrome {
  host: MobileShellHost | null;
  renderSheet?: SheetRenderer;
  /** Claimed by a nested screen's shell for as long as it is mounted. */
  claim?: (claimed: boolean) => void;
}

const MobileShellChromeContext = createContext<MobileShellChrome | null>(null);

/** The chrome an enclosing shell offers, or null at the top of the tree. */
export function useMobileShellChrome(): MobileShellChrome | null {
  return useContext(MobileShellChromeContext);
}

const ICON_BUTTON = "flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken active:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

function formatClock(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  } catch {
    return "";
  }
}

/** The banner slot directly under the bar. It reserves its height in flow so
    it never covers a control. The screen decides what the slot may carry:
    the board drops the arrival kind (`bannerKind`). */
export function MobileBannerSlot({ screen, arrival }: { screen: MobileScreenKind; arrival: ReactNode }) {
  const { t, locale } = useLocale();
  const { enabled, connection, lastEventAt } = useRuntimeBusState();
  const kind = bannerKind(enabled, connection, arrival !== null && arrival !== undefined, screen);
  if (!kind) return null;
  if (kind === "arrival") {
    return (
      <div data-mobile2-banner data-mobile2-banner-kind="arrival" className="shrink-0">
        {arrival}
      </div>
    );
  }
  const clock = lastEventAt ? formatClock(lastEventAt, locale) : "";
  const title = kind === "offline" ? t("mobile2.banner.offlineTitle") : t("mobile2.banner.degradedTitle");
  const body = kind === "offline"
    ? clock ? t("mobile2.banner.offlineBodyAt", { time: clock }) : t("mobile2.banner.offlineBody")
    : t("mobile2.banner.degradedBody");
  return (
    <div
      role="status"
      data-mobile2-banner
      data-mobile2-banner-kind={kind}
      data-connection={connection}
      className="flex min-h-11 shrink-0 flex-col justify-center border-b border-info/45 bg-info-soft px-3 py-1"
    >
      <span className="text-label font-bold leading-tight text-info">{title}</span>
      <span className="truncate text-body font-medium leading-tight text-secondary">{body}</span>
    </div>
  );
}

const MOTION: Record<string, string> = {
  push: "starting:translate-x-6 starting:opacity-0",
  pop: "starting:-translate-x-6 starting:opacity-0",
  switch: "starting:opacity-0",
};

export function MobileShell({
  screen,
  screenId,
  title,
  titleLabel,
  titleOpens,
  back = false,
  host,
  onOpenSearch,
  searchTestId,
  menu = true,
  renderSheet,
  dock,
  children,
}: {
  screen: MobileScreenKind;
  /** The conversation or pipeline id on those screens (`data-mobile2-conversation`). */
  screenId?: string;
  /** The title cell's content: a project name, a conversation title with its meta line. */
  title: ReactNode;
  /** The title cell's accessible name when it opens a sheet. */
  titleLabel?: string;
  /** The sheet the title cell opens (the project switcher on the board, the
      conversation switcher in a conversation); absent, the cell is static. */
  titleOpens?: MobileSheetName;
  /** Show ‹: every screen above the board. */
  back?: boolean;
  host?: MobileShellHost | null;
  /** The search target (issue #1054) — the board bar only; absent, no target. */
  onOpenSearch?: () => void;
  searchTestId?: string;
  /** The ⋯ target: every screen opens the board menu over itself. */
  menu?: boolean;
  /** The owner's sheets (the board menu, the host sheet); a name it does not
      own falls through to the host's. */
  renderSheet?: SheetRenderer;
  dock?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const nav = useMobileNavStore();
  const state = useMobileNav();
  useEffect(() => nav.attach(), [nav]);
  /* The shell this one is mounted inside, if any: it lends its host and its
     sheets, and it is who this shell claims the chrome from. */
  const outer = useMobileShellChrome();
  const outerClaim = outer?.claim;
  useEffect(() => {
    if (!outerClaim) return;
    outerClaim(true);
    return () => outerClaim(false);
  }, [outerClaim]);
  /* A screen mounted inside this one renders the bar instead (see
     MobileShellChrome). While that claim stands this shell is a plain column:
     no bar, no banner, no receipt, no dock, no sheet — one of each, always.
     The claim changes what this shell RENDERS and never the shape of the tree
     it renders it in, so yielding the chrome does not tear the screen inside
     it down and mount it again. */
  const [claimed, setClaimed] = useState(false);
  const claim = useCallback((next: boolean) => setClaimed(next), []);
  const effectiveHost = host ?? outer?.host ?? null;
  const close = () => nav.closeSheet();
  const attention = (effectiveHost?.attentionCount ?? 0) > 0;
  const showSearch = Boolean(onOpenSearch);
  const sheet = !claimed && state.sheet
    ? (renderSheet?.(state.sheet, close) ?? outer?.renderSheet?.(state.sheet, close) ?? effectiveHost?.renderSheet(state.sheet, close) ?? null)
    : null;
  const top = topScreen(state);
  const chrome = useMemo<MobileShellChrome>(
    () => ({ host: effectiveHost, renderSheet: renderSheet ?? outer?.renderSheet, claim }),
    [effectiveHost, renderSheet, outer?.renderSheet, claim],
  );
  const cell = "flex h-11 min-w-0 flex-1 items-center gap-1 rounded-[8px] px-1.5 text-left";
  /* The screen this shell IS sits on top of the stack; when something else
     does, another shell inside it is that screen and carries the transition
     key. Keying on the top screen either way would remount this column — and
     everything mounted in it — on a sibling switch that never left it. */
  const nested = top.kind !== screen;
  return (
    <MobileShellChromeContext.Provider value={chrome}>
    <div
      key={nested ? screen : screenKey(top)}
      data-mobile2-screen={claimed ? undefined : screen}
      data-mobile2-conversation={!claimed && screen === "chat" ? screenId : undefined}
      data-mobile2-pipeline={!claimed && screen === "pipeline" ? screenId : undefined}
      data-mobile2-motion={claimed ? undefined : state.motion}
      className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden overflow-x-clip bg-canvas transition-[transform,opacity] duration-[200ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${claimed ? "" : MOTION[state.motion] ?? ""}`}
    >
      {claimed ? null : (
        <header data-mobile2-bar className="flex h-[52px] shrink-0 items-center gap-0.5 border-b border-border bg-canvas px-1">
          {back ? (
            <button type="button" data-mobile2-back aria-label={t("mobile2.bar.back")} className={ICON_BUTTON} onClick={() => nav.back()}>
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
          ) : null}
          {titleOpens ? (
            <button
              type="button"
              data-mobile2-title
              data-mobile2-open={titleOpens}
              data-mobile2-bump={state.bump ?? undefined}
              aria-label={titleLabel}
              aria-haspopup="dialog"
              aria-expanded={state.sheet === titleOpens}
              className={`${cell} active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}
              onClick={() => nav.openSheet(titleOpens)}
            >
              {title}
              <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </button>
          ) : (
            <div data-mobile2-title data-mobile2-bump={state.bump ?? undefined} className={cell}>
              {title}
            </div>
          )}
          {attention ? (
            <button
              type="button"
              data-mobile2-open="attention"
              data-mobile2-attention-count={effectiveHost?.attentionCount}
              aria-label={t("mobile2.bar.attention", { count: effectiveHost?.attentionCount ?? 0 })}
              aria-haspopup="dialog"
              aria-expanded={state.sheet === "attention"}
              className="flex h-11 shrink-0 items-center px-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => nav.openSheet("attention")}
            >
              <span className="inline-flex h-7 items-center gap-1 rounded-full border border-warning/45 bg-warning-soft px-2.5 text-ui font-bold tabular-nums text-warning">
                <TriangleAlert className="h-[13px] w-[13px]" aria-hidden />
                {effectiveHost?.attentionCount}
              </span>
            </button>
          ) : null}
          {showSearch ? (
            <button type="button" data-testid={searchTestId} data-mobile2-open="search" aria-label={t("mobile2.bar.search")} className={ICON_BUTTON} onClick={onOpenSearch}>
              <Search className="h-5 w-5" aria-hidden />
            </button>
          ) : null}
          {menu ? (
            <button
              type="button"
              data-mobile2-open="menu"
              aria-label={t("mobile2.bar.more")}
              aria-haspopup="dialog"
              aria-expanded={state.sheet === "menu"}
              className={ICON_BUTTON}
              onClick={() => nav.openSheet("menu")}
            >
              <Ellipsis className="h-5 w-5" aria-hidden />
            </button>
          ) : null}
        </header>
      )}
      {claimed ? null : <MobileBannerSlot screen={screen} arrival={effectiveHost?.arrival ?? null} />}
      <div data-mobile2-body={claimed ? undefined : true} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
      {/* The receipt takes its own height between the body and the dock; a
          sheet shows it inside itself instead. */}
      {claimed || state.sheet ? null : <MobileReceipt placement="flow" />}
      {!claimed && dock ? (
        <footer data-mobile2-dock className="shrink-0 border-t border-border bg-card px-3 pb-[calc(6px+env(safe-area-inset-bottom))] pt-1.5">
          {dock}
        </footer>
      ) : null}
      {sheet}
    </div>
    </MobileShellChromeContext.Provider>
  );
}

/** A static bar title: the board's project name, a screen's name. */
export function MobileBarTitle({ children }: { children: ReactNode }) {
  return <span data-mobile2-title-text className="min-w-0 truncate text-title font-semibold leading-tight text-primary">{children}</span>;
}

/** The accounts screen the board menu pushes (README §3.1, §4.8): the shell's
    bar with ‹ over the phone's accounts layout (lane 9, `AccountsPanel.tsx`);
    the screen and its route are the shell's. */
export function MobileAccountsScreen({ host, renderSheet }: { host?: MobileShellHost | null; renderSheet?: SheetRenderer }) {
  const { t } = useLocale();
  return (
    <MobileShell screen="accounts" back title={<MobileBarTitle>{t("mobile2.accounts.title")}</MobileBarTitle>} host={host} renderSheet={renderSheet}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" data-mobile2-accounts>
        <MobileAccountsPanel />
      </div>
    </MobileShell>
  );
}
