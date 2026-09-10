"""Isolated, credential-free realtime-voice contract probe. No model service used.

Answers one question with the installed app-server rather than with its schema:
when a call starts on a thread that already has a role and tools, what does the
SPOKEN model actually receive?

The realtime call is created against the configured model provider, so pointing
that provider at a local fixture captures the outgoing live-session body verbatim
without any credential, any account, and any request leaving the machine. The
thread is created for the probe, carries a synthetic mandate, and is discarded
with its temporary home.

Run:  python3 docs/design/codex-api-update/voice_probe.py
"""
import argparse
import http.server
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--codex', default=shutil.which('codex'))
parser.add_argument('--output', type=Path, default=ROOT / 'evidence/voice-probe-results.json')
args = parser.parse_args()

captured: list[tuple[str, bytes]] = []

# A distinctive role/tool mandate. Nothing about it is real; it exists only so a
# grep can answer "did this reach that model".
MARKER = 'LLVPROBEMANAGERMARKER'
MANDATE = (f'{MARKER}: you are this project\'s board manager. You own the board tools '
           'probe_board_read and probe_board_write, and you keep them for the whole session.')

# Minimal but structurally valid: the app-server forwards the offer untouched, and
# the fixture never negotiates media.
OFFER = ('v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
         'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=sendrecv\r\n')


class Fixture(http.server.BaseHTTPRequestHandler):
    """Stands in for the model provider AND for realtime call creation."""

    def log_message(self, *_):
        pass

    def do_POST(self):
        captured.append((self.path, self.rfile.read(int(self.headers.get('Content-Length', '0')))))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            self.wfile.write(b'event: response.completed\ndata: '
                             b'{"type":"response.completed","response":{"id":"r","status":"completed",'
                             b'"output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Client:
    def __init__(self, env, cwd):
        self.lines: queue.Queue = queue.Queue()
        self.serial = 0
        self.process = subprocess.Popen([args.codex, 'app-server', '--stdio'], env=env, cwd=cwd,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True)

        def reader():
            for line in self.process.stdout:
                try:
                    self.lines.put(json.loads(line))
                except ValueError:
                    pass
        threading.Thread(target=reader, daemon=True).start()
        self.init = self.rpc('initialize', {'clientInfo': {'name': 'isolated_voice_probe', 'version': '1'},
                                            'capabilities': {'experimentalApi': True}})
        self.write({'method': 'initialized', 'params': {}})

    def write(self, obj):
        self.process.stdin.write(json.dumps(obj) + '\n')
        self.process.stdin.flush()

    def rpc(self, method, params, timeout=20):
        self.serial += 1
        rid = self.serial
        self.write({'id': rid, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                item = self.lines.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if item.get('id') == rid:
                return item
        raise TimeoutError(method)

    def settle(self, seconds=4.0):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                self.lines.get(timeout=.3)
            except queue.Empty:
                pass

    def stop(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=4)
        except (ValueError, subprocess.TimeoutExpired):
            self.process.kill()


def session_of(raw: bytes):
    """The live-session JSON out of the multipart call-creation body."""
    text = raw.decode('utf8', 'replace')
    part = re.search(r'name="session"\r\nContent-Type: application/json\r\n\r\n(.*?)\r\n--codex-realtime-call-boundary',
                     text, re.S)
    return json.loads(part.group(1)) if part else None


def run():
    result = {
        'cli': subprocess.check_output([args.codex, '--version'], text=True).strip(),
        'backend': 'local synthetic fixture; no credentials; no external requests',
        'question': 'what does the spoken model receive when a call starts on a thread that already has a role',
        'cases': {},
        'assertions': [],
    }
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with tempfile.TemporaryDirectory(prefix='vp-', dir='/tmp') as scratch:
        base = Path(scratch)
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL')}
        for key in ('HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR'):
            directory = base / key.lower()
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        cwd = base / 'workspace'
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
        client = Client(env, cwd)
        thread = client.rpc('thread/start', {'cwd': str(cwd), 'model': 'probe-model', 'modelProvider': 'probe',
                                             'approvalPolicy': 'never', 'sandbox': 'read-only'})
        thread_id = thread['result']['thread']['id']

        # An INCUMBENT thread: a durable developer mandate, exactly the shape the
        # Viewer used to write its voice persona in, plus one ordinary exchange.
        client.rpc('thread/inject_items', {'threadId': thread_id, 'items': [
            {'type': 'message', 'id': 'probe-mandate', 'role': 'developer',
             'content': [{'type': 'input_text', 'text': MANDATE}]}]})
        captured.clear()
        client.rpc('turn/start', {'threadId': thread_id, 'clientUserMessageId': 'probe-first',
                                  'input': [{'type': 'text', 'text': 'confirm you hold the board tools.'}]})
        client.settle(5)
        backing = [body for path, body in captured if not path.endswith('/live')]
        result['cases']['backing_model'] = {
            'requests': len(backing),
            'sees_thread_mandate': any(MARKER in body.decode('utf8', 'replace') for body in backing),
        }

        common = {'threadId': thread_id, 'version': 'v3', 'model': 'gpt-live-1-codex',
                  'outputModality': 'audio', 'transport': {'type': 'webrtc', 'sdp': OFFER},
                  'clientManagedHandoffs': True, 'codexResponsesAsItems': True,
                  'includeStartupContext': True}
        cases = {
            # What the Viewer sent before #1629: no instructions for the spoken model.
            'without_prompt': dict(common),
            # What it sends now.
            'with_prompt': dict(common, **{
                'flushTranscriptTailOnSessionEnd': True,
                'prompt': f'SPOKEN PERSONA. {MANDATE}',
                'realtimeStartInstructions': f'{MARKER}: voice is active; keep this task role and tools.',
                'realtimeEndInstructions': f'{MARKER}: voice ended; resume text policy.',
            }),
        }
        for name, params in cases.items():
            captured.clear()
            client.rpc('thread/realtime/start', params, timeout=25)
            client.settle(5)
            calls = [body for path, body in captured if path.endswith('/live')]
            session = session_of(calls[0]) if calls else None
            instructions = (session or {}).get('instructions') or ''
            result['cases'][name] = {
                'call_creation_requests': len(calls),
                'session_keys': sorted((session or {}).keys()),
                'instructions_bytes': len(instructions.encode('utf8')),
                'instructions_are_the_stock_codex_persona': instructions.startswith('## Identity, tone, and role'),
                'spoken_model_sees_thread_mandate': MARKER in instructions,
                'initial_items': len((session or {}).get('initial_items') or []),
                'carries_a_tool_inventory': 'tools' in (session or {}),
            }

        # Every parameter this repair sends is deserialized rather than ignored:
        # an unknown field is accepted silently, an ill-typed known one is not.
        rejections = {
            'unknown_field_control': {'llvNotARealParameter': 12345},
            'prompt': {'prompt': 12345},
            'realtimeStartInstructions': {'realtimeStartInstructions': 12345},
            'realtimeEndInstructions': {'realtimeEndInstructions': 12345},
            'flushTranscriptTailOnSessionEnd': {'flushTranscriptTailOnSessionEnd': 'yes'},
        }
        result['cases']['parameter_deserialization'] = {}
        for name, extra in rejections.items():
            answer = client.rpc('thread/realtime/start', dict(common, **extra), timeout=25)
            result['cases']['parameter_deserialization'][name] = 'rejected' if 'error' in answer else 'accepted'
            client.settle(1)

        # None of the session-scoped strings may be written to canonical history;
        # the injected item, being an ordinary thread write, must be.
        read = client.rpc('thread/read', {'threadId': thread_id})
        path = (read.get('result') or {}).get('thread', {}).get('path')
        history = Path(path).read_text(encoding='utf8', errors='replace') if path else ''
        result['cases']['canonical_history'] = {
            'injected_developer_item_persisted': 'probe-mandate' in history,
            'spoken_prompt_persisted': 'SPOKEN PERSONA.' in history,
            'start_instructions_persisted': 'voice is active; keep this task role' in history,
            'end_instructions_persisted': 'voice ended; resume text policy' in history,
        }
        client.stop()

    checks = [
        ('the thread mandate reaches the backing model',
         result['cases']['backing_model']['sees_thread_mandate'] is True),
        ('without a prompt the spoken model runs the stock Codex persona',
         result['cases']['without_prompt']['instructions_are_the_stock_codex_persona'] is True),
        ('without a prompt the thread mandate does NOT reach the spoken model',
         result['cases']['without_prompt']['spoken_model_sees_thread_mandate'] is False),
        ('the spoken session carries no tool inventory of its own',
         result['cases']['without_prompt']['carries_a_tool_inventory'] is False),
        ('a prompt replaces the spoken model instructions',
         result['cases']['with_prompt']['spoken_model_sees_thread_mandate'] is True
         and result['cases']['with_prompt']['instructions_are_the_stock_codex_persona'] is False),
        ('an unknown parameter is ignored, so acceptance alone proves nothing',
         result['cases']['parameter_deserialization']['unknown_field_control'] == 'accepted'),
        ('every parameter this repair sends is deserialized',
         all(verdict == 'rejected' for name, verdict in result['cases']['parameter_deserialization'].items()
             if name != 'unknown_field_control')),
        ('an injected thread item is permanent',
         result['cases']['canonical_history']['injected_developer_item_persisted'] is True),
        ('no session-scoped string is written to canonical history',
         not any(result['cases']['canonical_history'][key] for key in
                 ('spoken_prompt_persisted', 'start_instructions_persisted', 'end_instructions_persisted'))),
    ]
    result['assertions'] = [{'check': check, 'held': held} for check, held in checks]
    result['held'] = all(held for _, held in checks)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    for check, held in checks:
        print(('PASS ' if held else 'FAIL ') + check)
    print(f"{sum(held for _, held in checks)}/{len(checks)} assertions held -> {args.output}")
    return 0 if result['held'] else 1


raise SystemExit(run())
