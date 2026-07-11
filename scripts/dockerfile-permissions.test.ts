// Regression guard for #76: a umask-077 checkout tracks config files as 0600,
// Docker COPY preserves that mode while resetting ownership to root:root, and
// the UID-1000 runtime user then cannot read /app/tsconfig.json — `next start`
// crashes only once the image reaches the production health gate. The
// Dockerfile must (a) normalize modes in the build stage before the runtime
// stage copies them and (b) verify readability as the non-root runtime
// identity after the last COPY, so a bad checkout fails the build instead.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dockerfile = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");
const compose = readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8");
const runtimeStageStart = dockerfile.indexOf("AS runtime");
const buildStage = dockerfile.slice(dockerfile.indexOf("AS build"), runtimeStageStart);
const runtimeStage = dockerfile.slice(runtimeStageStart);

const normalizeMatch = buildStage.match(/^RUN chmod -R (\S+) \/app$/m);

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe("runtime image permission determinism (#76)", () => {
  test("build stage normalizes /app modes after the build, before runtime COPY --from", () => {
    expect(runtimeStageStart).toBeGreaterThan(-1);
    expect(normalizeMatch).not.toBeNull();
    const buildIndex = buildStage.indexOf("bun run build");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(buildStage.indexOf(normalizeMatch![0])).toBeGreaterThan(buildIndex);
  });

  test("the normalization spec repairs a umask-077 checkout to deterministic modes", () => {
    const spec = normalizeMatch![1];
    const root = mkdtempSync(join(tmpdir(), "llv-perm-"));
    try {
      const dir = join(root, "src");
      mkdirSync(dir);
      writeFileSync(join(root, "tsconfig.json"), "{}\n");
      writeFileSync(join(dir, "page.tsx"), "export {};\n");
      writeFileSync(join(root, "cli.mjs"), "#!/usr/bin/env node\n");
      // umask 077: non-executables land 0600, executables and dirs 0700
      chmodSync(join(root, "tsconfig.json"), 0o600);
      chmodSync(join(dir, "page.tsx"), 0o600);
      chmodSync(join(root, "cli.mjs"), 0o700);
      chmodSync(dir, 0o700);

      execFileSync("chmod", ["-R", spec, root]);

      expect(mode(join(root, "tsconfig.json"))).toBe("644");
      expect(mode(join(dir, "page.tsx"))).toBe("644");
      expect(mode(join(root, "cli.mjs"))).toBe("755");
      expect(mode(dir)).toBe("755");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime stage gates readability as the non-root user after the last COPY", () => {
    const gateIndex = runtimeStage.indexOf("runuser -u node");
    const lastCopyIndex = runtimeStage.lastIndexOf("COPY --from=build");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(lastCopyIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(lastCopyIndex);
    // The gate must sweep for unreadable files and untraversable directories,
    // and prove the exact files from the incident open as UID 1000.
    expect(runtimeStage).toContain("! -readable");
    expect(runtimeStage).toContain("-type d ! -executable");
    expect(runtimeStage).toContain("cat /app/tsconfig.json /app/next.config.ts");
  });
});

describe("runtime-host Docker credentials (#102)", () => {
  test("runtime UID 1000 retains the host Docker socket group through nsenter", () => {
    expect(compose).toContain('user: "${LLV_UID:-1000}:${LLV_GID:-1000}"');
    expect(compose).toContain('group_add:\n      - "${LLV_DOCKER_GID:-957}"');
    const wrapper = dockerfile.match(/cat > \/usr\/local\/bin\/docker <<'WRAPPER'([\s\S]*?)WRAPPER/)?.[1];
    expect(wrapper).toBeDefined();
    expect(wrapper).toContain("nsenter -t 1 -m -p --");
    expect(wrapper).toContain('/usr/bin/setpriv --reuid="$uid" --regid="$gid" --groups="$groups" --');
    expect(wrapper).not.toContain("--setgid");
    expect(wrapper).not.toContain("--setuid");
  });
});
