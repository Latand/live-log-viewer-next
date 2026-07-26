import type { FocusFrameIndex, NamedFrame } from "@/lib/attention/resolve";
import type { FocusRect } from "@/lib/attention/types";
import { cleanTitle } from "@/lib/title";

import type { SchemeLayout, SchemeRect } from "./layout";

/**
 * The board's side of #688's target resolution: one read-only view of the
 * current layout, keyed by the anchor keys the typed targets already name.
 *
 * The layout is the source of every frame — nothing here computes geometry, it
 * only exposes what `buildSchemeLayout` produced under the keys
 * `focusTargetAnchorKeys` asks for. Kept as a plain function of a layout so the
 * resolution it feeds stays testable without a renderer or a camera.
 */

/** Exactly the parts of a scheme layout a focus frame comes from. */
export type FocusLayoutSlice = Pick<SchemeLayout, "byPath" | "groups" | "nodes">;

const toFocusRect = (rect: SchemeRect): FocusRect => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });

export interface FocusFrameIndexOptions {
  /** Rects the board owns outside `byPath` — unplaced task cards, most of all,
      which the board positions on its own lattice. Same map the spatial
      navigation already passes around. */
  extraRects?: ReadonlyMap<string, SchemeRect>;
  /**
   * Anchor key → the layout key that actually holds it right now.
   *
   * One target needs this: a pipeline stage is a dashed placeholder slot before
   * it launches and a live conversation card afterwards. Pointing both at
   * `slot::<pipelineId>::<stageId>` here means the request never has to know
   * which of the two exists yet, and the pipeline model stays out of this file.
   */
  aliases?: ReadonlyMap<string, string>;
  boardRevision?: number | null;
}

/** Everything on the board that has a name a spoken sentence can borrow. */
function namedFrames(layout: FocusLayoutSlice): NamedFrame[] {
  return [
    ...layout.nodes.map((node) => ({
      key: node.file.path,
      label: cleanTitle(node.file.title, 60),
      rect: toFocusRect(node),
    })),
    ...layout.groups.map((group) => ({
      key: group.key,
      label: cleanTitle(group.label, 60),
      rect: toFocusRect(group),
    })),
  ].filter((frame) => frame.label.length > 0);
}

export function buildFocusFrameIndex(
  layout: FocusLayoutSlice,
  project: string,
  options: FocusFrameIndexOptions = {},
): FocusFrameIndex {
  const groups = new Map(layout.groups.map((group) => [group.key, toFocusRect(group)] as const));
  const named = namedFrames(layout);

  const lookup = (key: string): FocusRect | null => {
    const placed = layout.byPath.get(key);
    if (placed) return toFocusRect(placed);
    const group = groups.get(key);
    if (group) return group;
    const extra = options.extraRects?.get(key);
    return extra ? toFocusRect(extra) : null;
  };

  return {
    project,
    boardRevision: options.boardRevision ?? null,
    named,
    rectFor: (anchorKey) => lookup(anchorKey) ?? (() => {
      const alias = options.aliases?.get(anchorKey);
      return alias ? lookup(alias) : null;
    })(),
  };
}
