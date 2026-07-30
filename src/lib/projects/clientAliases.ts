export function canonicalClientProject(
  project: string,
  aliases: Readonly<Record<string, string>>,
): string {
  let current = project;
  const seen = new Set<string>();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current]!;
  }
  return seen.has(current) ? project : current;
}

export function remapProjectSet(
  projects: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>>,
): Set<string> {
  return new Set([...projects].map((project) => canonicalClientProject(project, aliases)));
}
