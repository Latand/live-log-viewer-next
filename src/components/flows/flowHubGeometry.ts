/** Footprint of the ⟳ flow hub, in board pixels: FlowHub renders its button
    at this height, and the band layout keeps a box this size clear of every
    card that is not one of the hub's two endpoints when it places the hub on
    the review connector (#1641). The width is the widest the button gets
    (glyph, round number and padding); a narrower one only clears more. */
export const FLOW_HUB = { w: 72, h: 34 } as const;
