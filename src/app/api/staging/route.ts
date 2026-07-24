import fs from "node:fs";

import { NextResponse } from "next/server";

import { statePath } from "@/lib/configDir";
import { isStagingMode, STAGING_RELEASE_FILE, stagingReleaseRecord } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StagingIdentity {
  staging: boolean;
  revision: string | null;
  deployedAt: string | null;
  endpoint: string | null;
}

/** The instance's own staging identity: drives the UI badge and lets a stage
    deploy verify which revision the staging port actually serves. */
export function GET(): NextResponse<StagingIdentity> {
  const headers = { "Cache-Control": "no-store" };
  if (!isStagingMode()) {
    return NextResponse.json({ staging: false, revision: null, deployedAt: null, endpoint: null }, { headers });
  }
  try {
    const record = stagingReleaseRecord(JSON.parse(fs.readFileSync(statePath(STAGING_RELEASE_FILE), "utf8")));
    return NextResponse.json(
      { staging: true, revision: record.revision, deployedAt: record.deployedAt, endpoint: record.endpoint },
      { headers },
    );
  } catch {
    /* No readable release record yet — the instance still identifies as staging. */
    return NextResponse.json({ staging: true, revision: null, deployedAt: null, endpoint: null }, { headers });
  }
}
