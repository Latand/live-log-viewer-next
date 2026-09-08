/** Bounded Viewer research reader. Inject an authenticated MCP call function.
 * No filesystem, shell, lifecycle, publication, or transcript-file access.
 * The caller stores returned data outside Git with private permissions.
 */
export async function extract(call, plan) {
  if (!plan.runId || !Array.isArray(plan.windows) || plan.windows.length > 20)
    throw new Error('A unique runId and at most 20 explicit windows are required');
  const pageLimit = plan.pageLimit ?? 80, maxPages = plan.maxPages ?? 4;
  const maxChars = plan.maxChars ?? 6000, maxCalls = plan.maxCalls ?? 60;
  if (![pageLimit,maxPages,maxChars,maxCalls].every(Number.isInteger) ||
      pageLimit < 1 || pageLimit > 200 || maxPages < 1 || maxPages > 30 ||
      maxChars < 1 || maxChars > 16000 || maxCalls < 1 || maxCalls > 200)
    throw new Error('Invalid bounded budget');
  const queries = plan.queries ?? [];
  if (queries.length > 5) throw new Error('At most five search phrasings');
  const aliases = [...(plan.redactLiterals ?? [])].filter(Boolean).sort((a,b)=>b.length-a.length);
  function redact(value) {
    if (typeof value === 'string') {
      let s = value.replace(/<!--[\s\S]*?-->/g, '[context metadata omitted]')
        .replace(/(?:\/home\/|\/Users\/)[^\s"'<>\\]+/g, '[private path]')
        .replace(/[A-Z]:\\Users\\[^\s"'<>]+/gi, '[private path]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:key|token|k|signature|sig)=)[^&\s"']+/gi, '$1[redacted]');
      for (const literal of aliases) s = s.split(literal).join('[private identity]');
      return s;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>
      [k, /^(accountId|account|sessionId|srcPath|agentPath|transcriptPath|token|apiKey|authorization)$/i.test(k)
        ? '[private reference]' : redact(v)]));
    return value;
  }
  let count = 0;
  const calls = [], warnings = [], windows = [], searches = [];
  async function read(name,args) {
    if (!['search_transcripts','conversation_messages','get_task','get_pipeline','deployment_status'].includes(name))
      throw new Error('Read tool is not allowlisted');
    if (count >= maxCalls) throw new Error('Call budget exhausted');
    const clientRequestId = `${plan.runId}-${++count}`;
    const response = await call(name,{...args,clientRequestId});
    const data = response.structuredContent ?? (response.content
      ? JSON.parse(response.content.find(c=>c.type==='text').text) : response);
    calls.push({name,clientRequestId,args:redact(args),ok:data.ok !== false});
    if (data.ok === false || response.isError) throw new Error(`Viewer refused ${name}: ${data.code ?? 'unknown'}`);
    return data;
  }
  // Search snippets are pointers. Only explicit windows become evidence.
  for (const project of plan.project ? [plan.project,undefined] : [undefined])
    for (const query of queries) {
      const data = await read('search_transcripts',{query,...(project?{project}:{}),limit:5});
      searches.push(redact({query,project,total:data.total,items:data.items,nextCursor:data.nextCursor}));
    }
  for (const window of plan.windows) {
    if (!window.label || !Number.isFinite(Date.parse(window.since)) || !Number.isFinite(Date.parse(window.until)) ||
        Date.parse(window.until)<Date.parse(window.since) || !(window.conversationId || window.transcriptPath))
      throw new Error('Window requires identity, label, and ordered ISO bounds');
    let cursor = window.cursor, exhausted = false;
    const records = [], seen = new Set(), cursors = new Set(), pages = [];
    for (let page=0;page<maxPages;page++) {
      const data = await read('conversation_messages',{
        ...(window.conversationId?{conversationId:window.conversationId}:{transcriptPath:window.transcriptPath}),
        since:window.since,kinds:['message','tool_call','tool_result'],roles:['user','assistant','tool'],
        limit:pageLimit,maxChars,...(cursor?{cursor}:{})});
      if (!Array.isArray(data.records)) throw new Error('Malformed Viewer page');
      pages.push({count:data.records.length,hasMore:data.hasMore,scanned:data.scanned,
        newest:data.records[0]?.ts ?? null,oldest:data.records.at(-1)?.ts ?? null});
      for (const record of data.records) {
        if (!Number.isFinite(Date.parse(record.ts))) {warnings.push(`${window.label}: invalid timestamp`);continue;}
        if (Date.parse(record.ts)<Date.parse(window.since)||Date.parse(record.ts)>Date.parse(window.until)) continue;
        const id = `${record.seq}:${record.kind}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const text = String(record.text ?? '');
        const truncated = Boolean(record.truncated || text.length > maxChars);
        if (truncated) warnings.push(`${window.label}:${record.seq}: truncated; inspect the original API page`);
        // kind is provenance, never a verdict: normalized tool_call can embed a result.
        records.push(redact({...record,text:text.slice(0,maxChars),truncated,
          evidenceClass:record.kind==='message'?'statement':'tool record; inspect request/result separately'}));
      }
      if (!data.hasMore) {exhausted=true;break;}
      if (!data.cursor || cursors.has(data.cursor)) throw new Error('Missing or repeated Viewer cursor');
      cursor=data.cursor;cursors.add(cursor);
    }
    if (!exhausted) warnings.push(`${window.label}: bounded page limit reached; coverage incomplete`);
    records.sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)||a.seq-b.seq);
    windows.push({label:window.label,conversationId:window.conversationId ?? null,since:window.since,
      until:window.until,pages,exhausted,nextCursor:exhausted?null:cursor,records});
  }
  const readbacks=[];
  for(const item of plan.readbacks??[]) {
    if (!['get_task','get_pipeline','deployment_status'].includes(item.tool)) throw new Error('Invalid readback tool');
    readbacks.push({label:item.label,tool:item.tool,data:redact(await read(item.tool,item.args))});
  }
  return {schemaVersion:1,runId:plan.runId,privateOnly:true,publicationReady:false,
    calls,searches,windows,readbacks,warnings};
}
