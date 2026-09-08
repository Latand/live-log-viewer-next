#!/usr/bin/python3
"""Container setup fixture; verification and rollback execute the frozen adapter."""
import json
import os
from pathlib import Path
import sys


action = sys.argv[1]
directory = Path(os.environ["LLV_STATE_DIR"])
if action == "verify-promoted":
    os.environ["LLV_VIEWER_PORT"] = (directory / "slow-port").read_text()
if action in ("verify-promoted", "rollback"):
    executable = Path(os.environ["LLV_PACKAGED_RUNTIME_SOURCE"]) / "scripts/runtime-host-viewer-adapter.ts"
    os.execv(os.environ["LLV_PACKAGED_BUN"], ["bun", str(executable), action])

request = json.load(sys.stdin)
releases = json.loads((directory / "rehearsal-release.json").read_text())
candidate, previous = releases["candidate"], releases["previous"]
if action == "resolve-revision":
    output = {"revision": candidate["revision"]}
elif action == "build-candidate":
    output = candidate
elif action == "current-release":
    output = previous
elif action == "current-mcp-runtime":
    output = previous["mcpRuntime"]
elif action == "verify-candidate":
    output = {
        "checkedAt": "2026-01-01T00:00:00.000Z", "endpoint": candidate["endpoint"],
        "processReady": True, "rootStatus": 200, "authenticatedStatus": None,
        "unauthorizedStatus": None, "assets": [], "ok": True,
        "detail": "Container/precheck setup fixture; no full deployment success claim",
    }
elif action == "promote":
    output = dict(candidate["mcpRuntime"], action="activate", publishedAt="2026-01-01T00:00:00.000Z", durable=True)
elif action in ("start-candidate", "retire", "retain-only"):
    output = {}
else:
    raise RuntimeError(f"unsupported rehearsal action: {action}")
print(json.dumps(output))
