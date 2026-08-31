import type { AgentRegistryEntry, RegistryFile, SpawnReceipt } from "./registry";
import { sessionKeyId } from "./sessionKey";

type IdentityMaterializationSnapshot = Pick<
  RegistryFile,
  "receipts" | "entries" | "conversations" | "conversationAliases"
>;

export type IdentityMaterializationReceipt = Pick<
  SpawnReceipt,
  "transport" | "state" | "key" | "artifactPath" | "purpose" | "resumeSourcePath"
>;

type IdentityMaterializationOptions = {
  structured?: boolean;
  entry?: Pick<AgentRegistryEntry, "structuredHost" | "structuredHostOperationId">;
};

export interface IdentityMaterializationFence {
  allowsReceipt: (receipt: IdentityMaterializationReceipt, options?: IdentityMaterializationOptions) => boolean;
  allowsPath: (artifactPath: string) => boolean;
  pathForConversation: (conversationId: `conversation_${string}`) => string | null;
}

/**
 * The publication fence for a staged structured identity. The registry keeps
 * the future key and path while a host binds; external resolvers may use them
 * after finalization proves the transcript exists. A same-path resume leaves
 * the already-readable source generation resolvable while its replacement
 * receipt stays private.
 */
export function identityMaterializationFence(snapshot?: IdentityMaterializationSnapshot): IdentityMaterializationFence {
  const allowsReceipt = (receipt: IdentityMaterializationReceipt, options: IdentityMaterializationOptions = {}): boolean => {
    const entry = options.entry ?? (receipt.key ? snapshot?.entries[sessionKeyId(receipt.key)] : undefined);
    const structured = receipt.transport === "structured"
      || (receipt.transport === null
        && (options.structured === true
          || Boolean(entry?.structuredHost)
          || typeof entry?.structuredHostOperationId === "string"));
    return !structured || receipt.state === "completed";
  };
  const withheldPaths = new Set<string>();
  if (snapshot) {
    for (const receipt of Object.values(snapshot.receipts)) {
      if (!receipt.artifactPath || allowsReceipt(receipt)) continue;
      if (receipt.purpose === "resume-successor" && receipt.resumeSourcePath === receipt.artifactPath) continue;
      withheldPaths.add(receipt.artifactPath);
    }
  }
  return {
    allowsReceipt,
    allowsPath: (artifactPath) => !withheldPaths.has(artifactPath),
    pathForConversation: (conversationId) => {
      if (!snapshot) return null;
      const seen = new Set<string>();
      let canonicalId = conversationId;
      while (!seen.has(canonicalId)) {
        seen.add(canonicalId);
        const alias = snapshot.conversationAliases[canonicalId];
        if (!alias) break;
        canonicalId = alias;
      }
      const conversation = snapshot.conversations[canonicalId];
      return conversation?.generations.findLast((generation) => !withheldPaths.has(generation.path))?.path ?? null;
    },
  };
}
