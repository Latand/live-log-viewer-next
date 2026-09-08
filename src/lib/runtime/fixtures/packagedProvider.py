#!/usr/bin/python3
"""Local protocol-only providers for the packaged startup rehearsal. No network."""
import json, os, sys
from pathlib import Path

def emit(value):
    print(json.dumps(value), flush=True)

def record_delivery(engine, session, content, client_id=None):
    # Independent provider-side evidence, written before the acknowledgement.
    with open(Path(os.environ["LLV_STATE_DIR"]) / "provider-deliveries.jsonl", "a") as log:
        log.write(json.dumps({"engine": engine, "session": session, "content": content, "clientId": client_id}) + "\n")

if "auth" in sys.argv and "status" in sys.argv:
    emit({"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max"})
    sys.exit(0)
claude = "--resume" in sys.argv
thread = sys.argv[sys.argv.index("--resume") + 1] if claude else "fixture-probe"
if claude:
    emit({"type": "system", "subtype": "init", "session_id": thread, "tools": [], "apiKeySource": "none"})
for line in sys.stdin:
    message = json.loads(line)
    if claude:
        if message.get("type") == "user":
            record_delivery("claude", thread, message["message"]["content"])
            emit({**message, "isReplay": True})
            emit({"type": "result", "subtype": "success", "session_id": thread})
        continue
    if "id" not in message:
        continue
    method = message.get("method")
    with open(Path(os.environ["LLV_STATE_DIR"]) / "provider-methods.jsonl", "a") as log:
        log.write(json.dumps({"pid": os.getpid(), "method": method}) + "\n")
    params = message.get("params") or {}
    result = {}
    if method == "initialize":
        result = {"userAgent": "packaged-startup-fixture/1"}
    elif method == "account/read":
        result = {"account": {"type": "chatgpt", "planType": "fixture"}, "requiresOpenaiAuth": False}
    elif method == "account/rateLimits/read":
        result = {"rateLimits": {"primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1800000000}, "secondary": None, "planType": "pro"}}
    elif method == "model/list":
        result = {"data": [{"id": "fixture", "isDefault": True, "inputModalities": ["text"]}]}
    elif method == "config/read":
        result = {"config": {"mcp_servers": {}}}
    elif method in ("thread/resume", "thread/start", "thread/read"):
        thread = params.get("threadId", thread)
        result = {"thread": {"id": thread, "path": str(Path(os.environ["LLV_STATE_DIR"]) / (thread + ".jsonl")), "turns": [], "status": {"type": "idle", "activeFlags": []}}}
    elif method == "thread/turns/list":
        result = {"data": [], "nextCursor": None, "backwardsCursor": None}
    elif method == "turn/start":
        record_delivery("codex", thread, params.get("input", []), params.get("clientUserMessageId"))
        result = {"turn": {"id": "fixture-turn"}}
    emit({"jsonrpc": "2.0", "id": message["id"], "result": result})
    if method == "turn/start":
        emit({"method": "turn/started", "params": {"threadId": thread, "turn": {"id": "fixture-turn"}}})
        emit({"method": "item/completed", "params": {"threadId": thread, "turnId": "fixture-turn", "item": {"type": "userMessage", "clientId": params.get("clientUserMessageId"), "content": params.get("input", [])}}})
        emit({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": "fixture-turn", "status": "completed"}}})
