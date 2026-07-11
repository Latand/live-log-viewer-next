import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

export interface ViewerCandidateContainerOptions {
  uid: string;
  gid: string;
  envFile: string;
  envFileExists: boolean;
  runtimeSocket: string;
}

export function viewerCandidateDockerArgs(candidate: ViewerReleaseIdentity, options: ViewerCandidateContainerOptions): string[] {
  const endpoint = new URL(candidate.endpoint);
  const args = [
    "docker", "run", "-d", "--restart", "unless-stopped", "--name", candidate.container,
    "--label", "dev.live-log-viewer.managed=1",
    "--label", `dev.live-log-viewer.revision=${candidate.revision}`,
    "--network", "host", "--pid", "host", "--privileged", "--user", `${options.uid}:${options.gid}`,
    "-e", "HOME=/home/latand", "-e", "HOSTNAME=127.0.0.1", "-e", `PORT=${endpoint.port}`,
    "-e", "XDG_CONFIG_HOME=/home/latand/.config", "-e", "XDG_CACHE_HOME=/home/latand/.cache",
    "-e", "LLV_RUNTIME_EVENTS=1", "-e", `LLV_RUNTIME_HOST_SOCKET=${options.runtimeSocket}`,
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
