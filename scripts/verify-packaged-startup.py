#!/usr/bin/python3
"""Rehearse packaged Viewer startup with an explicitly pinned runtime-host tree.

Build with LLV_STANDALONE=1 first. The package must contain bin/, dist/, public/
and .next/static as the shipped distribution does. All state and logs are new,
private files. No operator state, credentials, provider CLI or stable port is used.
"""
import argparse
import collections
import json
import hashlib
import http.server
import os
from pathlib import Path
import socket
import struct
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--viewer", type=Path, required=True, help="immutable standalone package")
parser.add_argument("--runtime-source", type=Path, required=True, help="exact incumbent runtime-host source tree")
parser.add_argument("--bun", type=Path, required=True)
parser.add_argument("--verify-timeout-ms", type=int, help="incumbent API rollback retains its actual 120000 ms deadline")
parser.add_argument("--hold-startup-ms", type=int, default=0, help="withhold historical responses until this elapsed startup time")
parser.add_argument("--rollback", action="store_true", help="hold historical publication through the real serving-verification verify-promoted deadline, then exercise rollback")
parser.add_argument("--codex-only", action="store_true", help="narrower contention control; does not qualify mixed-provider preservation")
parser.add_argument("--snapshot-delay-ms", type=int, default=0)
parser.add_argument("--rpc-delay-ms", type=int, default=0)
args = parser.parse_args()
assert 0 <= args.snapshot_delay_ms <= 3000 and 0 <= args.rpc_delay_ms <= 5
repo = Path(__file__).resolve().parents[1]
viewer, runtime_source, bun = args.viewer.resolve(), args.runtime_source.resolve(), args.bun.resolve()
incumbent_revision = "bdf4b85658802c2e1765382c5aef04a6585980a7"
if args.rollback:
    if args.verify_timeout_ms not in (None, 120000):
        parser.error("incumbent API rollback requires the unchanged 120000 ms action deadline")
    # Freeze every executable/source dependency, including the coordinator and
    # adapter imports. A current-tree adapter cannot qualify an old-host run.
    manifest = subprocess.check_output(["git", "ls-tree", "-rz", incumbent_revision], cwd=repo)
    for entry in manifest.split(b"\0"):
        if not entry:
            continue
        metadata, filename = entry.split(b"\t", 1)
        filename = filename.decode()
        if not (filename.startswith(("src/", "scripts/", "bin/")) or filename in ("tsconfig.json", "package.json", "bun.lock")):
            continue
        data = (runtime_source / filename).read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != metadata.decode().split()[2]:
            raise RuntimeError(f"incumbent source differs from frozen revision: {filename}")
assert subprocess.check_output([str(bun), "--version"], text=True).strip() == "1.4.0"
for file in [viewer / "server.js", viewer / "bin/mcp-server.mjs", viewer / "dist/mcp-server.mjs", runtime_source / "src/runtime-host/main.ts"]:
    assert file.is_file(), f"missing packaged prerequisite: {file.name}"
root = Path(tempfile.mkdtemp(prefix="llv-packaged-startup-", dir="/var/tmp"))
os.chmod(root, 0o700)
env = {"PATH": str(root / "bin") + ":/usr/bin:/bin", "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1", "NEXT_PUBLIC_RUNTIME_UI": "1", "LLV_AGENT_REGISTRY_SQLITE": "sqlite"}
for key, directory in {"HOME": "home", "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache", "LLV_STATE_DIR": "state", "TMPDIR": "tmp", "CODEX_HOME": "codex", "LLV_CODEX_HOME": "codex", "CLAUDE_CONFIG_DIR": "claude", "LLV_CLAUDE_HOME": "claude"}.items():
    (root / directory).mkdir(mode=0o700, exist_ok=True)
    env[key] = str(root / directory)
(root / "bin").mkdir(mode=0o700)
(root / "bin/bun").symlink_to(bun)
(root / "bin/bun-container").symlink_to(bun)
(root / "sockets").mkdir(mode=0o700)
provider = str(root / "bin/provider")
shutil.copy2(repo / "src/lib/runtime/fixtures/packagedProvider.py", provider)
env.update({"LLV_CODEX_BINARY": provider, "LLV_CLAUDE_BINARY": provider, "LLV_PACKAGED_MIXED_ENGINES": "0" if args.codex_only else "1"})
external_workers = []
external_ports = []
for _ in range(2):
    worker = subprocess.Popen(["/usr/bin/python3", str(repo / "src/lib/runtime/fixtures/packagedExternalWorker.py")], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    external_workers.append(worker)
    external_ports.append(int(worker.stdout.readline()))
env["LLV_PACKAGED_EXTERNAL_PIDS"] = json.dumps([worker.pid for worker in external_workers])
with open(root / "seed.log", "w") as log:
    try:
        subprocess.run([str(bun), "src/lib/runtime/fixtures/packagedStartupSeed.ts"], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    except BaseException:
        for worker in external_workers:
            worker.stdin.close()
            worker.wait(timeout=5)
        raise

budgets = json.loads((root / "state/rehearsal-budgets.json").read_text())
with sqlite3.connect(f"file:{root / 'state/runtime-events.sqlite'}?mode=ro", uri=True) as db:
    pending_before = db.execute("SELECT operation_id,idempotency_key,request_json FROM operations WHERE idempotency_key LIKE 'queued-startup-%' ORDER BY idempotency_key").fetchall()
(root / "pending-before.json").write_text(json.dumps(pending_before))

# A transparent local socket relay counts framing bytes and response times.
# Every request and reply still runs through the real incumbent host.
real_socket = str(root / "sockets/host.sock")
relay_socket = str(root / "sockets/viewer.sock")
metrics = collections.defaultdict(lambda: {"count": 0, "requestBytes": 0, "responseBytes": 0, "elapsedMs": 0, "maxMs": 0})
metrics_lock = threading.Lock()
relay_errors = []
fence_seen = threading.Event()
held_historical = 0
late_startup_publications = 0
late_candidate_mutations = 0
listener = socket.socket(socket.AF_UNIX)
listener.bind(relay_socket)
listener.listen()
listener.settimeout(.2)
stopping = threading.Event()

def forward(peer):
    global held_historical, late_startup_publications, late_candidate_mutations
    try:
        peer_pid = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
        request = peer.makefile("rb").readline()
        decoded = json.loads(request)
        method = decoded["method"]
        if args.rollback and peer_pid == app.pid and method in ("append", "command", "operation", "operation-transition"):
            authority_path = root / "state/hot-state-authority.json"
            authority = json.loads(authority_path.read_text()) if authority_path.exists() else {}
            if authority.get("checkpoint") or authority.get("releaseRevision") != "a" * 40:
                with metrics_lock:
                    late_candidate_mutations += 1
        event = decoded.get("params", {}).get("event", {})
        conversation = event.get("scope", {}).get("id", "")
        history_index = int(conversation.removeprefix("conversation_history_")) if conversation.startswith("conversation_history_") else -1
        historical = method == "append" and history_index >= 6 and event.get("payload", {}).get("host") in ("dead", "unhosted") and event.get("producer", {}).get("eventKey", "").startswith("projection:")
        if args.rollback and historical and peer_pid == app.pid and fence_seen.is_set():
            with metrics_lock:
                late_startup_publications += 1
        rpc_started = time.monotonic()
        time.sleep((args.snapshot_delay_ms if method == "snapshot" else args.rpc_delay_ms) / 1000)
        with socket.socket(socket.AF_UNIX) as upstream:
            upstream.connect(real_socket)
            upstream.sendall(request)
            response = upstream.makefile("rb").readline()
        if historical and args.hold_startup_ms:
            time.sleep(max(0, args.hold_startup_ms / 1000 - (time.monotonic() - started)))
        if args.rollback and historical and peer_pid == app.pid and not fence_seen.is_set():
            with metrics_lock:
                held_historical += 1
            # Let the real timeout expire. Once rollback publishes its fence,
            # the in-flight reply can settle; no request is abandoned.
            until = time.monotonic() + 420
            while time.monotonic() < until:
                authority_file = root / "state/hot-state-authority.json"
                authority = json.loads(authority_file.read_text()) if authority_file.exists() else {}
                if authority.get("mode") == "fencing" or authority.get("releaseRevision") != "a" * 40:
                    fence_seen.set()
                    time.sleep(.2)
                    break
                time.sleep(.05)
        elapsed = (time.monotonic() - rpc_started) * 1000
        with metrics_lock:
            item = metrics[method]
            item["count"] += 1
            item["requestBytes"] += len(request)
            item["responseBytes"] += len(response)
            item["elapsedMs"] += round(elapsed)
            item["maxMs"] = max(item["maxMs"], round(elapsed))
        peer.sendall(response)
    except (OSError, ValueError, KeyError) as error:
        with metrics_lock:
            relay_errors.append(type(error).__name__)
    finally:
        peer.close()

def relay():
    while not stopping.is_set():
        try:
            peer, _ = listener.accept()
            threading.Thread(target=forward, args=(peer,), daemon=True).start()
        except socket.timeout:
            pass

threading.Thread(target=relay, daemon=True).start()
with socket.socket() as reserved:
    reserved.bind(("127.0.0.1", 0))
    port = reserved.getsockname()[1]
env.update({"PORT": str(port), "HOSTNAME": "127.0.0.1", "LLV_VIEWER_PORT": str(port), "LLV_RUNTIME_HOST_SOCKET": real_socket})
logs = [open(root / "host.log", "w"), open(root / "viewer.log", "w")]
host_env = dict(env)
if args.rollback:
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        front_port = reserved.getsockname()[1]
    host_env.update({
        "LLV_VIEWER_PORT": str(front_port), "LLV_VIEWER_DEPLOYMENTS": "1",
        "LLV_VIEWER_DEPLOY_ADAPTER": str(repo / "src/lib/runtime/fixtures/packagedIncumbentAdapter.py"),
        "LLV_PACKAGED_RUNTIME_SOURCE": str(runtime_source), "LLV_PACKAGED_BUN": str(bun),
    })
host = subprocess.Popen([str(bun), "src/runtime-host/main.ts"], cwd=runtime_source, env=host_env, stdout=logs[0], stderr=subprocess.STDOUT)
for _ in range(100):
    if Path(real_socket).exists():
        break
    if host.poll() is not None:
        raise RuntimeError("private runtime host failed to start")
    time.sleep(.1)
env["LLV_RUNTIME_HOST_SOCKET"] = relay_socket
previous_app = None
rollback_driver = None
if args.rollback:
    # Force the real incumbent verifier's outer timeout. Direct candidate and
    # restored endpoints remain real Viewers; only this serving probe is held.
    class SlowServing(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            time.sleep(35)
            try:
                self.send_response(503)
                self.end_headers()
            except OSError:
                pass

        def log_message(self, *_):
            pass

    slow = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SlowServing)
    threading.Thread(target=slow.serve_forever, daemon=True).start()
    (root / "state/slow-port").write_text(str(slow.server_port))
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        previous_port = reserved.getsockname()[1]
    def release(letter, endpoint, container, managed):
        revision = letter * 40
        return {"revision": revision, "endpoint": endpoint, "container": container, "image": "viewer:fixture", "hotStateBackend": "sqlite-v1", "mcpRuntime": {
            "source": "managed" if managed else "legacy", "revision": revision,
            "releaseId": "fixture" if managed else None, "artifactDigest": letter * 64,
            "stagedAt": "2026-01-01T00:00:00.000Z" if managed else None,
        }}
    candidate = release("a", f"http://127.0.0.1:{port}", "fixture-candidate", True)
    previous = release("b", f"http://127.0.0.1:{previous_port}", "fixture-previous", False)
    (root / "state/viewer-release.json").write_text(json.dumps(candidate))
    (root / "state/hot-state-authority.json").write_text(json.dumps({"schemaVersion": 1, "epoch": 1, "mode": "sqlite", "releaseRevision": candidate["revision"], "updatedAt": "2026-01-01T00:00:00.000Z"}))
    (root / "state/rehearsal-release.json").write_text(json.dumps({"candidate": candidate, "previous": previous, "actionTimeoutMs": args.verify_timeout_ms}))
    # Docker is only a container-state adapter for processes owned here. Every
    # HTTP probe, authority write, checkpoint and target switch is production code.
    (root / "bin/docker").write_text("#!/bin/sh\nif [ \"$1 $2\" = \"container inspect\" ]; then exit 0; fi\nif [ \"$1\" = inspect ]; then echo running; exit 0; fi\nif [ \"$1\" = start ]; then exit 0; fi\nexit 1\n")
    (root / "bin/docker").chmod(0o700)
    compose = root / "state/deployments/compose"
    compose.mkdir(parents=True, exist_ok=True)
    for identity in [candidate, previous]:
        name = hashlib.sha256(identity["container"].encode()).hexdigest()[:24] + ".json"
        (compose / name).write_text(json.dumps({"services": {"viewer": {"build": None, "command": None, "entrypoint": None, "environment": {"LLV_AGENT_REGISTRY_SQLITE": "sqlite"}, "image": "viewer:fixture", "labels": {}, "network_mode": "host", "pid": "host", "privileged": False, "restart": "unless-stopped", "user": "1000:1000", "volumes": [], "working_dir": "/app"}}}))
    previous_env = dict(env, PORT=str(previous_port), LLV_VIEWER_PORT=str(previous_port))
    logs.append(open(root / "previous.log", "w"))
    previous_app = subprocess.Popen([str(bun), str(viewer / "server.js")], cwd=viewer, env=previous_env, stdout=logs[-1], stderr=subprocess.STDOUT)
app = subprocess.Popen([str(bun), str(viewer / "server.js")], cwd=viewer, env=env, stdout=logs[1], stderr=subprocess.STDOUT)
started = time.monotonic()
if args.rollback:
    logs.append(open(root / "rollback.log", "w"))
    driver_env = dict(env, LLV_PACKAGED_DEPLOYMENT_PORT=str(front_port))
    rollback_driver = subprocess.Popen([str(bun), "src/lib/runtime/fixtures/packagedRollback.ts"], cwd=repo, env=driver_env, stdout=logs[-1], stderr=subprocess.STDOUT)
result = {"ready": False, "deadlineMs": budgets["serving"], "snapshotDelayMs": args.snapshot_delay_ms, "rpcDelayMs": args.rpc_delay_ms}
if args.rollback:
    # The real verify action and rollback action each retain a hard deadline.
    # Include one bounded capability observation after the terminal write.
    result["rollbackBoundMs"] = 120_000 + 90_000 + 5_000
    result["incumbentRevision"] = incumbent_revision
    result["deploymentAdmission"] = "Viewer API"
expected_keys = [("claude" if not args.codex_only and i >= 3 else "codex") + ":00000000-0000-4000-8000-" + str(i).zfill(12) for i in range(6)]
before_claims = None

def claims():
    filename = root / "state/agent-registry.sqlite"
    with sqlite3.connect(f"file:{filename}?mode=ro", uri=True) as db:
        return db.execute("SELECT row_key,json_extract(value_json,'$.accountId'),json_extract(value_json,'$.claimOwner'),json_extract(value_json,'$.claimEpoch'),json_extract(value_json,'$.structuredHost.process.pid'),json_extract(value_json,'$.structuredHost.process.startIdentity'),json_extract(value_json,'$.artifactPath') FROM registry_rows WHERE collection='entries' AND row_key IN (?,?,?,?,?,?) ORDER BY row_key", expected_keys).fetchall()
print(root, flush=True)
try:
    with open(root / "timeline.jsonl", "w") as timeline:
        # Continue observation after the bounded serving gate, without claiming
        # success or releasing the callback's lease at the deadline.
        while time.monotonic() - started < 480:
            before = time.monotonic()
            status = {}
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/runtime/deployments/capabilities/v1", timeout=2) as response:
                    status = json.load(response)
            except urllib.error.HTTPError as error:
                status = json.load(error)
            except (OSError, ValueError):
                pass
            leases = []
            database = root / "state/state.sqlite"
            if database.exists():
                with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
                    leases = db.execute("SELECT collection,owner_pid,owner_start_identity,acquired_at FROM state_leases").fetchall()
            current_claims = claims()
            if before_claims is None and len(current_claims) == 6 and all(row[2] and row[4] and row[5] for row in current_claims):
                before_claims = current_claims
            elapsed = round((time.monotonic() - started) * 1000)
            timeline.write(json.dumps({"elapsedMs": elapsed, "probeMs": round((time.monotonic() - before) * 1000), "status": status, "leases": leases}) + "\n")
            timeline.flush()
            if args.rollback:
                if rollback_driver.poll() is not None and not (root / "state/rollback-terminal.json").exists():
                    result["driverExit"] = rollback_driver.returncode
                    break
                terminal_file = root / "state/rollback-terminal.json"
                if terminal_file.exists():
                    terminal = json.loads(terminal_file.read_text())
                    result.update({"terminalPhase": terminal["phase"], "terminal": terminal["terminal"], "elapsedMs": elapsed, "rollbackError": terminal.get("error")})
                    # A retired candidate must exit through its own demotion.
                    try:
                        result["candidateExit"] = app.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        result["candidateExit"] = None
                    result["targetRestored"] = json.loads((root / "state/viewer-release.json").read_text())["revision"] == previous["revision"]
                    candidate_log = (root / "viewer.log").read_text()
                    result["orphanReady"] = 'phase: "ready"' in candidate_log
                    if terminal["phase"] == "rolled-back" and result["candidateExit"] == 0:
                        restore_started = time.monotonic()
                        while time.monotonic() - restore_started < budgets["serving"] / 1000:
                            try:
                                with urllib.request.urlopen(f"http://127.0.0.1:{previous_port}/api/runtime/deployments/capabilities/v1", timeout=2) as response:
                                    restored = json.load(response)
                                if restored.get("structuredHostStartup", {}).get("state") == "ready":
                                    result["restoredReady"] = True
                                    result["restoreReadyMs"] = round((time.monotonic() - restore_started) * 1000)
                                    with sqlite3.connect(f"file:{root / 'state/runtime-events.sqlite'}?mode=ro", uri=True) as db:
                                        result["restoredQueuedSends"] = dict(db.execute("SELECT json_extract(receipt_json,'$.status'),count(*) FROM operations WHERE idempotency_key LIKE 'queued-startup-%' GROUP BY 1").fetchall())
                                    break
                            except (OSError, ValueError):
                                pass
                            time.sleep(.25)
                    break
                time.sleep(.25)
                continue
            if status.get("structuredHostStartup", {}).get("state") == "ready":
                with sqlite3.connect(f"file:{root / 'state/agent-registry.sqlite'}?mode=ro", uri=True) as db:
                    hosted = sum(1 for row in current_claims if row[4] and row[5])
                contender = subprocess.run([str(bun), "src/lib/runtime/fixtures/startupPipelineContender.ts", str(root / "state")], cwd=repo, env=env, capture_output=True, text=True)
                with sqlite3.connect(f"file:{root / 'state/runtime-events.sqlite'}?mode=ro", uri=True) as db:
                    sends = db.execute("SELECT json_extract(receipt_json,'$.status'),count(*) FROM operations WHERE idempotency_key LIKE 'queued-startup-%' GROUP BY 1").fetchall()
                (root / "ownership.json").write_text(json.dumps({"before": before_claims, "after": current_claims}, indent=2))
                result.update({"ready": True, "elapsedMs": elapsed, "hosted": hosted, "queuedSends": dict(sends), "ownershipPreserved": before_claims is not None and current_claims == before_claims, "creation": json.loads(contender.stdout), "creationExit": contender.returncode})
                break
            time.sleep(.25)
finally:
    with sqlite3.connect(f"file:{root / 'state/agent-registry.sqlite'}?mode=ro", uri=True) as db:
        before_external = json.loads((root / "state/external-before.json").read_text())
        after_external = {key: json.loads(db.execute("SELECT value_json FROM registry_rows WHERE collection='entries' AND row_key=?", (key,)).fetchone()[0]) for key in before_external}
        pending_spawn_before = json.loads((root / "state/pending-spawn-before.json").read_text())
        pending_spawn_after = {key: json.loads(db.execute("SELECT value_json FROM registry_rows WHERE collection='receipts' AND row_key=?", (key,)).fetchone()[0]) for key in pending_spawn_before}
    result["pendingSpawnPreserved"] = pending_spawn_before == pending_spawn_after
    result["externalStatePreserved"] = before_external == after_external
    result["externalWorkersAlive"] = []
    for worker, worker_port in zip(external_workers, external_ports):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{worker_port}", timeout=2) as response:
                result["externalWorkersAlive"].append(worker.poll() is None and response.read().decode() == str(worker.pid))
        except OSError:
            result["externalWorkersAlive"].append(False)
    with sqlite3.connect(f"file:{root / 'state/runtime-events.sqlite'}?mode=ro", uri=True) as db:
        pending_after = db.execute("SELECT operation_id,idempotency_key,request_json FROM operations WHERE idempotency_key LIKE 'queued-startup-%' ORDER BY idempotency_key").fetchall()
    result["pendingIdentitiesPreserved"] = pending_before == pending_after
    # Match the original durable request to exactly one actual provider input.
    # Claude's wire protocol carries no client key, so its unique fixture text
    # and session bind that input to the unchanged original journal request.
    delivery_log = root / "state/provider-deliveries.jsonl"
    observed = [json.loads(line) for line in delivery_log.read_text().splitlines()] if delivery_log.exists() else []
    expected = []
    for operation_id, key, request_json in pending_before:
        request = json.loads(request_json)
        index = int(key.removeprefix("queued-startup-"))
        engine, session = expected_keys[index].split(":", 1)
        wire_text = request["text"]
        if engine == "codex":
            wire_text = f"<!-- llv:structured-user dedup={hashlib.sha256(operation_id.encode()).hexdigest()} -->\n{wire_text}"
        expected.append({"engine": engine, "session": session, "text": wire_text,
                         "clientId": operation_id if engine == "codex" else None})
    actual = [{"engine": item["engine"], "session": item["session"],
               "text": "".join(block.get("text", "") for block in item["content"] if block.get("type") in ("text", "input_text")),
               "clientId": item["clientId"]} for item in observed]
    # Retained unfinished Codex turns can also receive the explicit startup
    # continuation. Account for its exact wire contract separately; never
    # discard an unknown input or count a continuation as an original send.
    continuations = []
    original_inputs = []
    for item in actual:
        client_id = item["clientId"] or ""
        prefix = f"recovery-continuation-{item['session']}-"
        continuation_text = f"<!-- llv:structured-user dedup={hashlib.sha256(client_id.encode()).hexdigest()} -->\nContinue the interrupted turn from the transcript."
        if item["engine"] == "codex" and client_id.startswith(prefix) and client_id[len(prefix):].isdigit() and item["text"] == continuation_text:
            continuations.append(item)
        else:
            original_inputs.append(item)
    result["originalProviderInputsMatched"] = sorted(original_inputs, key=lambda item: item["session"]) == sorted(expected, key=lambda item: item["session"])
    result["originalProviderInputCount"] = len(original_inputs)
    result["recoveryContinuationCount"] = len(continuations)
    result["providerInputCount"] = len(actual)
    (root / "provider-input-evidence.json").write_text(json.dumps({"expected": expected, "actual": actual}, indent=2))
    # Only child handles created above; no process enumeration or live signals.
    # End application clients before asking the host to drain its listeners.
    for label, child in [("candidate", app), ("previous", previous_app), ("driver", rollback_driver), ("host", host)]:
        if child is None:
            continue
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            # Verification above is complete. This is teardown of an exact
            # harness-owned child, never evidence about production shutdown.
            child.kill()
            child.wait(timeout=5)
            result.setdefault("fixtureCleanupForced", []).append(label)
    for worker in external_workers:
        worker.stdin.close()
        worker.wait(timeout=5)
    stopping.set()
    listener.close()
    with metrics_lock:
        result["heldHistoricalResponses"] = held_historical
        result["lateStartupPublications"] = late_startup_publications
        result["lateCandidateMutations"] = late_candidate_mutations
        result["rpc"] = dict(metrics)
        result["relayErrors"] = dict(collections.Counter(relay_errors))
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
preserved = result.get("originalProviderInputsMatched") is True and result.get("lateCandidateMutations") == 0 and result.get("pendingSpawnPreserved") is True and not result.get("unsettledPrivateChildren") and result.get("externalStatePreserved") is True and result.get("externalWorkersAlive") == [True, True] and result.get("pendingIdentitiesPreserved") is True
if args.rollback:
    raise SystemExit(0 if preserved and result.get("elapsedMs", float("inf")) < result["rollbackBoundMs"] and result.get("terminalPhase") == "rolled-back" and result.get("terminal") is True and result.get("targetRestored") is True and result.get("candidateExit") == 0 and result.get("orphanReady") is False and "timed out" in (result.get("rollbackError") or "") and result.get("heldHistoricalResponses", 0) > 0 and result.get("lateStartupPublications") == 0 and result.get("restoredReady") is True and result.get("restoredQueuedSends") == {"delivered": 6} else 1)
raise SystemExit(0 if preserved and result.get("queuedSends") == {"delivered": 6} and result.get("ready") and result["elapsedMs"] < result["deadlineMs"] and result.get("hosted") == 6 and result.get("ownershipPreserved") is True and result.get("creation", {}).get("created") else 1)
