import { createTranscriptHostResolver } from "@/lib/agent/transcriptHost";
import { procBackend } from "@/lib/proc";
import { agentProcesses, pidAlive, readArgv, readPpid } from "@/lib/scanner/process";
import { panePidMap, panePidOf, rememberResumePane, resumePaneRecords, sendText, spawnAgentWithPrompt, tmuxServerPid } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import type { SnapshotRequestV1, ViewerSnapshotV1 } from "./types";

export async function resolveSiblings(caller: SnapshotRequestV1["caller"], files: FileEntry[]): Promise<ViewerSnapshotV1["siblings"]> {
  if (!caller) return { selfResolution: "omitted", agents: [] };
  const observationResolver = createTranscriptHostResolver({
    listFiles: async () => files,
    panes: panePidMap,
    ppidMap: () => procBackend.ppidMap(),
    agents: agentProcesses,
    serverPid: tmuxServerPid,
    resumeRecords: resumePaneRecords,
    panePid: panePidOf,
    alive: pidAlive,
    argv: readArgv,
    parentPid: readPpid,
    identity: () => null,
    spawn: spawnAgentWithPrompt,
    remember: rememberResumePane,
    deliver: sendText,
  });
  const hosts = await observationResolver.readTranscriptHosts();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const seed = caller.transcriptPath ? hosts.canonicalFor(caller.transcriptPath) : hosts.hosts.find((host) => host.agentPid === caller.pid);
  if (!seed) return { selfResolution: "unmatched", agents: [] };
  const agents = hosts.hosts.filter((host) => host.cwd === seed.cwd && host.primaryPath !== null).map((host) => {
    const file = host.primaryPath ? byPath.get(host.primaryPath) : undefined;
    return { transcriptPath: host.primaryPath!, engine: host.engine, project: file?.project ?? null, title: file?.title ?? null, activity: file?.activity ?? null, pid: host.agentPid, self: host.agentPid === caller.pid || host.primaryPath === caller.transcriptPath };
  });
  return { selfResolution: agents.some((agent) => agent.self) ? "matched" : "unmatched", agents };
}
