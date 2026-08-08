import { loadFlows, saveFlows } from "@/lib/flows/store";

const [cwd, id] = process.argv.slice(2);
if (!cwd || !id) throw new Error("project-directory child arguments are required");
const flows = loadFlows();
const seed = flows[0];
if (!seed) throw new Error("project-directory child requires one seed flow");
flows.push({ ...seed, id, cwd, implementerPath: `/${id}.jsonl` });
saveFlows(flows);
