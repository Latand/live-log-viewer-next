export interface SchemeWindowConfig {
  projectCap: number;
  cardsPerProject: number;
}

export const DEFAULT_SCHEME_PROJECT_CAP = 10;
export const DEFAULT_SCHEME_CARDS_PER_PROJECT = 80;

interface SchemeWindowEnv {
  LLV_SCHEME_PROJECT_CAP?: string;
  LLV_SCHEME_CARDS_PER_PROJECT?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function schemeWindowConfig(
  env: SchemeWindowEnv = process.env as SchemeWindowEnv,
): SchemeWindowConfig {
  return {
    projectCap: positiveInteger(env.LLV_SCHEME_PROJECT_CAP, DEFAULT_SCHEME_PROJECT_CAP),
    cardsPerProject: positiveInteger(env.LLV_SCHEME_CARDS_PER_PROJECT, DEFAULT_SCHEME_CARDS_PER_PROJECT),
  };
}

export interface SchemeWindowOptions<T> {
  /**
   * Entries the window may never elide (issue #942). A conversation with a
   * live host or an open turn outranks both caps: the operator is working in
   * it right now, so no corpus size and no project ordering may take its card
   * off the board. A protected entry rides along whether or not its project
   * made the visible set, and it never spends another entry's card budget —
   * liveness adds cards, it does not take them from anyone.
   */
  protect?: (entry: T) => boolean;
}

/**
 * Selects the newest configured projects and then bounds each project to its
 * configured card count. Input order is retained so the scanner's recency and
 * migration-demotion ranking remains authoritative.
 */
export function selectSchemeWindow<T>(
  ranked: readonly T[],
  projectOf: (entry: T) => string,
  config: SchemeWindowConfig = schemeWindowConfig(),
  options: SchemeWindowOptions<T> = {},
): T[] {
  const protect = options.protect;
  const protectedEntries = protect ? new Set(ranked.filter(protect)) : null;
  const visibleProjects = new Set<string>();
  for (const entry of ranked) {
    visibleProjects.add(projectOf(entry));
    if (visibleProjects.size >= config.projectCap) break;
  }
  const projectCounts = new Map<string, number>();
  return ranked.filter((entry) => {
    if (protectedEntries?.has(entry)) return true;
    const project = projectOf(entry);
    if (!visibleProjects.has(project)) return false;
    const count = projectCounts.get(project) ?? 0;
    if (count >= config.cardsPerProject) return false;
    projectCounts.set(project, count + 1);
    return true;
  });
}
