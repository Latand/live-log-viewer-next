import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { discardWakatimeEnvironmentCredential, WAKATIME_CREDENTIAL_ENV } from "./server-runtime.mjs";
import { readStatus, serve } from "./tailscale.mjs";

afterEach(() => {
  discardWakatimeEnvironmentCredential();
});

function tailscaleProbe(): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tailscale-env-"));
  const executable = path.join(directory, "tailscale-probe");
  fs.writeFileSync(executable, `#!/bin/sh
if [ -n "\${WAKATIME_API_KEY+x}" ]; then
  echo "ambient WakaTime credential reached Tailscale" >&2
  exit 41
fi
if [ "$1" = "status" ]; then
  printf '{"BackendState":"Running","Self":{"DNSName":"viewer.tail.test."}}'
fi
`, { mode: 0o700 });
  return { directory, executable };
}

describe("published launcher auxiliary child credential isolation", () => {
  test("Tailscale status receives no ambient WakaTime credential", async () => {
    const probe = tailscaleProbe();
    discardWakatimeEnvironmentCredential();
    process.env[WAKATIME_CREDENTIAL_ENV] = ["tailscale", "status", "fixture"].join("-");
    try {
      await expect(readStatus(probe.executable)).resolves.toEqual({
        backendState: "Running",
        dnsName: "viewer.tail.test",
      });
    } finally {
      fs.rmSync(probe.directory, { recursive: true, force: true });
    }
  });

  test("Tailscale serve receives no ambient WakaTime credential", async () => {
    const probe = tailscaleProbe();
    discardWakatimeEnvironmentCredential();
    process.env[WAKATIME_CREDENTIAL_ENV] = ["tailscale", "serve", "fixture"].join("-");
    try {
      const handle = serve(probe.executable, 8898);
      const [code] = await once(handle.child, "exit");
      expect(code).toBe(0);
    } finally {
      fs.rmSync(probe.directory, { recursive: true, force: true });
    }
  });
});
