/**
 * The app's one layering scale (#1858). Every surface that paints over other
 * surfaces takes its z-index from here, by name; a raw z-index above the
 * content range anywhere else under `src/components` fails `layers.test.ts`.
 *
 * Two kinds of number exist:
 *
 * - The CONTENT range, 0 to {@link CONTENT_MAX}: the order of one surface's own
 *   children among themselves (a card's badge over its frame, the front card of
 *   a deck over the ones behind it, the attention ring lifted over a
 *   neighbour's shadow). A raw value there is fine, because it only means
 *   something inside that surface.
 * - The LAYERS below, each above the content range, from the board up to the
 *   pointer feedback drawn over everything. Their order is the contract:
 *
 *     lifted   < sticky < dock < sheet < modal < popover < overlay < toast < tooltip < feedback
 *
 * Two rules keep nested surfaces from losing to their hosts:
 *
 * 1. A menu, popover or preview renders through a portal into `document.body`
 *    at its layer, so a host's `overflow` clip or stacking context cannot trap
 *    it. A layer only orders siblings of ONE stacking context; an overlay left
 *    inside a pane competes with the pane's neighbours at the pane's own level,
 *    whatever number it carries.
 * 2. Everything opened FROM a modal sits above `modal`: a menu is a `popover`,
 *    and the image preview and dialogs opened from a sheet or a modal are an
 *    `overlay`. A menu opened inside the accounts dialog, or the picture
 *    preview opened inside the expanded conversation, therefore lands on top
 *    of it without either knowing the other.
 *
 * The kanban board's stylesheet and a few components still carry their own
 * numbers until their open pull requests merge (listed in the pull request
 * for #1858 and in `LEGACY_RAW_Z` in `layers.test.ts`). The layers are spaced
 * around them so the order holds meanwhile: the kanban full-window reader (64)
 * and stages sheet (62) sit between `sheet` and `modal`, its menus (70)
 * between `modal` and `popover`, and its receipts (80) between `overlay` and
 * `toast`.
 */

/** The top of the content range: raw values up to this are local ordering. */
export const CONTENT_MAX = 12;

export const LAYER = {
  /** A board item lifted over its siblings: an open node, a lifted task card, the new-task composer. */
  lifted: 20,
  /** A surface's own pinned chrome: sticky headers, the feed's pills, board notices, status pills. */
  sticky: 30,
  /** Floating tools and chips over the board: the tool palette, minimap, bulk bar, focus-return chip. */
  dock: 40,
  /** A panel that takes over part of the screen: phone sheets, side panels, the artifact preview pane. */
  sheet: 60,
  /** A dialog with its backdrop: search, switchboard, accounts, the expanded conversation. */
  modal: 66,
  /** Menus, popovers and dropdowns — always portalled, so above any modal they open from. */
  popover: 72,
  /** Opened from a modal or a sheet: the image preview, a stage editor over a phone sheet. */
  overlay: 76,
  /** Transient notices: task toasts, the deployment status pill. */
  toast: 84,
  /** Hover and focus hints, portalled and placed from their control like the menus. */
  tooltip: 88,
  /** Pointer feedback drawn over everything while it lasts: the drag-to-link arrow. */
  feedback: 92,
} as const;

export type Layer = keyof typeof LAYER;

/**
 * The Tailwind class of each layer. Spelled out literally so Tailwind's source
 * scan generates every one of them; `layers.test.ts` holds them equal to
 * {@link LAYER}.
 */
export const Z = {
  lifted: "z-[20]",
  sticky: "z-[30]",
  dock: "z-[40]",
  sheet: "z-[60]",
  modal: "z-[66]",
  popover: "z-[72]",
  overlay: "z-[76]",
  toast: "z-[84]",
  tooltip: "z-[88]",
  feedback: "z-[92]",
} as const satisfies Record<Layer, string>;

/** One step above a layer, for a control that must sit on the surface it belongs to. */
export function above(layer: Layer): number {
  return LAYER[layer] + 1;
}
