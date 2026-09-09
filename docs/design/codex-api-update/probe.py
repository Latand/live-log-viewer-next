"""Isolated, credential-free Codex app-server contract probe. No model service used."""
import argparse
import copy
from probe_evidence import record_snapshot, scenario_events, evaluate
import http.server
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--codex', default=shutil.which('codex'))
parser.add_argument('--output', type=Path, default=ROOT/'evidence/probe-results.json')
args = parser.parse_args()
requests = []
release = threading.Event()


class Backend(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        requests.append(body)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            self.wfile.write(b'event: response.created\ndata: {"type":"response.created","response":{"id":"response_probe"}}\n\n')
            self.wfile.flush()
            release.wait(20)
            self.wfile.write(b'event: response.completed\ndata: {"type":"response.completed","response":{"id":"response_probe","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Client:
    def __init__(self, env, cwd, experimental):
        self.events = []
        self.lines = queue.Queue()
        self.serial = 0
        self.process = subprocess.Popen([args.codex, 'app-server', '--stdio'], env=env, cwd=cwd,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True)
        def reader():
            for line in self.process.stdout:
                self.lines.put(json.loads(line))
        threading.Thread(target=reader, daemon=True).start()
        self.init = self.rpc('initialize', {'clientInfo': {'name': 'isolated_contract_probe', 'version': '1'},
                                          'capabilities': {'experimentalApi': experimental}})
        self.write({'method': 'initialized', 'params': {}})

    def write(self, obj):
        self.process.stdin.write(json.dumps(obj) + '\n')
        self.process.stdin.flush()

    def rpc(self, method, params, timeout=12):
        self.serial += 1
        rid = self.serial
        self.write({'id': rid, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            item = self.lines.get(timeout=max(.01, deadline-time.monotonic()))
            if item.get('id') == rid:
                return item
            self.events.append(item)
        raise TimeoutError(method)

    def drain(self, seconds=.15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                self.events.append(self.lines.get(timeout=max(.01, end-time.monotonic())))
            except queue.Empty:
                break

    def stop(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=4)


def run():
    result = {'cli': subprocess.check_output([args.codex, '--version'], text=True).strip(),
              'backend': 'local synthetic SSE; no credentials; no external model requests', 'cases': []}
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='ca-', dir='/tmp') as scratch:
        base = Path(scratch)
        env = {k: v for k, v in os.environ.items() if k in ['PATH', 'LANG', 'LC_ALL']}
        for key in ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'LLV_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'TMPDIR']:
            d = base/key.lower()
            d.mkdir(mode=0o700)
            env[key] = str(d)
        cwd = base/'workspace'
        cwd.mkdir()
        Path(env['CODEX_HOME'], 'config.toml').write_text(f'''model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.probe]
name = "Local contract fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
''')
        clients = []
        def client(exp):
            c = Client(env, cwd, exp)
            clients.append(c)
            return c
        target_thread = None
        def record(name, response):
            record_snapshot(result['cases'], name, response, target_thread)
            if isinstance(response, dict) and 'error' in response:
                print(name, 'expected protocol rejection', flush=True)
        try:
            c = client(False)
            record('initialize', c.init)
            record('account_without_credentials', c.rpc('account/read', {'refreshToken': False}))
            t = c.rpc('thread/start', {'cwd': str(cwd), 'model': 'probe-model', 'modelProvider': 'probe',
                                       'approvalPolicy': 'never', 'sandbox': 'read-only'})
            record('thread_start', t)
            tid = t['result']['thread']['id']
            target_thread = tid
            result['threads'] = {'injection': tid}
            inject = {'threadId': tid, 'items': [{'type': 'message', 'id': 'probe-context',
                        'role': 'user', 'content': [{'type': 'input_text', 'text': 'probe-idle-context'}]}]}
            record('inject_idle_stable_handshake', c.rpc('thread/inject_items', inject))
            record('inject_empty', c.rpc('thread/inject_items', {'threadId': tid, 'items': []}))
            record('inject_malformed', c.rpc('thread/inject_items', {'threadId': tid, 'items': [{'type': 'message', 'role': 'user'}]}))
            c.drain()
            record('idle_inject_events', [e.get('method') for e in c.events])
            record('idle_inject_backend_requests', len(requests))
            record('queue_without_experimental', c.rpc('thread/queue/list', {'threadId': tid}))
            record('steer_idle', c.rpc('turn/steer', {'threadId': tid, 'expectedTurnId': 'stale',
                                                     'input': [{'type': 'text', 'text': 'never deliver'}]}))
            record('inject_repeated_same_item_id', c.rpc('thread/inject_items', inject))
            record('thread_read_include_turns', c.rpc('thread/read', {'threadId': tid, 'includeTurns': True}))
            record('thread_turns_list', c.rpc('thread/turns/list', {'threadId': tid, 'limit': 10}))
            c.stop(); clients.remove(c)
            c = client(True)
            record('resume', c.rpc('thread/resume', {'threadId': tid, 'excludeTurns': True}))
            first = c.rpc('turn/start', {'threadId': tid, 'clientUserMessageId': 'probe-active',
                                        'input': [{'type': 'text', 'text': 'probe-active-turn'}]})
            record('turn_start_idle', first)
            turn = first['result']['turn']['id']
            deadline = time.monotonic()+8
            while not requests and time.monotonic()<deadline:
                c.drain(.1)
            record('first_backend_request', {'count': len(requests), 'input': requests[0].get('input') if requests else None})
            record('inject_active', c.rpc('thread/inject_items', {'threadId': tid, 'items': [
                {'type': 'message', 'id': 'probe-active-context', 'role': 'user',
                 'content': [{'type': 'input_text', 'text': 'probe-active-context'}]}]}))
            record('steer_stale', c.rpc('turn/steer', {'threadId': tid, 'expectedTurnId': 'stale',
                                                     'input': [{'type': 'text', 'text': 'never deliver'}]}))
            record('steer_matching', c.rpc('turn/steer', {'threadId': tid, 'expectedTurnId': turn,
                         'clientUserMessageId': 'probe-steer', 'input': [{'type': 'text', 'text': 'probe-steered-input'}]}))
            record('turn_start_while_active', c.rpc('turn/start', {'threadId': tid,
                         'clientUserMessageId': 'probe-second-start', 'input': [{'type': 'text', 'text': 'probe-second-start'}]}))
            q = {'threadId': tid, 'clientUserMessageId': 'probe-queue-id',
                 'input': [{'type': 'text', 'text': 'probe-queued-input'}]}
            record('queue_add_active', c.rpc('thread/queue/add', q))
            record('queue_repeat_same_client_id', c.rpc('thread/queue/add', q))
            record('queue_repeat_changed_payload', c.rpc('thread/queue/add', {**q, 'input': [{'type': 'text', 'text': 'different'}]}))
            record('queue_list_active', c.rpc('thread/queue/list', {'threadId': tid}))
            record('queue_start_active', c.rpc('thread/queue/start', {'threadId': tid}))
            record('interrupt', c.rpc('turn/interrupt', {'threadId': tid, 'turnId': turn}))
            c.drain(.4)
            record('queue_after_interrupt', c.rpc('thread/queue/list', {'threadId': tid}))
            record('events', scenario_events(c.events, tid, 0))
            c.stop(); clients.remove(c)
            c = client(True)
            record('queue_cold_list', c.rpc('thread/queue/list', {'threadId': tid}))
            record('cold_resume', c.rpc('thread/resume', {'threadId': tid, 'excludeTurns': True}))
            c.drain(.5)
            record('cold_resume_events', scenario_events(c.events, tid, 0))
            record('queue_after_cold_resume', c.rpc('thread/queue/list', {'threadId': tid}))
            record('backend_request_count', len(requests))
            t2 = c.rpc('thread/start', {'cwd': str(cwd), 'model': 'probe-model', 'modelProvider': 'probe',
                                       'approvalPolicy': 'never', 'sandbox': 'read-only'})['result']['thread']['id']
            target_thread = t2
            result['threads']['cold'] = t2
            record('second_thread_injection', c.rpc('thread/inject_items', {'threadId': t2, 'items': inject['items']}))
            c.stop(); clients.remove(c)
            c = client(True)
            record('queue_add_unloaded', c.rpc('thread/queue/add', {'threadId': t2,
                  'clientUserMessageId': 'probe-cold-queue', 'input': [{'type': 'text', 'text': 'probe-cold-queue'}]}))
            record('unloaded_metadata', c.rpc('thread/read', {'threadId': t2}))
            cold_begin = len(c.events)
            record('normal_cold_resume', c.rpc('thread/resume', {'threadId': t2, 'excludeTurns': True}))
            c.drain(2)
            record('normal_cold_resume_events', scenario_events(c.events, t2, cold_begin))
            cold_snapshot = copy.deepcopy(result['cases'][-1])
            idle_begin = len(c.events)
            record('normal_cold_resume_queue', c.rpc('thread/queue/list', {'threadId': t2}))
            t3 = c.rpc('thread/start', {'cwd': str(cwd), 'model': 'probe-model', 'modelProvider': 'probe',
                                       'approvalPolicy': 'never', 'sandbox': 'read-only'})['result']['thread']['id']
            target_thread = t3
            result['threads']['idle'] = t3
            record('queue_add_idle', c.rpc('thread/queue/add', {'threadId': t3,
                  'clientUserMessageId': 'probe-idle-queue', 'input': [{'type': 'text', 'text': 'probe-idle-queue'}]}))
            c.drain(.7)
            record('idle_queue_list', c.rpc('thread/queue/list', {'threadId': t3}))
            record('idle_queue_events', scenario_events(c.events, t3, idle_begin))
            record('earlier_scenario_unchanged', next(x for x in result['cases'] if x['name'] == 'normal_cold_resume_events') == cold_snapshot)
            target_thread = tid
            record('turns_pagination_after_input', c.rpc('thread/turns/list', {'threadId': tid, 'limit': 10}))
            record('items_pagination_after_input', c.rpc('thread/items/list', {'threadId': tid, 'turnId': turn, 'limit': 10}))
            c.stop(); clients.remove(c)
            # Retain only synthetic marker-bearing canonical records, never full startup context.
            rows = []
            known_threads = set(result['threads'].values())
            for file in sorted(Path(env['CODEX_HOME']).rglob('*.jsonl')):
                records = [json.loads(line) for line in file.read_text().splitlines()]
                metas = [r['payload']['id'] for r in records if r.get('type') == 'session_meta']
                if len(set(metas)) != 1 or metas[0] not in known_threads:
                    raise AssertionError('Canonical transcript has missing or unknown thread provenance')
                source_thread = metas[0]
                for row in records:
                    if row.get('type') in ('response_item', 'event_msg') and 'probe-' in json.dumps(row):
                        rows.append({'threadId': source_thread, 'transcript': source_thread + '-rollout', 'record': row})
            target_thread = None
            record('canonical_marker_records', rows)
        finally:
            for c in clients:
                c.stop()
            release.set()
            server.shutdown()
        # Evidence keeps relative placeholders for all sandbox paths.
        encoded = json.dumps(result, indent=2).replace(str(base), '$PROBE').replace(str(ROOT.parents[2]), '$REPO')
        # Do not retain the backend's complete initial instructions.
        decoded = json.loads(encoded)
        def sanitize(value):
            if isinstance(value, list):
                return [sanitize(v) for v in value]
            if isinstance(value, dict):
                return {k: ('$REDACTED' if k in ['serverName', 'installationId', 'gitInfo'] else sanitize(v)) for k, v in value.items()}
            return value
        decoded = sanitize(decoded)
        for case in decoded['cases']:
            if case['name'] == 'first_backend_request':
                items = case['response']['input'] or []
                case['response']['input'] = [i for i in items if i.get('role') == 'user' and 'probe-idle-context' in json.dumps(i)]
        decoded['assertions'] = evaluate(decoded)
        aliases = {tid: 'thread-a', t2: 'thread-b', t3: 'thread-c'}
        def alias(match):
            return aliases.setdefault(match.group(), f'fixture-id-{len(aliases)+1:03d}')
        public_json = re.sub(r'(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f])',
                             alias, json.dumps(decoded, indent=2), flags=re.I)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(public_json+'\n')
        print(json.dumps({'cases': len(decoded['cases']), 'backendRequests': len(requests),
                          'assertions': decoded['assertions'], 'output': 'evidence/probe-results.json'}))
        assert all(decoded['assertions'].values()), 'A contract assertion did not hold; inspect evidence.'


if __name__ == '__main__':
    run()
