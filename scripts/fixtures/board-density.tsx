import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {FileEntry} from '../../src/lib/types';
import type {BoardTask} from '../../src/lib/tasks/types';
import type {Pipeline, PipelineStageAttempt} from '../../src/lib/pipelines/types';
import type {Flow} from '../../src/lib/flows/types';
import {SchemeBoard} from "../../src/components/scheme/SchemeBoard";
const file=(n: number,busy=false): FileEntry=>({path:`/fixture/worker-${n}.jsonl`,conversationId:`fixture-${n}`,root:'claude-projects',name:`worker-${n}`,project:'density',title:`Recover delivery acknowledgement and verify durable conversation history ${n}`,engine:'claude',kind:'session',fmt:'claude',parent:null,mtime:2,size:1,activity:busy?'live':'idle',proc:busy?'running':null,pid:null,model:null,pendingQuestion:null,waitingInput:null,authoritativeTurn:{state:busy?'busy':'idle',source:'lifecycle',terminalAt:null}} as FileEntry);
const files=Array.from({length:75},(_,i)=>file(i,i===0));
files[1]!.durableLineage = {kind:"spawn",role:"builder",parentConversationId:files[0]!.conversationId!,reviewsConversationId:null,memberships:[]};
const tasks: BoardTask[]=Array.from({length:461},(_,i)=>({id:`task-${i}`,project:'density',text:`${i===0?'Current work':i===1?'Completed task with historical failed review':i<75?'Repair recorded conversation':'Merge approved board changes and recover durable delivery'} ${i}`,status:i===1?'done':'assigned',board:"shown",placement:'unplaced',assignments:i<75?[{path:files[i]!.path,conversationId:files[i]!.conversationId,panePid:null,state:'delivered',error:null,at:'2026-09-01T00:00:00Z'}]:[],createdAt:`2026-09-01T00:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}Z`,updatedAt:'2026-09-01T00:00:00Z'}));
tasks[2]!.assignments.push(tasks[0]!.assignments[0]!);
const role={roleId:null,engine:'codex',model:null,effort:null,access:'read-write',promptScaffold:null} as const;
const pipelines: Pipeline[]=Array.from({length:45},(_,i)=>({id:`pipeline-${i}`,task:`Historical board repair run ${i}`,taskIds:[`task-${i+1}`],project:'density',repoDir:'/fixture/repo',worktreeDir:'/fixture/worktree',branch:'pipeline/fixture',baseBranch:'main',baseRef:'abc',lastPassedCommit:'abc',stages:[{id:'build',kind:'run',prompt:'Implement the board repair. {{task}}',next:'review',effectiveRole:role},{id:'review',kind:'review-loop',prompt:'Review the board repair. {{prev.output}}',next:null,effectiveRole:role}],runs:[{stageId:'build',attempts:[{n:1,state:i%2?'needs_decision':'failed',agentPath:null,conversationId:null,flowId:null,effectiveRole:role,error:'Recorded attempt stopped before a conversation was attached.'} as PipelineStageAttempt]}],cursor:{stageId:'build',state:'pending',input:null,activatedBy:null},state:'needs_decision',pausedState:null,stateDetail:null,srcPath:null,srcConversationId:null,createdAt:'2026-09-01T00:00:00Z',closedAt:null}));
// A completed task with actual work must remain open. Duplicate reader ownership
// is exercised by task 2; task 1 holds an inactive historical attempt.
tasks[0]!.status = "done";
const flows: Flow[] = [{ id: "review-flow", project: "density", state: "approved", roles: { implementer: {engine:"claude",model:null,effort:null}, reviewer: {engine:"claude",model:null,effort:null} }, template:"implement-review-loop", cwd:"/fixture/repo", baseRef:"abc", baseMode:"head", mode:"manual", reviewerMode:"headless", roundLimit:3, stateDetail:null, implementerPath: files[0]!.path, rounds: [
  {n:1, reviewerPath:files[73]!.path, verdict:"APPROVE", findingsCount:0, terminalAt:"2026-09-01T00:00:00Z"}
], createdAt:"2026-09-01T00:00:00Z", closedAt:null } as Flow];
declare global { interface Window { densityFixture: { files: FileEntry[]; tasks: BoardTask[]; pipelines: Pipeline[] }; openHistoryTarget: () => void } }
window.densityFixture={files,tasks,pipelines};
function App(){const [selected,setSelected]=useState<string | null>(null);window.openHistoryTarget=()=>setSelected(files[1]!.path);return <SchemeBoard project="density" groups={[]} manual={files} files={files} flows={flows} tasks={tasks} allTasks={tasks} pipelines={pipelines} surfacePipelines={pipelines} drafts={[]} focus={selected} onSelect={f=>setSelected(f.path)} onClose={()=>setSelected(null)} onDraftClose={()=>{}} onDraftSpawned={()=>{}}/>;}
createRoot(document.getElementById('root')!).render(<App/>);
