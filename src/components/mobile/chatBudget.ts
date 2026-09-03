/**
 * The phone's viewport budget, rewritten for mobile v2
 * (docs/design/mobile-v2/README.md §3.4).
 *
 * The old model (issue #419) counted five persistent rows — shell header,
 * focus strip, conversation header, composer input row, composer pill row —
 * and proved the transcript kept 60% of an 844 px viewport. The arithmetic was
 * green while the operator's phone showed roughly half the screen as chrome,
 * because four rows that are ALSO always on were never in the sum: the docked
 * background-task strip, the attention banner, the subagent tray, and the
 * live-tail pill with the turn status bar under it (§1.6). A budget that omits
 * what is on screen measures nothing.
 *
 * v2 removes the omissions instead of counting them. Host detail moved behind
 * `⋯ › Host details`, the conversation header folded into the bar's title cell,
 * the strip is gone, and the composer, its model chip and the Stop control are
 * ONE unit (§2 rule 8) — so the band is two regions, and every region left in
 * it is one this module can name:
 *
 *   bar 52 + composer 109                    = 161 px  (81% transcript at 844)
 *   … + the banner slot 45                   = 206 px  (76%)
 *   … + suggested chips 32, keyboard 336     = 193 px of 508 visible (62%)
 *
 * Those are the three numbers §3.4 publishes, and `chatBudget.test.ts` is what
 * holds them. `MobileFocusView` stamps {@link MIN_TRANSCRIPT_SHARE} onto the
 * focus root, so the contract travels with the DOM it governs.
 */

/** The one bar (§3.2): back, title cell, at most three 44 px targets. */
export const BAR_PX = 52;
/** The composer unit (§2 rule 8, §3.4): one box holding the field (32) and the
    tools row (44) — chip, attach, dictate, send slot — plus its padding and the
    14 px home inset. The inset lives INSIDE this number, which is why the
    budget below subtracts no safe-area of its own. This is the unit at REST;
    `MOBILE_COMPOSER_UNIT_CHROME_PX` in `lib/composerScroll` is the same box
    counted from the other side — everything in these 109 px except the field —
    and it is what the grow ceiling reserves so a dictated field never pushes
    the tools row out of the box (#1483). */
export const COMPOSER_PX = 109;
/** The one banner slot under the bar (§2 rule 3): offline, degraded, or a
    decision that arrived elsewhere. It reserves its height in flow, so it is
    chrome for as long as it is up. */
export const BANNER_PX = 45;
/** Suggested-reply chips, 32 px visual inside a 44 px hit, directly above the
    composer box (§4.3). They stay while the keyboard is open. */
export const SUGGESTED_CHIPS_PX = 32;
/** An iOS keyboard's share of a 390×844 phone (#983, §4.3). */
export const KEYBOARD_PX = 336;

/** Persistent chrome with a conversation focused: everything always on screen. */
export const PERSISTENT_CHROME = {
  bar: BAR_PX,
  composer: COMPOSER_PX,
} as const;

/**
 * The band v2 replaced, region by region (§3.4, "Today" column). These are the
 * five rows the #419 budget counted — 264 px — and they are kept here because
 * the surfaces that were measured against one of them still are: the retired
 * chip strip's 56 px is the ceiling the orchestrator pin must not exceed
 * (#1347), and a number cannot be a ceiling once nobody can name it.
 */
export const SUPERSEDED_CHROME = {
  /** Project shell header → the one 52 px bar. */
  shellHeader: 52,
  /** Conversation-switch strip → the bar's title cell and the switcher sheet. */
  focusStrip: 56,
  /** BranchPane's compact header row → folded into the title cell. */
  conversationHeader: 56,
  /** Composer input row → the composer unit's field. */
  composerPrimary: 56,
  /** The always-visible model/reasoning pill row (#499) → the chip INSIDE the
      box, which is the row the operator asked us to stop stacking. */
  composerRuntimePill: 44,
} as const;

/**
 * Persistent rows the old budget never counted (§1.6) — the difference between
 * "264 budgeted" and the "~440–480 observed" on the operator's screenshot.
 * Every one of them is 0 px in v2: tasks live in the host sheet, children open
 * from the feed, Stop is the send slot and elapsed time is the bar's meta line.
 * The arrival banner is the only survivor, at the slot's 45 px rather than 60,
 * and only while it is up.
 */
export const UNCOUNTED_CHROME = {
  /** One docked `TaskStrip` per parentless background process (§1.2). */
  dockedTaskStrip: 44,
  /** The in-flow attention toast (§1.9). */
  attentionBanner: 60,
  /** The inline subagent tray (§1.6). */
  subagentTray: 44,
  /** The live-tail pill plus the turn status bar (§1.6) — this lane's removal. */
  liveTailAndStatusBar: 40,
} as const;

/** The transcript's guaranteed share of the viewport, keyboard closed. The
    worst persistent case is the banner slot up (206 px of 844 = 76%), so the
    floor is what that case clears — a full 15 points above the #419 contract. */
export const MIN_TRANSCRIPT_SHARE = 0.75;
/** The same guarantee with the keyboard open (§4.3): 315 px of the 508 that are
    visible, with the whole question card inside them. */
export const MIN_KEYBOARD_TRANSCRIPT_SHARE = 0.6;

export interface Viewport {
  /** Layout viewport height in CSS px (844 at iPhone 390×844). */
  height: number;
  /** The banner slot is showing something (offline, degraded, an arrival). */
  banner?: boolean;
  /** Suggested-reply chips ride above the composer box. */
  chips?: boolean;
  /** The on-screen keyboard's height, 0 (the default) while it is closed. */
  keyboard?: number;
}

export interface ChatBudget {
  /** Viewport height minus whatever the keyboard covers. */
  readonly usable: number;
  /** Every region of chrome on screen, summed. */
  readonly chrome: number;
  /** Height left for the transcript, never negative. */
  readonly transcript: number;
  /** transcript / usable, clamped to [0, 1]. */
  readonly share: number;
  /** True when the transcript clears the guarantee for this keyboard state. */
  readonly meetsMinimum: boolean;
}

/** The transcript's height and share for one viewport and its chrome. */
export function chatBudget({ height, banner = false, chips = false, keyboard = 0 }: Viewport): ChatBudget {
  const usable = Math.max(0, height - Math.max(0, keyboard));
  const chrome = BAR_PX + COMPOSER_PX + (banner ? BANNER_PX : 0) + (chips ? SUGGESTED_CHIPS_PX : 0);
  const transcript = Math.max(0, usable - chrome);
  const share = usable > 0 ? Math.min(1, transcript / usable) : 0;
  const floor = keyboard > 0 ? MIN_KEYBOARD_TRANSCRIPT_SHARE : MIN_TRANSCRIPT_SHARE;
  return { usable, chrome, transcript, share, meetsMinimum: share >= floor };
}
