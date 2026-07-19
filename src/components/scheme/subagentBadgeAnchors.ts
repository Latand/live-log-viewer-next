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
  right: ReadonlyMap<string, SubagentBadgeAnchor>,
): boolean {
  if (!left || left.size !== right.size) return false;
  for (const [id, anchor] of right) {
    const current = left.get(id);
    if (!current || current.x !== anchor.x || current.y !== anchor.y) return false;
  }
  return true;
}

export function createSubagentBadgeAnchorRegistry(onChange: () => void = () => undefined): SubagentBadgeAnchorRegistry {
  const byParent = new Map<string, ReadonlyMap<string, SubagentBadgeAnchor>>();
  return {
    anchorFor(parentConversationId, childConversationId) {
      return byParent.get(parentConversationId)?.get(childConversationId) ?? null;
    },
    replace(parentConversationId, anchors) {
      const owned = new Map(anchors);
      const changed = !sameAnchors(byParent.get(parentConversationId), owned);
      byParent.set(parentConversationId, owned);
      if (changed) onChange();
      return () => {
        if (byParent.get(parentConversationId) !== owned) return;
        byParent.delete(parentConversationId);
        onChange();
      };
    },
  };
}
