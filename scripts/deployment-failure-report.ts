#!/usr/bin/env bun
/* Renders the durable evidence behind a terminal deployment failure. Reads the
   deployment status document on stdin, exactly as the deploy driver already
   holds it, and writes the report to stdout. */
import { deploymentFailureReport } from "../src/runtime-host/deploymentFailureReport";

if (import.meta.main) {
  const raw = await Bun.stdin.text();
  let status: unknown;
  try {
    status = JSON.parse(raw) as unknown;
  } catch {
    process.stderr.write("deployment status is not readable JSON\n");
    process.exit(1);
  }
  const report = deploymentFailureReport(status);
  if (report.length > 0) process.stdout.write(`${report.join("\n")}\n`);
}
