import { NextResponse } from "next/server";

import { ROLE_OVERRIDES_SCHEMA_VERSION } from "@/lib/roles/store";
import { listRoles } from "@/lib/roles/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    /* Version of the overrides file this catalog was merged against, for a
       future editing UI that writes overrides back through saveRoleOverrides. */
    schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION,
    /* promptPreview duplicates promptScaffold under the name the draft pane reads. */
    roles: listRoles().map((role) => ({ ...role, promptPreview: role.promptScaffold })),
  });
}
