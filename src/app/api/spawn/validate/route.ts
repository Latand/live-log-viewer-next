import { NextRequest } from "next/server";

import { executeSpawnAdmissionValidation } from "@/lib/agent/spawnAdmissionValidation";
import { productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = Object.assign(
  async (req: NextRequest) => await executeSpawnAdmissionValidation(req),
  {
    withDependencies: executeSpawnAdmissionValidation,
    productionDependencies: productionSpawnCommandDependencies,
  },
);
