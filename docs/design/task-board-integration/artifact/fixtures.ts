import type { FileEntry } from '@/lib/types';

export const PROJECT = 'sample-workspace';
export type Point = { x: number; y: number };
export type WorkNode = Point & {
  id: string; kind: 'conversation' | 'task' | 'stage'; title: string;
  role: string; status: 'running' | 'done' | 'waiting' | 'queued';
  group?: string; detail: string; file?: FileEntry;
};
export type WorkEdge = { from: string; to: string; label?: string; kind?: 'fail' | 'assignment' };
const now = Date.now();
const pathFor = (id: string) => `/fixture/conversations/${id}.jsonl`;
const fileFor = (id: string, title: string, status: WorkNode['status'], role: string): FileEntry => ({
  path: pathFor(id), name: `${id}.jsonl`, root: 'codex-sessions', project: PROJECT,
  projectName: 'Workspace', title, engine: 'codex', kind: 'session', fmt: 'codex',
  cwd: '/fixture/workspace', parent: id === 'coordinator' ? null : pathFor('coordinator'),
  conversationId: `conversation_sample_${id}`, mtime: now / 1000, size: 2400,
  activity: status === 'running' ? 'live' : status === 'waiting' ? 'recent' : 'idle',
  proc: status === 'running' || status === 'waiting' ? 'running' : 'done', pid: null,
  model: 'gpt-6-astra', effort: 'high', pendingQuestion: null, waitingInput: null,
  userAuthored: true, derivationComplete: true, renamable: true,
  durableLineage: { kind: 'spawn', role, parentConversationId: id === 'coordinator' ? null : 'conversation_sample_coordinator', reviewsConversationId: null, memberships: [] },
});
function conversation(id: string, title: string, role: string, status: WorkNode['status'], x: number, y: number, group?: string, detail = ''): WorkNode {
  return { id, kind: 'conversation', title, role, status, x, y, group, detail, file: fileFor(id, title, status, role) };
}
export const nodes: WorkNode[] = [
  conversation('coordinator', 'Coordinate workspace', 'Orchestrator', 'running', 120, 1400, undefined, 'Owns three tasks. Delegated work stays connected to this conversation.'),
  { id: 'reconnect', kind: 'task', title: 'Reliable reconnects', role: 'Task 01', status: 'running', x: 1250, y: 300, group: 'recovery', detail: 'A conversation should resume with its original messages and draft after a lost connection. The current review found a stale ownership check.' },
  conversation('repair', 'Restore the connection', 'Build · round 2', 'running', 2220, 170, 'recovery', 'Repairing the ownership check identified in review.'),
  conversation('review', 'Check session ownership', 'Review · returned', 'waiting', 3200, 170, 'recovery', 'One finding returned to Build. Verification waits for a clean review.'),
  { id: 'verify', kind: 'stage', title: 'Rehearse reconnect', role: 'Verify · next', status: 'queued', x: 4170, y: 300, group: 'recovery', detail: 'Waiting for Review to pass. No worker has been launched for this stage.' },
  { id: 'search', kind: 'task', title: 'Find past decisions', role: 'Task 02', status: 'running', x: 1250, y: 1430, group: 'search', detail: 'Search long conversations without blocking the current feed. Indexing and ranking can progress independently before integration.' },
  conversation('index', 'Incremental indexing', 'Builder', 'running', 2220, 1100, 'search', 'Indexes newly appended messages without reparsing the whole transcript.'),
  conversation('ranking', 'Rank useful context', 'Research · complete', 'done', 2220, 1840, 'search', 'A relevance experiment using invented conversations. Results are ready for integration.'),
  conversation('integrate', 'Connect search results', 'Integrator', 'running', 3200, 1450, 'search', 'Joins the new index with ranked results and opens the original message.'),
  { id: 'drafts', kind: 'task', title: 'Keep drafts in place', role: 'Task 03', status: 'done', x: 1250, y: 2710, group: 'drafts', detail: 'Unsent text survives opening a conversation, navigating the board and returning. The two stages are complete.' },
  conversation('compose', 'Preserve unsent text', 'Build · passed', 'done', 2220, 2710, 'drafts', 'Drafts remain owned by their conversation identity.'),
  conversation('navigation', 'Verify board navigation', 'Review · passed', 'done', 3200, 2710, 'drafts', 'Checked return navigation, keyboard focus and draft preservation.'),
];
export const edges: WorkEdge[] = [
  { from: 'coordinator', to: 'reconnect', kind: 'assignment' },
  { from: 'coordinator', to: 'search', kind: 'assignment' },
  { from: 'coordinator', to: 'drafts', kind: 'assignment' },
  { from: 'reconnect', to: 'repair', label: 'assigned' },
  { from: 'repair', to: 'review', label: 'review' },
  { from: 'review', to: 'repair', label: '1 finding · return to build', kind: 'fail' },
  { from: 'review', to: 'verify', label: 'on pass' },
  { from: 'search', to: 'index', label: 'assigned' },
  { from: 'search', to: 'ranking' },
  { from: 'index', to: 'integrate', label: 'integrate' },
  { from: 'ranking', to: 'integrate' },
  { from: 'drafts', to: 'compose', label: 'assigned' },
  { from: 'compose', to: 'navigation', label: 'passed' },
];
export const groups = [
  { id: 'recovery', label: 'Recovery pipeline', note: 'Review returned a finding', x: 850, y: -300, w: 3770, h: 1100, tone: 'waiting' },
  { id: 'search', label: 'Search workstream', note: 'Two workers → integration', x: 850, y: 850, w: 2820, h: 1380, tone: 'running' },
  { id: 'drafts', label: 'Conversation pipeline', note: 'Complete', x: 850, y: 2260, w: 2820, h: 920, tone: 'done' },
];
// A little horizontal room pays for readable role/state labels.
for (const n of nodes) n.x *= 1.25;
for (const g of groups) { g.x *= 1.25; g.w *= 1.25; }
export const files = nodes.flatMap(n => n.file ? [n.file] : []);
// A denser local workload. The same renderer consumes these ordinary nodes/edges.
// Twenty-four conversations, six tasks, a repeated review and a shared dependency.
export const denseNodes: WorkNode[] = [conversation('coordinator', 'Coordinate release work', 'Orchestrator', 'running', 3950, -650, undefined, 'Owns six workstreams in this synthetic release.')];
export const denseEdges: WorkEdge[] = [];
export const denseGroups: typeof groups = [];
const denseTitles = [
  ['Reconnect safely', 'Restore ownership after a delayed reconnect response', 'Review generation boundaries', 'Rehearse recovery under interrupted writes', 'Verify the final handoff'],
  ['Search past decisions', 'Index long conversations incrementally', 'Check ranked search results', 'Connect results to the original message', 'Review keyboard search navigation'],
  ['Keep drafts', 'Retain unsent text while navigating', 'Review draft ownership', 'Exercise multi-conversation changes', 'Check native full-window return'],
  ['Prepare the release', 'Build the candidate package', 'Review the release notes', 'Rehearse the candidate upgrade', 'Verify the completion evidence'],
  ['Trace dependencies', 'Join search and conversation context', 'Review shared indexing contracts', 'Check late arriving worker results', 'Inspect cross-task navigation'],
  ['Improve accessibility', 'Verify keyboard access to graph controls', 'Review labels at desktop sizes', 'Check reduced-motion transitions'],
];
for (let i = 0; i < 6; i++) {
  const gx = 200 + i % 3 * 2600, gy = Math.floor(i / 3) * 1900, group = `dense-${i + 1}`;
  denseGroups.push({ id: group, label: denseTitles[i][0], note: '', x: gx, y: gy - 200, w: 2300, h: 1850, tone: i === 0 ? 'waiting' : i === 2 ? 'done' : 'running' });
  const task: WorkNode = { id: `${group}-task`, kind: 'task', title: denseTitles[i][0], role: `Task 0${i + 1}`, status: i === 2 ? 'done' : 'running', x: gx + 1150, y: gy + 30, group, detail: `Synthetic workstream ${i + 1}. ${i === 4 ? 'Shares the index from Search past decisions.' : 'Workers pass their output through this connected task.'}` };
  denseNodes.push(task); denseEdges.push({ from: 'coordinator', to: task.id, kind: 'assignment' });
  const positions = [[575, 600], [1725, 600], [1725, 1320], [575, 1320]];
  for (let j = 0; j < denseTitles[i].length - 1; j++) {
    const id = `${group}-${j + 1}`, status = i === 2 ? 'done' : i === 0 && j === 1 ? 'waiting' : j === 3 ? 'done' : 'running';
    const role = j === 0 ? (i === 0 ? 'Build · round 2' : 'Build') : j === 1 ? 'Review' : j === 2 ? 'Verify' : 'Research';
    const n = conversation(id, denseTitles[i][j + 1], role, status, gx + positions[j][0], gy + positions[j][1], group, `${denseTitles[i][j + 1]}. ${i === 0 && j === 0 ? 'The first review returned an ownership finding; this is the second build round.' : 'The native conversation below contains the sample work and its handoff.'}`);
    denseNodes.push(n); denseEdges.push({ from: j ? `${group}-${j}` : task.id, to: id, label: j ? undefined : 'assigned' });
  }
}
denseEdges.push({ from: 'dense-1-2', to: 'dense-1-1', kind: 'fail', label: '1 finding · return to build' });
denseEdges.push({ from: 'dense-2-3', to: 'dense-5-1', label: 'shared index' });
export const transcript = new Map<string, string[]>();
const dialogues: Record<string, string[]> = {
  coordinator: ['Keep the reconnect, search and composer work moving. Show me anything that needs a decision.', 'The reconnect review returned one finding to the builder. Search indexing and ranking are running in parallel. Draft preservation has passed review.', 'Keep the current conversation and draft visible when I move around the board.', 'Each worker has a single place in the graph. I will hold the verification stage until the ownership review passes.'],
  repair: ['Fix the reconnect boundary. Keep the original conversation identity and unsent text.', 'I reproduced the stale ownership check after a brief disconnect. The conversation is still present; the reconnect path reads the earlier host generation.', 'Cover the case where the first response arrives late.', 'The repair now checks the current generation before reconnecting. I am exercising the late-response case and checking that it cannot replace the newer connection.'],
  review: ['Review the reconnect behavior, including a late response from the earlier connection.', 'The draft survives navigation and reconnect. I found one ownership race: an older response can replace the current connection after it has already recovered.', 'Send the finding back to Build and keep verification waiting.', 'Returned one finding to the builder. The next review will exercise both response orders before allowing verification.'],
  index: ['Index new messages incrementally. Keep long conversations responsive.', 'The index now consumes only the appended region. Existing search results remain available while a longer conversation is being read.', 'Make sure results open at the original message.', 'I am attaching each result to its source record. The integration worker can use that identity to open the right place in the native conversation.'],
  ranking: ['Find a useful order for matching past decisions.', 'I compared exact phrases, title matches and recent decision messages using a small synthetic set.', 'What should integration use?', 'Use phrase relevance first and show the original message alongside its conversation title. Recency can break ties. The sample is ready for integration.'],
  integrate: ['Connect indexing and ranking to conversation navigation.', 'The two workers feed this integration point. I am checking that selecting a result opens the original conversation without losing the current draft.', 'Keep Return predictable.', 'Return restores the camera and selected conversation. I am checking repeated visits and native feed scroll position.'],
  compose: ['Preserve unsent text while navigating between conversations.', 'Draft storage is keyed by conversation identity. Moving around the board retains the current textarea value.', 'Check a full conversation visit as well.', 'The same draft is available in the native full conversation. Returning to the board restores the draft and its conversation position.'],
  navigation: ['Review keyboard navigation, camera return and draft preservation.', 'The navigation checks passed. Escape returns to the prior camera, and a dragged conversation stays pinned when another worker posts an update.', 'Can the position return to automatic layout?', 'Yes. Release restores the automatic anchor for that conversation. Other conversation positions and drafts remain intact.'],
};
function line(role: string, text: string, seq: number) {
  return JSON.stringify({ timestamp: new Date(now - 240000 + seq * 45000).toISOString(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
}
for (const file of [...files, ...denseNodes.flatMap(n => n.file ? [n.file] : [])]) {
  const id = file.conversationId!.replace('conversation_sample_', '');
  transcript.set(file.path, (dialogues[id] ?? [`Work on: ${file.title}. Keep the parent task and related workers in view.`, 'I have checked the current inputs and prepared the first change. The related review will verify the result before the next stage proceeds.', 'Retain the draft and the original message when navigating to a related worker.', 'The sample handoff is ready. I will keep this conversation in place while the other workstreams continue.']).map((text, i) => line(i % 2 ? 'assistant' : 'user', text, i)));
}
export function appendMessage(path: string, role: string, text: string) {
  const prior = transcript.get(path) ?? [];
  transcript.set(path, [...prior, line(role, text, 6 + prior.length)]);
  if(typeof window!=='undefined'){
    const store=(window as any).__durableFixture??={messages:{},receipts:{}};
    store.messages[path]=(store.messages[path]??0)+1;
    window.dispatchEvent(new CustomEvent('sample-transcript', { detail: path }));
  }
}

export const taskFixtures = nodes.filter(n => n.kind === 'task').map(n => ({
  id: n.id, project: PROJECT, status: n.status === 'done' ? 'done' : 'assigned', text: `${n.title}\n${n.detail}`,
  placement: 'auto', pos: { x: n.x, y: n.y }, source: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  assignments: edges.filter(e => e.from === n.id).map(e => ({ path: nodes.find(n => n.id === e.to)?.file?.path ?? null, conversationId: `conversation_sample_${e.to}`, panePid: null, state: 'delivered', error: null, at: new Date(now).toISOString() })),
}));
const largeScenes = new Map<string, {nodes:WorkNode[];edges:WorkEdge[];groups:typeof groups}>();
export function fixtureScene(mode: string) {
  if(mode==='scale-100'||mode==='scale-1000'){
    if(largeScenes.has(mode))return largeScenes.get(mode)!;
    const count=mode==='scale-100'?100:1000;
    const result={nodes:[...denseNodes],edges:[...denseEdges],groups:denseGroups};
    for(let i=denseNodes.filter(n=>n.file).length;i<count;i++){
      const g=denseGroups[i%6],id=mode+'-'+i;
      const n=conversation(id,'Inspect synthetic dependency and preserve conversation context '+i,'Verify','running',g.x+500+(Math.floor(i/6)%8)*1000,g.y+2100+Math.floor(i/48)*800,g.id,'Scale fixture only.');
      result.nodes.push(n);result.edges.push({from:g.id+'-task',to:id,label:'assigned'});
      transcript.set(n.file!.path,[line('user','Synthetic scale input '+i,0),line('assistant','Synthetic scale result '+i,1)]);
    }
    largeScenes.set(mode,result);return result;
  }
  return mode === 'dense' ? { nodes: denseNodes, edges: denseEdges, groups: denseGroups }
    : mode === 'small' ? { nodes: nodes.filter(n => !n.group || n.group === 'recovery'), edges: edges.filter(e => ['coordinator', 'reconnect', 'repair', 'review', 'verify'].includes(e.from) && ['coordinator', 'reconnect', 'repair', 'review', 'verify'].includes(e.to)), groups: groups.filter(g => g.id === 'recovery') }
    : { nodes, edges, groups };
}
export function selectFixtureScene(mode: string) {
  const scene = fixtureScene(mode);
  files.splice(0, files.length, ...scene.nodes.flatMap(n => n.file ? [n.file] : []));
  taskFixtures.splice(0, taskFixtures.length, ...scene.nodes.filter(n => n.kind === 'task').map(n => ({
    id: n.id, project: PROJECT, status: n.status === 'done' ? 'done' : 'assigned', text: `${n.title}\n${n.detail}`, placement: 'auto', pos: { x: n.x, y: n.y }, source: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), assignments: scene.nodes.filter(worker=>worker.group===n.group&&worker.file).map(worker=>({path:worker.file!.path,conversationId:worker.file!.conversationId!,panePid:null,state:'delivered',error:null,at:new Date(now).toISOString()})),
  })));
  window.dispatchEvent(new Event('llv:files-changed'));
}
export function latestSummary(n: WorkNode) {
  const lines = n.file ? transcript.get(n.file.path) ?? [] : [];
  for (const text of [...lines].reverse()) {
    const record = JSON.parse(text);
    if (record.payload?.role === 'assistant') return record.payload.content[0].text as string;
  }
  return n.detail;
}

if(typeof window!=='undefined') (window as any).__fixtureSource={
  append:appendMessage, lines:(path:string)=>transcript.get(path),
  receipt:(key:string,state:string)=>{const store=(window as any).__durableFixture??={messages:{},receipts:{}};store.receipts[key]=state;}
};
