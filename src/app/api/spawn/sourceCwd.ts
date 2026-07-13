import fs from "node:fs";

import { transcriptAllowed } from "@/lib/agent/spawnParent";
import { headCwd } from "@/lib/agent/transcript";

interface SourceCwdDependencies {
  transcriptAllowed: (pathname: string) => boolean;
  readCwd: (pathname: string) => string | null;
  isDirectory: (pathname: string) => boolean;
}

const dependencies: SourceCwdDependencies = {
  transcriptAllowed,
  readCwd: (pathname) => headCwd(pathname),
  isDirectory: (pathname) => {
    try {
      return fs.statSync(pathname).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface SourceCwdStatus {
  cwd: string | null;
  cwdExists: boolean;
}

export function sourceCwdStatus(src: string | null, deps: SourceCwdDependencies = dependencies): SourceCwdStatus {
  if (!src || !deps.transcriptAllowed(src)) return { cwd: null, cwdExists: false };
  const cwd = deps.readCwd(src);
  return { cwd, cwdExists: Boolean(cwd && deps.isDirectory(cwd)) };
}
