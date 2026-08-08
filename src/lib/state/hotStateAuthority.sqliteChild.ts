import fs from "node:fs";

import { loadFlows, saveFlows } from "@/lib/flows/store";

const [resultFile, action = "read"] = process.argv.slice(2);
if (!resultFile) throw new Error("hot-state authority child result path is required");

try {
  const flows = loadFlows();
  if (action === "write" && flows[0]) {
    flows[0].stateDetail = "late-portless-write";
    saveFlows(flows);
  }
  fs.writeFileSync(resultFile, JSON.stringify({
    ok: true,
    records: flows.map((flow) => ({
      id: flow.id,
      stateDetail: flow.stateDetail,
      model: flow.roles.implementer.model,
    })),
  }));
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}
