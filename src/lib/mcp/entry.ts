import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";

import { startViewerMcpServer } from "./server";

discardWakatimeEnvironmentCredential();
startViewerMcpServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
