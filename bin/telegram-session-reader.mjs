#!/usr/bin/env node
import { readValidatedTelegramSessionFiles } from "./telegram-session-validator.mjs";

const result = readValidatedTelegramSessionFiles(process.argv[2] ?? "");
if (result.status === "valid") process.stdout.write(result.connectorToken);
else process.exitCode = 1;
