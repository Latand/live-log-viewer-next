/**
 * Whether the mobile full-map button should show (issue #136 finding 3).
 *
 * The map is the only place a collapsed origin's per-origin minimap dot can be
 * seen, and after worker collapse a common board is one visible root plus several
 * worker stacks. So collapsed worker stacks count toward map availability — not
 * only having more than one navigable node.
 */
export function mapReachable(nodeCount: number, workerStackCount: number): boolean {
  return nodeCount > 1 || workerStackCount > 0;
}
