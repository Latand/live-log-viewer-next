"""Rebuild the pinned inventory inputs privately; verify every downloaded digest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--codex', default='codex')
    args = parser.parse_args()
    state = args.state.resolve()
    if state.is_relative_to(ROOT.parents[2]):
        parser.error('State must be outside the checkout')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = json.loads((ROOT/'evidence/source-sha256.json').read_text())
    with tempfile.TemporaryDirectory(prefix='ca-', dir='/tmp') as temp:
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL')}
        for key in ('HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME',
                    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'LLV_STATE_DIR', 'TMPDIR'):
            directory = Path(temp)/key.lower()
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        version = subprocess.check_output([args.codex, '--version'], env=env, text=True).strip()
        expected = json.loads((ROOT/'evidence/versions.json').read_text())['cliVersion']
        if version != 'codex-cli ' + expected:
            raise SystemExit('Installed CLI differs from the pinned inventory')
        for tier, flags in (('stable', []), ('experimental', ['--experimental'])):
            destination = state/(tier+'-schema')
            # Reuse an existing cache without overwriting it; its digest is checked below.
            if not destination.exists():
                subprocess.run([args.codex, 'app-server', 'generate-json-schema',
                                '--out', str(destination), *flags], env=env, check=True)
    for name, expected in manifest.items():
        destination = state/name
        if not destination.exists():
            _, revision, source = name.split('/', 2)
            if source == 'ClientRequest.json':
                source = 'codex-rs/app-server-protocol/schema/json/ClientRequest.json'
            url = 'https://raw.githubusercontent.com/openai/codex/' + revision + '/' + source
            data = urllib.request.urlopen(url, timeout=30).read()
            if hashlib.sha256(data).hexdigest() != expected:
                raise SystemExit('Downloaded source digest mismatch: ' + name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
            raise SystemExit('Cached source digest mismatch: ' + name)
    print(json.dumps({'verifiedInputs': len(manifest), 'cli': version}))


if __name__ == '__main__':
    main()
