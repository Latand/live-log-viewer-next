"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Loader2, Search, X } from "@/components/icons";
import { useModalLayer } from "@/components/modalLayer";
import { engineBadgeFor, fmtAge } from "@/components/utils";
import { projectDisplayName } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import { snippetSegments } from "@/lib/search/snippet";

import { transcriptSearchRowKey, useTranscriptSearch, type TranscriptSearchRow } from "./useTranscriptSearch";

interface Props {
  /** Phone layout: the dialog takes the whole viewport and every control is a
      44px target. */
  mobile: boolean;
  onClose: () => void;
  /** Hands the chosen transcript to the shell, which owns navigation. The
      palette deliberately does NOT assign the hash itself: the tab can already
      be standing on the target's `#f=`, and an unchanged hash fires no
      hashchange, so a palette that navigated by assignment alone would close
      over a selection that never opened. */
  onOpen: (transcriptPath: string) => void;
}

const LIST_ID = "llv-search-results";
const OPTION_PREFIX = "llv-search-option-";

function optionId(index: number): string {
  return `${OPTION_PREFIX}${index}`;
}

/** The transcript deep link this app already speaks. Assigning it hands the
    whole open-and-continue job to Viewer's own resolver: it pins the
    transcript into the poll even beyond the capped feed, redirects an archived
    predecessor to its current generation, records the history entry, and lands
    on board focus (desktop) or MobileFocusView (phone) with the composer. */
export function transcriptFocusHash(transcriptPath: string): string {
  return "#f=" + encodeURIComponent(transcriptPath);
}

function CorpusLine({ messages, conversations }: { messages: number; conversations: number }) {
  const { locale, t } = useLocale();
  const format = (value: number) => value.toLocaleString(locale === "uk" ? "uk-UA" : "en-US");
  return (
    <div className="mt-1.5 text-[11.5px] text-muted" data-search-corpus>
      {t("search.corpus", {
        messages: t("search.corpusMessages", { count: messages, formatted: format(messages) }),
        conversations: t("search.corpusConversations", { count: conversations, formatted: format(conversations) }),
      })}
    </div>
  );
}

function Snippet({ snippet }: { snippet: string }) {
  return (
    <>
      {snippetSegments(snippet).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-[3px] bg-accent-soft px-0.5 text-accent" data-search-match>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The one global "find my messages" surface (issue #1054).
 *
 * Mounted by the shell rather than by a board, so it is the same surface on the
 * overview, inside any project and on the phone. It defaults to the operator's
 * OWN messages (`speaker=user`), searches every project at once, and hands a
 * selected row straight to the app's existing deep-link resolver — no second
 * navigation mechanism, and the conversation lands ready to continue.
 */
export function GlobalSearch({ mobile, onClose, onOpen }: Props) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  /* "My messages" is the primary mode and it resets on every open: a widened
     scope that silently persisted would answer the next question wrongly. */
  const [mine, setMine] = useState(true);
  const speaker = mine ? ("user" as const) : undefined;
  const search = useTranscriptSearch({ query, speaker });

  /* The active option is scoped to the result set it was chosen in, so a
     refinement starts back at the top without a state-syncing effect. */
  const scope = `${mine} ${query}`;
  const [activeOption, setActiveOption] = useState({ scope, index: 0 });
  const optionCount = search.items.length + (search.nextCursor ? 1 : 0);
  const activeIndex = optionCount
    ? Math.min(activeOption.scope === scope ? activeOption.index : 0, optionCount - 1)
    : -1;
  const moveActive = (index: number) => setActiveOption({ scope, index });

  useModalLayer({ containerRef, onClose });

  useEffect(() => {
    /* The dialog itself takes focus first (modal layer), so the caret is put in
       the field on the next tick — the Switchboard's idiom. */
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`#${optionId(activeIndex)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const openResult = useCallback((item: TranscriptSearchRow) => {
    /* Held rows stay readable through a refinement, but they answer the
       PREVIOUS query or scope. Opening one would leave the search in progress
       for a conversation the operator did not ask for — and just after an
       Everything → My flip, a held row can be the agent's message rather than
       one of their own. The rows say so (`aria-disabled`, dimmed) and the
       header says a newer answer is coming; this is the one gate that makes
       the refusal true for both the click and the Enter path. */
    if (search.stale) return;
    onClose();
    onOpen(item.transcriptPath);
  }, [search.stale, onClose, onOpen]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const item = search.items[activeIndex];
      if (item) openResult(item);
      else if (activeIndex >= 0) search.loadMore();
      return;
    }
    if (!optionCount) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(Math.min(activeIndex + 1, optionCount - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveActive(optionCount - 1);
    }
  };

  const trimmed = query.trim();
  const target = mobile ? "min-h-11" : "";
  const rowActive = (index: number) => index === activeIndex;

  /* One control, two homes: the design note's header slot on desktop, its own
     row on the phone (see below). Declared once so the two placements cannot
     drift apart. */
  const speakerToggle = (
    <div
      role="radiogroup"
      aria-label={t("search.speakerAria")}
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-canvas p-0.5"
    >
      {([true, false] as const).map((value) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={mine === value}
          data-search-scope={value ? "mine" : "everything"}
          onClick={() => setMine(value)}
          className={`rounded-full px-2.5 text-[11.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            mine === value ? "bg-accent/10 text-accent" : "text-muted hover:text-primary"
          } ${mobile ? "min-h-11" : "h-7"}`}
        >
          {value ? t("search.mine") : t("search.everything")}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex bg-primary/28"
      onMouseDown={onClose}
      data-global-search-backdrop
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("search.aria")}
        data-global-search
        onMouseDown={(event) => event.stopPropagation()}
        className={
          mobile
            ? "flex h-full w-full flex-col overflow-hidden bg-canvas outline-none"
            : "m-auto flex max-h-[min(72vh,720px)] w-full max-w-[720px] flex-col overflow-hidden rounded-[8px] border border-border bg-canvas shadow-2 outline-none"
        }
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          {mobile ? null : <div className="shrink-0 text-[13px] font-bold">{t("search.title")}</div>}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
            role="combobox"
            aria-expanded
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            data-search-input
            className={`min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11" : "h-9"}`}
          />
          {mobile ? null : speakerToggle}
          <button
            type="button"
            aria-label={t("search.close")}
            onClick={onClose}
            data-search-close
            className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${mobile ? "h-11 w-11" : "h-8 w-8"}`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        {/* The phone is the one deviation from the design note's single header
            row: at 390px the header already spends 44px on the field and 44px
            on close, and a two-segment scope control beside them leaves the
            input unusable. It gets its own full-width row so both segments keep
            their 44px targets. */}
        {mobile ? (
          <div className="flex shrink-0 items-center border-b border-border bg-card px-3 py-1.5">{speakerToggle}</div>
        ) : null}

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!trimmed ? (
            <div className="pt-[12vh] text-center" data-search-hint>
              <div className="text-[13px] font-semibold text-muted">{t("search.hint")}</div>
              {mobile ? null : <div className="mt-1.5 text-[11.5px] text-muted">{t("search.keysHint")}</div>}
            </div>
          ) : null}

          {trimmed && search.loading && !search.items.length ? (
            <div className="flex items-center justify-center gap-2 pt-[12vh] text-[13px] font-semibold text-muted" data-search-loading>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loading")}
            </div>
          ) : null}

          {trimmed && search.items.length ? (
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[13px] font-bold">{t("search.results")}</h2>
              <span className="text-[11px] font-semibold text-muted" data-search-total>{search.total}</span>
              {/* A refinement holds the rows already on screen, so the header
                  is what says a newer answer is coming. */}
              {search.loading ? (
                <span className="text-[11px] font-semibold text-muted" data-search-updating>{t("search.updating")}</span>
              ) : null}
            </div>
          ) : null}

          <div
            id={LIST_ID}
            role="listbox"
            aria-label={t("search.title")}
            aria-busy={search.stale || undefined}
            data-search-stale={search.stale ? "" : undefined}
            className={`space-y-1.5 ${search.stale ? "opacity-60" : ""}`}
          >
            {search.items.map((item, index) => {
              const badge = engineBadgeFor(item.engine);
              return (
                <button
                  key={transcriptSearchRowKey(item)}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={rowActive(index)}
                  aria-disabled={search.stale || undefined}
                  tabIndex={-1}
                  data-search-result={item.transcriptPath}
                  onClick={() => openResult(item)}
                  className={`flex w-full min-w-0 flex-col gap-1 rounded-[8px] border bg-card px-3 py-2 text-left shadow-1 focus-visible:outline-none ${target} ${
                    search.stale ? "cursor-default" : "hover:border-accent/40 hover:bg-canvas"
                  } ${rowActive(index) ? "border-accent/40 bg-canvas ring-2 ring-accent/40" : "border-border"}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-primary">
                      {item.title ?? t("search.untitled")}
                    </span>
                    <span
                      className="max-w-[180px] shrink-0 truncate rounded-full border border-border bg-canvas px-2 py-0.5 text-[10.5px] font-semibold text-muted"
                      title={item.project}
                    >
                      {projectDisplayName(item.project)}
                    </span>
                    <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>{badge.label}</span>
                    {item.timestamp === null ? null : (
                      <span className="shrink-0 text-[10.5px] text-muted">{fmtAge(item.timestamp)}</span>
                    )}
                  </span>
                  <span className="line-clamp-2 text-[11.5px] text-muted">
                    {/* Keyed to the scope these rows were ANSWERED under: the
                        toggle can already have moved to «my messages» while
                        the agent's rows are still the ones on screen, and a
                        row that drops its chip in that window claims to be
                        the operator's own message. */}
                    {search.answeredSpeaker ? null : (
                      <span className="mr-1 rounded-[3px] border border-border px-1 text-[10px] font-bold text-muted">
                        {item.speaker === "user" ? t("search.speaker.you") : t("search.speaker.agent")}
                      </span>
                    )}
                    <Snippet snippet={item.snippet} />
                  </span>
                </button>
              );
            })}
            {search.nextCursor ? (
              <button
                id={optionId(search.items.length)}
                type="button"
                role="option"
                aria-selected={rowActive(search.items.length)}
                tabIndex={-1}
                disabled={search.loading}
                onClick={search.loadMore}
                data-search-more
                className={`flex min-h-11 w-full items-center justify-center rounded-[8px] border bg-card px-4 text-[12.5px] font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none disabled:opacity-60 ${
                  rowActive(search.items.length) ? "border-accent/40 ring-2 ring-accent/40" : "border-border"
                }`}
              >
                {search.loading ? t("common.loading") : t("search.loadMore")}
              </button>
            ) : null}
          </div>

          {trimmed && !search.loading && !search.error && !search.items.length ? (
            <div className="pt-[12vh] text-center" data-search-empty>
              <div className="text-[13px] font-semibold text-muted">{t("search.none", { query: trimmed })}</div>
              {/* A zero answer has to be trustworthy, so it names the corpus it
                  just searched instead of leaving "nothing" ambiguous. */}
              {search.stats ? (
                <CorpusLine
                  messages={search.stats.messagesIndexed}
                  conversations={search.stats.conversationsIndexed}
                />
              ) : null}
              {mine ? (
                <button
                  type="button"
                  onClick={() => setMine(false)}
                  data-search-widen
                  className="mt-3 inline-flex min-h-11 items-center rounded-[8px] border border-border bg-card px-4 text-[12.5px] font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {t("search.everythingInstead")}
                </button>
              ) : null}
            </div>
          ) : null}

          {search.error ? (
            <div className="flex min-h-11 items-center justify-center gap-3 pt-4 text-[13px] font-semibold text-danger" data-search-error>
              <span>{t("search.failed")}</span>
              <button
                type="button"
                onClick={search.retry}
                data-search-retry
                className="min-h-11 rounded-[8px] border border-border bg-card px-4 font-bold text-primary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t("search.retry")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
