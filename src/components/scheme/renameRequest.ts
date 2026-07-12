/** F2-rename request state for the scheme board: which node was asked to open
    its rename editor, and a token that bumps per request so the same node
    reopens. Kept pure so the "F2 → close → plain re-expand" sequence is unit
    testable without rendering the canvas. */
export type RenameRequest = { path: string; token: number } | null;

/** Next state after F2 on `path` — a fresh token so the target overlay's
    SessionTitle reopens even for the node it last edited. */
export function requestRename(prev: RenameRequest, path: string): RenameRequest {
  return { path, token: (prev?.token ?? 0) + 1 };
}

/** Drop a consumed request once its overlay is no longer the expanded node, so a
    plain re-expand of the same node cannot replay the stale token (which would
    reopen the editor, whose Collapse blur could persist an unintended rename). */
export function clearStaleRename(prev: RenameRequest, expandedPath: string | null): RenameRequest {
  return prev && prev.path !== expandedPath ? null : prev;
}

/** The token handed to the expanded node's pane — only its own fresh request,
    never a stale one for a different (or no) node. */
export function autoEditTokenFor(request: RenameRequest, expandedPath: string | null): number | undefined {
  return request && expandedPath !== null && request.path === expandedPath ? request.token : undefined;
}
