"""Summarize this investigation's generated schemas and pinned source snapshots."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--state', type=Path, required=True, help='Private schema/source directory outside checkout')
args = parser.parse_args()
STATE = args.state.resolve()
if STATE.is_relative_to(ROOT.parents[2]):
    parser.error('State must be outside the checkout')
UP = STATE / 'upstream'
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(exist_ok=True)


def load(path):
    return json.loads(path.read_text())


def methods(schema):
    return {v['properties']['method']['enum'][0]: v for v in schema['oneOf']}


stable = load(STATE / 'stable-schema/ClientRequest.json')
experimental = load(STATE / 'experimental-schema/ClientRequest.json')
sm, em = methods(stable), methods(experimental)
baseline = methods(load(UP / 'rust-v0.151.0/ClientRequest.json'))
upstream = methods(load(UP / '54e04f25dbfe342bf84809d1880dbca32cb43cf6/ClientRequest.json'))
source_files = {}
repo = ROOT.parents[2]
for file in (repo / 'src').rglob('*'):
    if file.suffix in ['.ts', '.tsx'] and '.test.' not in file.name and '/fixtures/' not in str(file):
        source_files[str(file.relative_to(repo))] = file.read_text()

families = {
    'initialize': 'Connection identity and capability admission',
    'thread': 'History, input, lifecycle, goals, and metadata; see compatibility matrix',
    'turn': 'Generation, steering, interruption, and settings; see compatibility matrix',
    'threadSection': 'Deferred: Viewer already owns board organization',
    'project': 'Deferred: preserve Viewer project/worktree grouping',
    'skills': 'Use existing skill discovery; refresh configuration through controlled account scope',
    'hooks': 'Discovery useful for explaining tool actions; do not change policy implicitly',
    'marketplace': 'Deferred: installation has separate user intent and source policy',
    'plugin': 'Read/reconcile can explain stale tools; installations remain explicit',
    'app': 'Expose account-scoped tool availability through existing capabilities',
    'fs': 'Deferred: existing Viewer file access; avoid a second mutation surface',
    'model': 'Read model capabilities; preserve explicitly selected model',
    'modelProvider': 'Read capability/auth status; never infer subscription eligibility',
    'experimentalFeature': 'Read supported feature state; avoid blanket enablement',
    'permissionProfile': 'Read named permission profiles; retain access/sandbox distinction',
    'mcpServer': 'Account-scoped tool/auth health; event streams remain experimental',
    'config': 'Retain managed account configuration ownership',
    'configRequirements': 'Read effective requirements before offering restricted settings',
    'account': 'Existing subscription account flow; spending and outbound messages require explicit intent',
    'command': 'Deferred: existing tool and runtime ownership controls',
    'process': 'Deferred: experimental process control would expand lifecycle authority',
    'remoteControl': 'Deferred: keep Viewer the single operator management surface',
    'environment': 'Deferred: remote executor environments need a separate product requirement',
    'windowsSandbox': 'Platform-specific readiness; no Linux implementation work',
    'review': 'Deferred: preserve visible Viewer review stages and independent reviewer contract',
    'externalAgentConfig': 'Deferred: importing history/configuration is a separate user action',
    'feedback': 'Deferred: diagnostic upload is an external publication action',
    'memory': 'Deferred: global reset is destructive and unrelated to message delivery',
    'server': 'Optional content-free diagnostics; no replacement lifecycle authority',
    'collaborationMode': 'Read-only discovery for supported mode controls',
    'fuzzyFileSearch': 'Optional mention picker; existing UI remains owner',
    'mock': 'Test-only; never expose',
}
rows = []
for method in em:
    variant = em[method]
    param = variant['properties'].get('params', {})
    ref = param.get('$ref', '').rsplit('/', 1)[-1]
    definition = experimental.get('definitions', {}).get(ref, param)
    refs = []
    for file, content in source_files.items():
        for number, line in enumerate(content.splitlines(), 1):
            if f'"{method}"' in line or f"'{method}'" in line:
                refs.append(f'{file}:{number}')
                break
    rows.append({'method': method, 'schemaTier': 'default' if method in sm else 'experimental',
                 'paramsType': ref, 'required': definition.get('required', []),
                 'fields': list(definition.get('properties', {})), 'viewerLiteralReferences': refs,
                 'disposition': families.get(method.split('/')[0], 'Deferred: no current requirement')})

manifest = {'observedDate': '2026-09-08', 'installed': '0.153.4',
            'viewerHead': '88e5a9508be2802266734056d6436f3168201cad',
            'releaseCommit': '3d2ee51ca2d5db578f328aa75e20aa22c0197c9a',
            'upstreamMain': '54e04f25dbfe342bf84809d1880dbca32cb43cf6',
            'defaultMethods': len(sm), 'experimentalAdditionalMethods': len(em.keys()-sm.keys()),
            'defaultMethodsAddedSince0151': sorted(sm.keys()-baseline.keys()),
            'defaultMethodsRemovedSince0151': sorted(baseline.keys()-sm.keys()),
            'defaultMethodsAddedOnMain': sorted(upstream.keys()-sm.keys()),
            'methods': rows}
EVIDENCE.joinpath('method-inventory.json').write_text(json.dumps(manifest, indent=2)+'\n')
chosen = ['InitializeParams', 'InitializeResponse', 'ThreadInjectItemsParams', 'ThreadInjectItemsResponse',
          'ThreadQueueAddParams', 'ThreadQueueAddResponse', 'ThreadQueueListParams', 'ThreadQueueStartParams',
          'TurnStartParams', 'TurnSteerParams', 'UserInput', 'ThreadTurnsListParams', 'ThreadItemsListParams',
          'ToolRequestUserInputParams', 'ThreadSettingsUpdateParams', 'TurnSettingsUpdateParams']
selected = {}
for name in chosen:
    found = list((STATE/'experimental-schema').rglob(name+'.json'))
    if found:
        selected[name] = load(found[0])
    elif name in experimental['definitions']:
        selected[name] = experimental['definitions'][name]
EVIDENCE.joinpath('selected-schemas.json').write_text(json.dumps(selected, indent=2)+'\n')
lines = ['# Installed method catalog', '',
         'Generated from Codex 0.153.4. Default-schema membership is not a guarantee that every field, backend, or account supports a method. Experimental methods require `initialize.capabilities.experimentalApi: true`.', '',
         'Source references are literal matches in product source at the pinned Viewer HEAD. They locate candidates for inspection; they do not prove the method executes or is fully supported. The design report gives the behavior and adoption decision.', '',
         '| Method | Schema | Viewer reference | Disposition |', '|---|---|---|---|']
for row in rows:
    refs = ', '.join(f'`{r}`' for r in row['viewerLiteralReferences'][:2]) or 'No literal match'
    lines.append(f"| `{row['method']}` | {row['schemaTier']} | {refs} | {row['disposition']} |")
ROOT.joinpath('METHOD-CATALOG.md').write_text('\n'.join(lines)+'\n')
checksums = {}
for path in [STATE/'stable-schema/ClientRequest.json', STATE/'experimental-schema/ClientRequest.json',
             *UP.glob('*/ClientRequest.json'), *UP.glob('*/codex-rs/**/*.rs')]:
    checksums[str(path.relative_to(STATE))] = hashlib.sha256(path.read_bytes()).hexdigest()
EVIDENCE.joinpath('source-sha256.json').write_text(json.dumps(checksums, indent=2)+'\n')
print(json.dumps({'defaultMethods':len(sm),'experimentalMethods':len(em)-len(sm), 'selectedSchemas':len(selected)}))
