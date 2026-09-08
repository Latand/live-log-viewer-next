// Technical module-swap harness adapted from the rejected preview's build script.
// Board geometry, fixtures, interactions and styles are independently authored.
import fs from 'node:fs';
import path from 'node:path';
const here = process.env.BOARD_ARTIFACT_ROOT ?? import.meta.dir;
if (here !== import.meta.dir && !process.env.BOARD_BUILD_OUT) throw new Error('A retained source requires an explicit separate BOARD_BUILD_OUT');
if (here !== import.meta.dir && path.resolve(process.env.BOARD_BUILD_OUT).startsWith(path.resolve(here) + path.sep)) throw new Error('Retained artifacts are read-only');
const repo = process.env.BOARD_SOURCE_ROOT ?? path.resolve(import.meta.dir, '../../../..');
const candidates = [path.join(repo, 'node_modules'), path.resolve(repo, '../live-log-viewer-next/node_modules'), ...fs.readdirSync(path.dirname(repo)).filter(name => name.startsWith('live-log-viewer-next-pipeline-')).map(name => path.join(path.dirname(repo), name, 'node_modules'))];
const modules = process.env.BOARD_MODULES_ROOT ?? candidates.find(dir => ['next', 'react', 'pdfjs-dist', 'playwright-core'].every(name => fs.existsSync(path.join(dir, name, 'package.json'))));
if (!modules) throw new Error('Set BOARD_MODULES_ROOT to a complete installed Viewer dependency directory');
const output = process.env.BOARD_BUILD_OUT ?? path.join(here, 'out/revision3');
fs.mkdirSync(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [path.join(here, 'renderer.tsx')], outdir: output,
  naming: 'viewer.js', target: 'browser', minify: false, sourcemap: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_RUNTIME_UI': '"0"',
    'import.meta.url': 'new URL("/assets/viewer.js", location.href).href',
  },
  plugins: [{ name: 'isolated-board-preview', setup(build) {
    build.onResolve({filter:/^@preview-visibility$/},()=>({path:path.join(here,'memory-log.ts')}));
    if(process.env.BOARD_PRODUCTION!=='1') build.onLoad({filter:/\/TmuxComposer\.tsx$/},async args=>{
      let source=fs.readFileSync(args.path,'utf8');
      const seam='withComposerAdmissionDeadline(admissionRequest, admissionTiming.admissionDeadlineMs)';
      if(!source.includes(seam))throw Error('Native admission seam changed');
      source='import { whenVisible } from "@preview-visibility";\n'+source.replace(seam,seam+'.then(async value => { await whenVisible(file.path); return value; }, async error => { await whenVisible(file.path); throw error; })');
      return {contents:source,loader:'tsx'};
    });
    if(process.env.BOARD_PRODUCTION==='1' && process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/SchemeBoard\.tsx$/}, async args => {
      let source=fs.readFileSync(args.path,'utf8');
      source=source.replace('  const tile = gridTilePx(cam.z);', `
        globalThis.__productionBoard = {
          snapshot: () => ({cam, vp, nodes: layout.nodes.map(({file,...rect})=>({...rect,path:file.path})), groups:layout.groups, tasks:placedTasks, expanded, selected, shown: typeof taskScene !== "undefined" && taskScene ? [...taskScene.shown] : null, edgeCrossings:layout.edges.filter(edge=>edge.routeCrosses).length, routes:[...taskRoutes], taskEdges}),
          reader: setSelected, camera: ({x,y,z}) => glideToCamera({x,y,zoom:z}), zoom: zoomTo, focus: stableSelect, expand: stableExpand, collapse: () => setExpanded(null),
        };
        const tile = gridTilePx(cam.z);`);
      return {contents:source,loader:'tsx'};
    });

    if(process.env.BOARD_PRODUCTION==='1' && process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/TmuxComposer\.tsx$/}, async args=>{
      let source=fs.readFileSync(args.path,'utf8');
      const start=source.indexOf('    const prune = () =>');
      const end=source.indexOf('    prune();',start);
      if(start<0||end<0)throw Error('Composer prune probe seam missing');
      const block=source.slice(start,end).replace('const prune = () =>','const prune = () => { const counts=(globalThis.__viewTimers??={});counts[file.path]=(counts[file.path]??0)+1; return')+'    };\n';
      source=source.slice(0,start)+block+source.slice(end);
      return {contents:source,loader:'tsx'};
    });
    if(process.env.BOARD_PRODUCTION==='1' && process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/NativeConversationPane\.tsx$/}, async args=>{
      const source=fs.readFileSync(args.path,'utf8').replace('}: Props) {','}: Props) { const counts=(globalThis.__ownerCounters??={});counts[pane.file.path]=(counts[pane.file.path]??0)+1;');
      return {contents:source,loader:'tsx'};
    });
    if(process.env.BOARD_PRODUCTION==='1' && process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/useLogTail\.ts$/}, async args=>{
      const source=fs.readFileSync(args.path,'utf8').replace('onChunk: (result) => {','onChunk: (result) => { const counts=(globalThis.__logCallbacks??={});counts[target]=(counts[target]??0)+1;');
      return {contents:source,loader:'ts'};
    });
    if(process.env.BOARD_PRODUCTION==='1' && process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/useRuntime\.ts$/}, async args=>{
      let source=fs.readFileSync(args.path,'utf8');
      source=source.replace('): T {', `): T {
        const auditRole=useRef(/TmuxComposerCore/.test(new Error().stack??'')?'delivery':/BranchPane|LogFeed|AgentControlStrip|RuntimePill|RuntimeComposerReceipts/.test(new Error().stack??'')?'native':'global').current;
        const audit=(kind)=>{const counts=(globalThis.__runtimeCallbacks??={});const key=auditRole+':'+kind;counts[key]=(counts[key]??0)+1;};`);
      source=source.replace('(listener: () => void) => (bus ? bus.subscribe(listener) : () => {}),','(listener: () => void) => (bus ? bus.subscribe(() => {audit("callback");listener();}) : () => {}),');
      source=source.replace('const next = selectorRef.current(bus.getState());','audit("selector");const next = selectorRef.current(bus.getState());');
      return {contents:source,loader:'ts'};
    });
    if(process.env.BOARD_PRODUCTION==='1' && process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/nodes\.tsx$/}, async args => {
      let source=fs.readFileSync(args.path,'utf8');
      source=source.replace('const NodeShell = memo(function NodeShell(props: NativeNodeProps) {', 'const NodeShell = memo(function NodeShell(props: NativeNodeProps) { globalThis.__shellCounters ??= {}; globalThis.__shellCounters[props.node.file.path]=(globalThis.__shellCounters[props.node.file.path]??0)+1;');
      source=source.replace(/(function NodeChrome\([^]*?\) \{)/, '$1 globalThis.__chromeCounters??={};globalThis.__chromeCounters[node.file.path]=(globalThis.__chromeCounters[node.file.path]??0)+1;');
      return {contents:source,loader:'tsx'};
    });
    if(process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/(board\.tsx|fixtures\.ts)$/}, async args => {
      let source=fs.readFileSync(args.path,'utf8');
      const target=args.path.endsWith('/board.tsx') ? /((?:function NativeSlot)\([^]*?\)\s*\{)/ : /(function latestSummary\([^]*?\)\s*\{)/;
      if(!target.test(source))throw Error('Outer wrapper counter seam missing: '+args.path);
      source=source.replace(target, '$1 globalThis.__outerWork ??= {}; globalThis.__outerWork.'+(args.path.endsWith('/board.tsx')?'wrappers':'summaries')+'=(globalThis.__outerWork.'+(args.path.endsWith('/board.tsx')?'wrappers':'summaries')+'??0)+1;');
      return {contents:source,loader:args.path.endsWith('.tsx')?'tsx':'ts'};
    });
    if(process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/feed\/parse\.ts$/},async args=>{
      const source=fs.readFileSync(args.path,'utf8');
      const target='const obj = JSON.parse(line);';
      if(!source.includes(target))throw Error('Parse counter seam missing');
      return {contents:source.replace(target,'globalThis.__countSourceParse?.(line); '+target),loader:'ts'};
    });
    if(process.env.BOARD_COUNTERS==='1') build.onLoad({filter:/\/(BranchPane|LogFeed)\.tsx$/}, async args => {
      let source=fs.readFileSync(args.path,'utf8');
      const targets=args.path.endsWith('/BranchPane.tsx')?[['BranchPane','panes'],['LastActivity','headers']]:[['LogFeed','feeds']];
      for(const [name,bucket] of targets) {
        const pattern=new RegExp('(function '+name+'\\([^]*?\\) \\{)');
        if(!pattern.test(source))throw new Error('Counter target missing: '+name);
        source=source.replace(pattern, '$1\n if(typeof window!=="undefined") { const c=(window.__nativeCounters??={});const p=(c[file.path]??={});p["'+bucket+'"]=(p["'+bucket+'"]??0)+1; }');
        if(bucket==='panes') source=source.replace(pattern, '$1\n useState(() => { const c=(window.__nativeCounters??={});const p=(c[file.path]??={});p.mounts=(p.mounts??0)+1;return 0; });');

      }
      if(args.path.endsWith('/BranchPane.tsx')) source=source.replace('setInterval(() => setNow(Date.now()), 10_000)', 'setInterval(() => { const counts=(globalThis.__viewTimers??={});counts[file.path]=(counts[file.path]??0)+1;setNow(Date.now()); }, 10_000)');
      if(args.path.endsWith('/LogFeed.tsx')) {
        source=source.replace('session.feed(tail.lines, tail.linesStart, file.activity === "live")', 'window.__withFeedInput(file.path, tail.lines, () => session.feed(tail.lines, tail.linesStart, file.activity === "live"))');
      }
      return {contents:source,loader:'tsx'};
    });

    build.onResolve({ filter: /^@native-board$/ }, () => ({ path: path.join(repo, 'src/components/scheme/SchemeBoard.tsx') }));
    if(process.env.BOARD_PRODUCTION!=='1') build.onResolve({ filter: /(?:^|\/)SchemeBoard(?:\.tsx)?$/ }, () => ({ path: path.join(here, 'board.tsx') }));
    if(process.env.BOARD_PRODUCTION!=='1') build.onResolve({ filter: /(?:^|\/)useLogTail(?:\.ts)?$/ }, () => ({ path: path.join(here, 'memory-log.ts') }));
    build.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync(path.join(repo, 'src', args.path.slice(2)), args.importer ? path.dirname(args.importer) : repo) }));
    build.onResolve({ filter: /^qrcode$/ }, () => ({ path: path.join(modules, 'qrcode/lib/browser.js') }));
    build.onResolve({ filter: /^[^./][^:]*$/ }, args => {
      const resolved = Bun.resolveSync(args.path, modules);
      return { path: resolved, ...(!path.isAbsolute(resolved) ? { external: true } : {}) };
    });
  } }],
});
if (!result.success) { console.error(result.logs); process.exit(1); }
fs.mkdirSync(path.join(here, 'assets'), { recursive: true });
if (process.env.BOARD_PRODUCTION === '1') {
  const { default: postcss } = await import(path.join(modules, 'postcss/lib/postcss.mjs'));
  const { default: tailwind } = await import(path.join(modules, '@tailwindcss/postcss/dist/index.mjs'));
  const from = path.join(repo, 'src/app/globals.css');
  const compiled = await postcss([tailwind({ base: repo })]).process(fs.readFileSync(from, 'utf8'), { from });
  fs.writeFileSync(path.join(here, 'assets/production.css'), compiled.css);
}
// Preserve the reviewed native stylesheet during correction builds.
if (!fs.existsSync(path.join(here, 'assets/viewer.css'))) {
// Read only the serving application's public HTML and CSS, never its API data.
const origin = process.env.BOARD_CSS_SOURCE ?? 'http://127.0.0.1:8898';
const html = await (await fetch(origin)).text();
const urls = [...new Set([...html.matchAll(/href="([^\"]+\.css(?:\?[^\"]*)?)"/g)].map(m => new URL(m[1], origin).href))];
if (!urls.length) throw new Error('No native stylesheet found');
let css = (await Promise.all(urls.map(async url => {
  const r = await fetch(url); if (!r.ok) throw new Error('Native stylesheet unavailable'); return r.text();
}))).join('\n');
// Localize any font assets as well; browsers never need the serving application.
for (const match of [...css.matchAll(/url\(["']?([^\)"']+)["']?\)/g)]) {
  if (match[1].startsWith('data:')) continue;
  const url = new URL(match[1], urls[0]);
  if (url.origin !== new URL(origin).origin) throw new Error('External CSS asset refused');
  const filename = path.basename(url.pathname);
  const r = await fetch(url); if (!r.ok) throw new Error('Native CSS asset unavailable');
  fs.writeFileSync(path.join(here, 'assets', filename), Buffer.from(await r.arrayBuffer()));
  css = css.replaceAll(match[1], './' + filename);
}
fs.writeFileSync(path.join(here, 'assets/viewer.css'), css);
}
console.log(JSON.stringify({ localArtifact: true, output: path.relative(here,output), bytes: fs.statSync(path.join(output,'viewer.js')).size }));
