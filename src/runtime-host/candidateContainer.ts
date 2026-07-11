import fs from "node:fs";
import path from "node:path";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

export interface ViewerCandidateContainerOptions {
  uid: string;
  gid: string;
  envFile: string;
  envFileExists: boolean;
  runtimeSocket: string;
  legacyTmuxExternal: string;
  tmuxTmpdir: string;
  transcribeBackend: string;
}

export function viewerCandidateTmuxEnvironment(
  stateDir: string,
  uid: string,
  exists: (filename: string) => boolean = fs.existsSync,
): Pick<ViewerCandidateContainerOptions, "legacyTmuxExternal" | "tmuxTmpdir"> {
  const migrationComplete = exists(path.join(stateDir, "legacy-tmux-migration-complete"));
  return migrationComplete
    ? { legacyTmuxExternal: "1", tmuxTmpdir: `/run/user/${uid}/agent-log-viewer` }
    : { legacyTmuxExternal: "0", tmuxTmpdir: "/tmp" };
}

export function viewerCandidateDockerArgs(candidate: ViewerReleaseIdentity, options: ViewerCandidateContainerOptions): string[] {
  const endpoint = new URL(candidate.endpoint);
  const args = [
    "docker", "run", "-d", "--restart", "unless-stopped", "--name", candidate.container,
    "--label", "dev.live-log-viewer.managed=1",
    "--label", `dev.live-log-viewer.revision=${candidate.revision}`,
    "--network", "host", "--pid", "host", "--privileged", "--user", `${options.uid}:${options.gid}`,
    "-e", "HOME=/home/latand", "-e", "HOSTNAME=127.0.0.1", "-e", `PORT=${endpoint.port}`,
    "-e", "PATH=/usr/local/bin:/home/latand/.bun/bin:/home/latand/.npm-global/bin:/home/latand/.local/bin:/usr/bin:/bin",
    "-e", "XDG_CONFIG_HOME=/home/latand/.config", "-e", "XDG_CACHE_HOME=/home/latand/.cache",
    "-e", "HF_HOME=/home/latand/.cache/huggingface", "-e", "LLV_WHISPER_VENV=/opt/llv-whisper-venv",
    "-e", `LLV_TRANSCRIBE_BACKEND=${options.transcribeBackend}`, "-e", "LLV_DOCKER_NSENTER_SHIMS=1",
    "-e", "GIT_SSH_COMMAND=ssh -F /home/latand/.ssh/config -o UserKnownHostsFile=/home/latand/.ssh/known_hosts -o IdentityFile=/home/latand/.ssh/id_ed25519",
    "-e", "LLV_RUNTIME_EVENTS=1", "-e", `LLV_RUNTIME_HOST_SOCKET=${options.runtimeSocket}`,
    "-e", `LLV_LEGACY_TMUX_EXTERNAL=${options.legacyTmuxExternal}`, "-e", `TMUX_TMPDIR=${options.tmuxTmpdir}`,
    "-v", "/home/latand:/home/latand", "-v", `/tmp/tmux-${options.uid}:/tmp/tmux-${options.uid}`, "-v", `/tmp/claude-${options.uid}:/tmp/claude-${options.uid}`,
  ];
  if (options.envFileExists) args.push("--env-file", options.envFile);
  args.push(candidate.image);
  return args;
}

export function obsoleteManagedViewerContainers(containers: string[], keep: string[]): string[] {
  const retained = new Set(keep);
  return [...new Set(containers)].filter((container) => !retained.has(container));
}
