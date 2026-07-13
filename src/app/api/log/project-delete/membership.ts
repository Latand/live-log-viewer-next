/** The registered snapshot must cover exactly the requested paths before a project-wide delete may proceed. */
export function projectDeletionMembershipMatches(expected: ReadonlySet<string>, current: readonly { path: string }[]): boolean {
  return expected.size === current.length && current.every((entry) => expected.has(entry.path));
}
