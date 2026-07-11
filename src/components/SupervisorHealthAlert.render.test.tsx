import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SupervisorHealthAlert } from "./SupervisorHealthAlert";

test("renders an actionable alert for degraded tmux supervisor health", () => {
  const html = renderToStaticMarkup(<SupervisorHealthAlert health={{
    status: "degraded",
    code: "migration-marker-endpoint-mismatch",
    configuredTmpdir: "/tmp",
    expectedTmpdir: "/run/user/1000/agent-log-viewer",
    message: "stale migration marker",
  }} />);

  expect(html).toContain('role="alert"');
  expect(html).toContain("stale migration marker");
  expect(html).toContain("/run/user/1000/agent-log-viewer");
});

test("stays hidden while tmux supervisor health is healthy", () => {
  expect(renderToStaticMarkup(<SupervisorHealthAlert health={{ status: "healthy" }} />)).toBe("");
});
