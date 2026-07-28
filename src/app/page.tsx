import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { Viewer } from "@/components/Viewer";

/**
 * The server render is where the browser gets its operator credential (#691).
 *
 * Operator-only actions need possession of the capability, not a request that merely
 * looks like it came from the Viewer — a local process can write `sec-fetch-site` and
 * `Origin` freely. A browser can only hold a server secret if the server hands it
 * over, and the page it renders is the one channel that reaches this browser and no
 * agent's HTTP client.
 */
export default function Home() {
  let operatorCredential: string | null = null;
  try {
    operatorCredential = ensureOperatorSpawnCapability();
  } catch {
    /* No capability on disk (unwritable state dir): the Viewer still renders and
       reads fine, and operator-only actions refuse with a clear message rather than
       the page failing to load. */
  }
  return <Viewer operatorCredential={operatorCredential} />;
}
