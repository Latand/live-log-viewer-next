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

/**
 * Selects the newest configured projects and then bounds each project to its
 * configured card count. Input order is retained so the scanner's recency and
 * migration-demotion ranking remains authoritative.
 */
export function selectSchemeWindow<T>(
  ranked: readonly T[],
  projectOf: (entry: T) => string,
  config: SchemeWindowConfig = schemeWindowConfig(),
): T[] {
  const visibleProjects = new Set<string>();
  for (const entry of ranked) {
    visibleProjects.add(projectOf(entry));
    if (visibleProjects.size >= config.projectCap) break;
  }
  const projectCounts = new Map<string, number>();
  return ranked.filter((entry) => {
    const project = projectOf(entry);
    if (!visibleProjects.has(project)) return false;
    const count = projectCounts.get(project) ?? 0;
    if (count >= config.cardsPerProject) return false;
    projectCounts.set(project, count + 1);
    return true;
  });
}
