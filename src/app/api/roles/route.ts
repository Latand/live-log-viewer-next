import { NextResponse } from "next/server";

import { ROLE_OVERRIDES_SCHEMA_VERSION } from "@/lib/roles/store";
import { listRoles } from "@/lib/roles/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION,
    roles: listRoles().map((role) => ({ ...role, promptPreview: role.promptScaffold })),
  });
}
