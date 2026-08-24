import { agentRegistry, RegistryReadError, type RegistryFile } from "@/lib/agent/registry";
import type { BoardMutationV1 } from "@/lib/board/mutations";
import { mutateBoard, patchBoard } from "@/lib/board/store";
import { validateBoardPatchPayload } from "@/lib/board/validation";

interface BoardCommandDependencies {
  patchBoard: typeof patchBoard;
  mutateBoard: typeof mutateBoard;
  registrySnapshot(): RegistryFile;
}

const productionDependencies: BoardCommandDependencies = {
  patchBoard,
  mutateBoard,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
};

function mutationsWithConversationAliases(
  mutations: readonly BoardMutationV1[],
  registrySnapshot: () => RegistryFile,
): BoardMutationV1[] {
  const mentionedPaths = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.kind === "close" || mutation.kind === "restore") mentionedPaths.add(mutation.path);
    if (mutation.kind === "reconcile-roots") {
      for (const pathname of mutation.roots) mentionedPaths.add(pathname);
    }
    if (mutation.kind === "remap-paths") {
      for (const pair of mutation.pairs) {
        mentionedPaths.add(pair.from);
        mentionedPaths.add(pair.to);
      }
    }
  }
  if (mentionedPaths.size === 0) return [...mutations];

  let snapshot: RegistryFile;
  try {
    snapshot = registrySnapshot();
  } catch (error) {
    if (error instanceof RegistryReadError) return [...mutations];
    throw error;
  }

  const excludedByConversation = new Map<string, Set<string>>();
  const excludedPaths = new Set<string>();
  for (const conversation of Object.values(snapshot.conversations)) {
    const excluded = new Set(conversation.abandonedContinuityPaths);
    if (conversation.migration && conversation.migration.phase !== "committed") {
      for (const pathname of conversation.migration.pendingContinuityPaths) excluded.add(pathname);
    }
    excludedByConversation.set(conversation.id, excluded);
    for (const pathname of excluded) excludedPaths.add(pathname);
  }
  for (const cleanup of Object.values(snapshot.pendingSuccessorCleanups)) {
    const excluded = excludedByConversation.get(cleanup.conversationId);
    if (!excluded) continue;
    for (const pathname of [...cleanup.receipt.continuityPaths, cleanup.receipt.path]) {
      excluded.add(pathname);
      excludedPaths.add(pathname);
    }
  }

  const safeMutations = mutations.map((mutation): BoardMutationV1 => {
    if (mutation.kind === "reconcile-roots") {
      return { ...mutation, roots: mutation.roots.filter((pathname) => !excludedPaths.has(pathname)) };
    }
    if (mutation.kind === "remap-paths") {
      return {
        ...mutation,
        pairs: mutation.pairs.filter(({ from, to }) => !excludedPaths.has(from) && !excludedPaths.has(to)),
      };
    }
    return mutation;
  });

  const suppliedRemapSources = new Set<string>();
  for (const mutation of safeMutations) {
    if (mutation.kind === "remap-paths") {
      for (const pair of mutation.pairs) suppliedRemapSources.add(pair.from);
    }
  }

  const pairs: Array<{ from: string; to: string }> = [];
  const pairedSources = new Set(suppliedRemapSources);
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.generations.length < 2) continue;
    const excludedContinuityPaths = excludedByConversation.get(conversation.id) ?? new Set<string>();
    const continuityPaths = conversation.continuityPaths.filter((pathname) => !excludedContinuityPaths.has(pathname));
    const paths = [
      ...conversation.generations.map((generation) => generation.path),
      ...continuityPaths,
    ];
    const conversationWasMentioned = paths.some((pathname) => mentionedPaths.has(pathname))
      || [...excludedContinuityPaths].some((pathname) => mentionedPaths.has(pathname));
    if (!conversationWasMentioned) continue;
    const target = conversation.generations.at(-1)?.path;
    if (!target) continue;
    for (const source of paths) {
      if (source === target || pairedSources.has(source)) continue;
      pairedSources.add(source);
      pairs.push({ from: source, to: target });
    }
  }
  return pairs.length > 0
    ? [{ kind: "remap-paths", pairs }, ...safeMutations]
    : safeMutations;
}

export function applyBoardCommand(
  input: unknown,
  overrides: Partial<BoardCommandDependencies> = {},
): ReturnType<typeof patchBoard> {
  const dependencies = { ...productionDependencies, ...overrides };
  const payload = validateBoardPatchPayload(input);
  return payload.mutations
    ? dependencies.mutateBoard(
        payload.project,
        payload.baseRevision,
        mutationsWithConversationAliases(payload.mutations, dependencies.registrySnapshot),
      )
    : dependencies.patchBoard(payload.project, payload.baseRevision, payload.patch!);
}
