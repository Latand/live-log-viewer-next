import { Viewer } from "@/components/Viewer";

/**
 * Nothing sensitive may appear here.
 *
 * A previous revision rendered the operator capability into this page so the browser
 * could hold it. That handed operator authority to anything able to issue an HTTP
 * GET: the page is served anonymously, on loopback, to any local process. The
 * credential was sound and the delivery leaked it, which is worse than no credential
 * at all — it looked authenticated.
 *
 * The browser now receives it out of band (see `operatorCredential.ts`): the server
 * prints a one-time link at startup, to the terminal the operator launched it from,
 * and the credential travels in the URL FRAGMENT. Fragments are never sent to the
 * server, never logged with the request, and never appear in any response body — so
 * there is nothing here for a local process to fetch and replay.
 */
export default function Home() {
  return <Viewer />;
}
