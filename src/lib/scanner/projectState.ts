import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";

const PROJECT_STATE_FILES = ["flows.json", "workflows.json", "worktree-map.json"] as const;

export function projectResolutionStateKey(): string {
  const dir = stateDir();
  const hash = crypto.createHash("sha1");
  hash.update(dir);
  for (const name of PROJECT_STATE_FILES) {
    hash.update("\0");
    hash.update(name);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch {
      hash.update("<missing>");
    }
  }
  return hash.digest("hex");
}
