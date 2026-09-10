export interface SubagentBadgeAnchor {
  x: number;
  y: number;
}

export interface SubagentBadgeAnchorRegistry {
  anchorFor(parentConversationId: string, childConversationId: string): SubagentBadgeAnchor | null;
  replace(parentConversationId: string, anchors: ReadonlyMap<string, SubagentBadgeAnchor>): () => void;
}

function sameAnchors(
  left: ReadonlyMap<string, SubagentBadgeAnchor> | undefined,
  right: ReadonlyMap<string, SubagentBadgeAnchor> | undefined,
): boolean {
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  if (!right) return true;
  for (const [id, anchor] of right) {
    const current = left?.get(id);
    if (!current || current.x !== anchor.x || current.y !== anchor.y) return false;
  }
  return true;
}

export function createSubagentBadgeAnchorRegistry(onChange: () => void = () => undefined): SubagentBadgeAnchorRegistry {
  type Anchors = ReadonlyMap<string, SubagentBadgeAnchor>;
  type Owners = Map<symbol, Anchors>;
  const byParent = new Map<string, Owners>();
  const current = (owners: Owners | undefined): Anchors | undefined => {
    let anchors: Anchors | undefined;
    for (const candidate of owners?.values() ?? []) anchors = candidate;
    return anchors;
  };
  return {
    anchorFor(parentConversationId, childConversationId) {
      return current(byParent.get(parentConversationId))?.get(childConversationId) ?? null;
    },
    replace(parentConversationId, anchors) {
      // One conversation can appear in several task bands. Each mounted copy
      // owns its registration; removing the latest copy restores the remaining one.
      const owners = byParent.get(parentConversationId) ?? new Map<symbol, Anchors>();
      const owner = Symbol();
      const owned = new Map(anchors);
      const changed = !sameAnchors(current(owners), owned);
      owners.set(owner, owned);
      byParent.set(parentConversationId, owners);
      if (changed) onChange();
      return () => {
        const previous = current(owners);
        if (!owners.delete(owner)) return;
        if (!owners.size) byParent.delete(parentConversationId);
        if (!sameAnchors(previous, current(owners))) onChange();
      };
    },
  };
}
