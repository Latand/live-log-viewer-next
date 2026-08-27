"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

/**
 * Splits a directory so the segment that tells two similar paths apart — the
 * last one — is never what gets shortened. Heads repeat across a machine
 * (`~/Projects/…`, `<repo>/.worktrees/…`); the final segment is what the
 * operator recognises, so any elision happens inside the head and the tail is
 * always drawn whole.
 */
export function splitDirectoryPath(dir: string): { head: string; tail: string } {
  const trimmed = dir.trim().replace(/(.)\/+$/, "$1");
  const cut = trimmed.lastIndexOf("/");
  /* A bare "/" (and any path with no separator) is all tail — nothing to mute. */
  if (cut < 0 || cut === trimmed.length - 1) return { head: "", tail: trimmed };
  return { head: trimmed.slice(0, cut + 1), tail: trimmed.slice(cut + 1) };
}

/**
 * Shortens a head that would overflow the closed control, keeping whole
 * segments from **both ends**: the root names the machine area (`/home`,
 * `/repos`), and the segments next to the tail are what distinguish siblings
 * (`…/live-log-viewer/.worktrees/`). Only the middle — the part nearly every
 * path on one machine shares — is dropped.
 */
export function elideDirectoryHead(head: string, budget: number): string {
  if (head.length <= budget) return head;
  const segments = head.split("/").filter(Boolean);
  if (segments.length < 3) return head;
  const first = "/" + segments[0] + "/";
  /* Grow the kept suffix segment by segment while it still fits beside the
     leading root and the ellipsis; one segment is always kept, so a single
     enormous segment elides instead of swallowing the whole head. */
  let kept = segments[segments.length - 1] + "/";
  for (let index = segments.length - 2; index > 0; index -= 1) {
    const grown = segments[index] + "/" + kept;
    if (first.length + 2 + grown.length > budget) break;
    kept = grown;
  }
  return first + "…/" + kept;
}

/** Longest path drawn whole on the closed control; past this the head elides.
    The budget is about two lines of 11px monospace in a 396px phone pane. */
const CLOSED_PATH_BUDGET = 96;

/** Every whitespace-separated token must appear somewhere in the path, so
    `viewer 887` finds one checkout among a screenful of sibling worktrees. */
export function matchesDirectoryQuery(dir: string, query: string): boolean {
  const haystack = dir.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export type PickerRow = { key: string; value: string; kind: "known" | "typed" };

/** Whether a query is the operator naming a place rather than filtering. Only
    a path shape is offered as a directory: the spawn route resolves anything
    else against ITS own working directory, which is never what was meant. */
export function looksLikeDirectoryPath(query: string): boolean {
  return query.startsWith("/") || query.startsWith("~") || query.includes("/");
}

/** The known directories, current one first — relaunching from the same place
    is the top row, ahead of anything the server suggested. */
export function directoryChoices(value: string, dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [value, ...dirs]) {
    const trimmed = dir?.trim() ?? "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Rows the open popup lists for a query: the matching known directories, plus
    the typed path itself when it is not one of them (free-text entry). */
export function directoryRows(known: readonly string[], query: string, pristine: boolean): PickerRow[] {
  const matched = pristine ? [...known] : known.filter((dir) => matchesDirectoryQuery(dir, query));
  const rows: PickerRow[] = matched.map((dir) => ({ key: "known:" + dir, value: dir, kind: "known" }));
  const typed = query.trim();
  if (!pristine && typed && looksLikeDirectoryPath(typed) && !known.includes(typed)) {
    rows.push({ key: "typed", value: typed, kind: "typed" });
  }
  return rows;
}

/** One path, head muted and last segment emphasised, wrapped rather than
    clipped so two sibling worktrees stay apart down to their last character. */
function PathText({ dir, elide }: { dir: string; elide?: boolean }) {
  const { head, tail } = splitDirectoryPath(dir);
  return (
    <>
      <span className="text-muted">{elide ? elideDirectoryHead(head, Math.max(CLOSED_PATH_BUDGET - tail.length, 12)) : head}</span>
      <span className="font-semibold text-primary">{tail}</span>
    </>
  );
}

/**
 * The working-directory picker (issue #887). A `<datalist>` gave the operator
 * nothing to recognise — invisible until the right prefix was typed, impossible
 * to browse, drawn differently in every browser — and a confirmation banner was
 * bolted on top to compensate for it. This is the other bet: the known
 * directories are one click away and fully readable, and the chosen one is
 * spelled out on the closed control with its last segment intact, so a wrong
 * directory is obvious at a glance without anything asking about it.
 *
 * A trigger that reads out the whole path opens a filter field over a listbox:
 * the list starts unfiltered (browse without typing a character), any substring
 * narrows it, arrows/Enter/Escape/Home/End drive it from the keyboard, and a
 * path that is not in the list is committed exactly as typed.
 */
export function DirectoryPicker({
  id,
  value,
  dirs,
  disabled,
  ariaLabel,
  onQueryChange,
  openSignal,
  onChange,
}: {
  /** Stable id prefix for the listbox and option ids this control owns. */
  id: string;
  value: string;
  dirs: readonly string[];
  disabled?: boolean;
  /** Accessible name for the trigger; the chosen path is appended to it. */
  ariaLabel: string;
  /**
   * The filter text, reported as it changes (issue #1223). The picker still
   * only filters `dirs`; this lets a caller whose suggestions come from the
   * filesystem widen that list as the operator points somewhere new — which is
   * what create-project needs, since the directory it is after is precisely the
   * one no known-directories list carries.
   */
  onQueryChange?: (query: string) => void;
  /** Bumped by a caller that wants the list opened — a create form that
      refused the typed root answers with the completion, on the spot, rather
      than with a rejection the operator has to reopen the picker to act on. */
  openSignal?: number;
  onChange: (value: string) => void;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  /* The query opens as the current path, selected: typing browses (it replaces
     the selection and filters), editing tweaks the path in place. `pristine`
     keeps that untouched query from filtering the list down to the single entry
     it already holds — opening the picker always shows everything known. */
  const [query, setQuery] = useState(value);
  const [pristine, setPristine] = useState(true);
  const [active, setActive] = useState(0);
  /* Render-phase edge, the repo's pattern for following a prop transition: the
     caller's signal opens the list on the value it already holds, without an
     effect that would race the frame the refusal is drawn in. */
  const [seenOpenSignal, setSeenOpenSignal] = useState(openSignal);
  if (openSignal !== seenOpenSignal) {
    setSeenOpenSignal(openSignal);
    if (!disabled && !expanded) {
      setQuery(value);
      setPristine(true);
      setActive(0);
      setExpanded(true);
    }
  }
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* A launch freezes every draft field; a popup left open over frozen controls
     would offer a choice that no longer applies, so `disabled` closes it by
     derivation rather than through an effect that races the render. */
  const open = expanded && !disabled;
  const chosen = value.trim();
  const listId = id + "-listbox";
  const optionId = (index: number) => id + "-option-" + index;

  const known = useMemo(() => directoryChoices(value, dirs), [dirs, value]);
  const rows = useMemo(() => directoryRows(known, query, pristine), [known, pristine, query]);
  /* Rows shrink as the query narrows and as the server's list lands; clamping
     here keeps the highlight on a row that exists without a correcting effect. */
  const activeIndex = rows.length ? Math.min(active, rows.length - 1) : 0;

  const openPicker = () => {
    if (disabled) return;
    setQuery(value);
    setPristine(true);
    setActive(Math.max(known.indexOf(chosen), 0));
    setExpanded(true);
    onQueryChange?.(value);
  };

  const close = () => {
    setExpanded(false);
    triggerRef.current?.focus();
  };
  const commit = (next: string) => {
    const trimmed = next.trim();
    if (trimmed && trimmed !== chosen) onChange(trimmed);
    close();
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  /* Keyboard travel must not walk the highlight out of the scroll port. */
  useEffect(() => {
    if (!open) return;
    document.getElementById(id + "-option-" + activeIndex)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, id]);

  const step = (delta: number) => {
    if (!rows.length) return;
    setActive((current) => {
      const from = Math.min(current, rows.length - 1);
      return (from + delta + rows.length) % rows.length;
    });
  };

  return (
    <div
      ref={rootRef}
      /* Exempts the control from the scheme camera's pan/tap capture and from
         the board's spatial arrow navigation, which the popup owns while open. */
      data-scheme-ui
      data-directory-picker={open ? "open" : "closed"}
      className="relative flex min-w-0 flex-1 flex-col"
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel + ": " + (chosen || t("dirPicker.empty"))}
        data-directory-trigger
        data-directory-value={chosen}
        title={chosen || undefined}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          openPicker();
        }}
        className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2 py-1 text-left hover:border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 sm:min-h-0"
      >
        <span className="line-clamp-2 min-w-0 flex-1 break-all font-mono text-[11px] leading-4">
          {chosen ? <PathText dir={chosen} elide /> : <span className="text-muted">{t("dirPicker.empty")}</span>}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 flex max-h-[min(60vh,320px)] flex-col overflow-hidden rounded-[10px] border border-border bg-raised shadow-2">
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[activeIndex] ? optionId(activeIndex) : undefined}
            aria-label={t("dirPicker.searchAria")}
            placeholder={t("dirPicker.searchPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setPristine(false);
              setActive(0);
              onQueryChange?.(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                step(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                step(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActive(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActive(Math.max(rows.length - 1, 0));
              } else if (event.key === "Enter" || event.key === "Tab") {
                /* Tab commits like Enter and hands focus back to the trigger,
                   where the next Tab continues from — a typed path is never
                   lost by moving on. With no row under the highlight the query
                   is a filter word that matched nothing, and a bare word is not
                   a directory: the spawn route would resolve it against ITS own
                   working directory and launch somewhere nobody named. A missed
                   filter closes the popup and leaves the directory as it was. */
                event.preventDefault();
                const row = rows[activeIndex];
                if (row) commit(row.value);
                else close();
              } else if (event.key === "Escape") {
                event.preventDefault();
                /* The board's own Escape closes panes and disclosures; this one
                   only closes the popup, leaving the directory as it was. */
                event.stopPropagation();
                close();
              }
            }}
            className="min-h-11 w-full shrink-0 border-b border-border bg-card px-2 font-mono text-[11px] text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:min-h-9"
          />
          <ul
            id={listId}
            role="listbox"
            aria-label={t("dirPicker.listAria")}
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            {rows.map((row, index) => {
              const selected = row.kind === "known" && row.value === chosen;
              return (
                <li
                  key={row.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-directory-option={row.value}
                  data-directory-active={index === activeIndex ? "true" : undefined}
                  onClick={() => commit(row.value)}
                  onMouseEnter={() => setActive(index)}
                  /* The highlight has to be obvious to someone travelling by
                     keyboard, so it takes the accent fill; the chosen row keeps
                     the accent bar, the check and its own label. */
                  className={`flex min-h-11 cursor-pointer items-center gap-2 border-l-2 px-2 py-1.5 sm:min-h-9 ${
                    index === activeIndex ? "bg-accent-soft" : ""
                  } ${selected ? "border-accent" : "border-transparent"}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-all font-mono text-[11px] leading-4">
                      <PathText dir={row.value} />
                    </span>
                    {row.kind === "typed" ? (
                      <span className="text-caption font-semibold text-accent">{t("dirPicker.useTyped")}</span>
                    ) : null}
                    {selected ? <span className="text-caption font-semibold text-accent">{t("dirPicker.current")}</span> : null}
                  </span>
                  {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden /> : null}
                </li>
              );
            })}
            {rows.length ? null : (
              <li role="presentation" className="px-2 py-2 text-[11px] leading-4 text-muted">
                {known.length ? t("dirPicker.noMatch") : t("dirPicker.noneKnown")}
              </li>
            )}
          </ul>
          <p aria-live="polite" className="shrink-0 border-t border-border px-2 py-1 text-caption text-muted">
            {t("dirPicker.count", { shown: rows.filter((row) => row.kind === "known").length, total: known.length })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
