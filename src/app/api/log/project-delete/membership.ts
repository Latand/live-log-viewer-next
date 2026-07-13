export function projectDeletionMembershipMatches(expected: ReadonlySet<string>, current: readonly { path: string }[]): boolean {
  return expected.size === current.length && current.every((entry) => expected.has(entry.path));
}
