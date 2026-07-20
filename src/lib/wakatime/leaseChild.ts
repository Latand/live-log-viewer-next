import fs from "node:fs";

import { acquireWakatimeSchedulerLease } from "./lease";

const leasePath = process.env.LLV_WAKATIME_LEASE_TEST_PATH;
const readyPath = process.env.LLV_WAKATIME_LEASE_TEST_READY;
const commandPath = process.env.LLV_WAKATIME_LEASE_TEST_COMMAND;
if (!leasePath || !readyPath || !commandPath) throw new Error("scheduler lease fixture is incomplete");

const lease = acquireWakatimeSchedulerLease(leasePath);
if (!lease) throw new Error("scheduler lease fixture could not acquire ownership");
fs.writeFileSync(readyPath, "ready\n", { mode: 0o600 });

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(commandPath)) Atomics.wait(sleepCell, 0, 0, 5);
if (fs.readFileSync(commandPath, "utf8").trim() === "release") lease.release();
