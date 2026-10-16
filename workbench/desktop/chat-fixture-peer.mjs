import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
// OFFLINE protocol simulator. No Codex binary, credentials, files, network or models.
import { StringDecoder } from "node:string_decoder";
const decoder = new StringDecoder("utf8"); let buffer = "", threads = new Map(), threadCount = 0, turnCount = 0, sections = new Map(), sectionCount = 0;
const mode = process.argv[2] ?? "normal";
if(mode==="control-section-names")sections.set("section-external",{id:"section-external",name:"External\nSection",appearance:null});
const statePath = process.argv[3]; if(statePath && (!statePath.startsWith("/")||statePath.includes("\0")))throw new Error("invalid-offline-state-path");
const persist = () => { if(!statePath)return;const value={threadCount,turnCount,sectionCount,sections:[...sections.values()],threads:[...threads.values()].filter(t=>t.saved).map(t=>({...t,turns:[...t.turns.values()].map(v=>({id:v.id,items:v.items,status:v.status,text:v.text}))}))};writeFileSync(statePath+".tmp",JSON.stringify(value),{mode:0o600});renameSync(statePath+".tmp",statePath); };
const send = value => process.stdout.write(JSON.stringify(value)+"\n");
const reply = (id,result) => send({id,result});
const error = (id,code=-32603) => send({id,error:{code,message:"offline-rpc-error"}});
const notify = (method,params) => send({method,params});
const turn = (id,items=[],status="inProgress") => ({id,rootTurnId:null,items,itemsView:"full",status,error:status==="failed"?{message:"not-for-renderer",additionalDetails:null,codexErrorInfo:null}:null,startedAt:1,completedAt:status==="inProgress"?null:1,durationMs:null});
const metadata = t => ({id:t.id,sessionId:"offline",projectId:null,forkedFromId:t.parent??null,section:t.sectionId?sections.get(t.sectionId)??null:null,preview:t.parent&&!t.hasOwnTurn?"":"offline fixture",ephemeral:t.saved?false:true,name:t.title??null,path:t.saved?"/synthetic/private-never-in-renderer":null,historyMode:"legacy",modelProvider:"openai",createdAt:1,updatedAt:1,status:{type:"idle"},cwd:"/synthetic/chat",cliVersion:"0.162.1",source:"cli",turns:[...t.turns.values()].map(v=>turn(v.id,v.items,v.status))});
const agent = (id,text) => ({type:"agentMessage",id,text,phase:null,memoryCitation:null,delivery:null,questions:null});
const model = (name,isDefault) => ({id:name,model:name,displayName:name,description:"Offline fixture only",hidden:false,isDefault,inputModalities:["text"],supportsPersonality:false,supportedReasoningEfforts:[{reasoningEffort:"low",description:"fixture"}],defaultReasoningEffort:"low"});
for (const [id,title] of (mode==="search-history"?Array.from({length:6},(_,n)=>["search-"+n,"合成搜索会话 "+n]):["many-history","large-catalog","small-page-catalog","large-section"].includes(mode) ? Array.from({length:mode!=="many-history"?210:130},(_,n)=>["saved-"+n,"合成历史"+n]) : (mode==="preview-history"?[["saved-z","合成历史Z"],["saved-a","合成历史A"],["saved-b","合成历史B"],["saved-c","合成历史C"],["saved-d","合成历史D"]]:[["saved-z","合成历史Z"],["saved-a","合成历史A"],["saved-b","合成历史B"],["saved-c","合成历史C"]]))) {
 const t={id,title,saved:true,turns:new Map(),...(mode==="large-section"?{sectionId:"section-large",position:threads.size}:{})};
 for (const [index,key] of [[1,"turn-z"],[2,"turn-a"],[3,"turn-m"]]) {
   const u={type:"userMessage",id:key+"-user",clientId:null,content:[{type:"text",text:title+" 用户 "+index,text_elements:[]}]};
   const a=agent(key+"-agent",title+" 回应 "+index); t.turns.set(key,{id:key,items:[u,a],status:"completed"});
 }
 if(mode==="search-history"){t.archived=id==="search-5";t.turns.get("turn-z").items[0].content[0].text+=" BODYNEEDLE 早期记录";}
 threads.set(id,t);
}
if(mode==="large-section")sections.set("section-large",{id:"section-large",name:"Large synthetic section",appearance:null});
if(statePath&&existsSync(statePath)){const v=JSON.parse(readFileSync(statePath,"utf8"));threadCount=v.threadCount;turnCount=v.turnCount;sectionCount=v.sectionCount??0;sections=new Map((v.sections??[]).map(s=>[s.id,s]));threads=new Map(v.threads.map(t=>[t.id,{...t,turns:new Map(t.turns.map(v=>[v.id,v]))}]));}
const reloadShared=()=>{if(mode!=="shared-management"||!statePath||!existsSync(statePath))return;const v=JSON.parse(readFileSync(statePath,"utf8"));threadCount=v.threadCount;turnCount=v.turnCount;sectionCount=v.sectionCount??0;sections=new Map((v.sections??[]).map(s=>[s.id,s]));threads=new Map(v.threads.map(t=>[t.id,{...t,turns:new Map(t.turns.map(v=>[v.id,v]))}]));};
if(mode==="shared-management"&&!existsSync(statePath))persist();
function serverPage(values,cursor,prefix,limit=2) {
 const start=cursor===null||cursor===undefined?0:Number(String(cursor).slice(prefix.length));
 const end=Math.min(start+limit,values.length),data=values.slice(start,end);
 return {data,nextCursor:end<values.length?prefix+end:null,backwardsCursor:data.length?prefix+start:null};
}
function finish(t,v,status) { if (v.status!=="inProgress") return; v.status=status; clearInterval(v.timer);persist(); notify("turn/completed",{threadId:t.id,turn:turn(v.id,v.items,status)}); }
function handle(m) {
  reloadShared();if(mode==="shared-management"&&m.method==="turn/start")return error(m.id,-32600);
  if(m.method==="initialize") return reply(m.id,{userAgent:"OFFLINE-chat-fixture",codexHome:"/synthetic/home",platformFamily:"unix",platformOs:"macos"});
  if(m.method==="initialized") return;
  if(m.method==="config/read") return reply(m.id,{config:{model_provider:mode==="unsafe-config"?"local":"openai",forced_login_method:"chatgpt",openai_base_url:"https://chatgpt.com/backend-api/codex",chatgpt_base_url:"https://chatgpt.com/backend-api/",notify:[],features:{background_paginated_rollout_migration:false,goals:mode==="unsafe-goals",daemon_auto_start:false,hooks:false,shell_tool:mode==="unsafe-tools",unified_exec:false,view_image:false,apps:false,plugins:false,code_mode:false,multi_agent:false,multi_agent_v2:mode==="unsafe-agents",image_generation:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:mode==="unsafe-computer"},agents:{enabled:mode==="unsafe-agents"},web_search:"disabled",mcp_servers:{disabled:{enabled:false}}},origins:{},layers:null});
  if(m.method==="account/read") return reply(m.id,{account:mode==="no-account"?null:{type:"chatgpt",email:"fixture@example.invalid",planType:"pro"},requiresOpenaiAuth:true});
  if(m.method==="model/list") return reply(m.id,{data:[model("gpt-fixture-one",true),model("gpt-fixture-two",false)],nextCursor:null});
  if(m.method==="threadSection/list"){if(mode==="unsupported-sections")return error(m.id,-32601);return reply(m.id,serverPage([...sections.values()],m.params.cursor,"sections:",20));}
  if(m.method==="threadSection/create"){const section={id:"section-"+(++sectionCount),name:m.params.name,appearance:mode==="section-appearance"?{icon:"star",color:"blue"}:null};sections.set(section.id,section);persist();if(mode==="section-create-timeout")return;return reply(m.id,{section});}
  if(m.method==="threadSection/update"){const section=sections.get(m.params.sectionId);if(!section||mode==="section-update-error")return error(m.id,-32600);section.name=m.params.name;if(Object.hasOwn(m.params,"appearance"))section.appearance=m.params.appearance;persist();return reply(m.id,{section});}
  if(m.method==="thread/start") { const id="chat-"+(++threadCount); const t={id,saved:!m.params.ephemeral,turns:new Map()};threads.set(id,t);persist();return reply(m.id,{thread:metadata(t),model:m.params.model,modelProvider:"openai",cwd:"/synthetic/chat",approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"readOnly",networkAccess:false},reasoningEffort:"low",instructionSources:[],disabledPluginIds:[],serviceTier:null}); }
  if(m.method==="thread/search") {
    const query=m.params.searchTerm.toLowerCase();
    const values=[...threads.values()].filter(t=>t.saved&&!!t.archived===!!m.params.archived).filter(t=>[...t.turns.values()].some(v=>v.items.some(i=>(i.text??i.content?.map(c=>c.text??"").join(" ")??"").toLowerCase().includes(query)))).map(t=>({thread:{...metadata(t),turns:[]},snippet:"BODYNEEDLE 早期记录"}));
    const page=serverPage(values,m.params.cursor,"search:",2);if(m.params.cursor&&values.length)page.data.unshift(values[0]);return mode==="search-history"?setTimeout(()=>reply(m.id,page),100):reply(m.id,page);
  }
  if(m.method==="thread/list") {
    const saved=[...threads.values()].filter(t=>t.saved && (!m.params.searchTerm||(t.title??"offline fixture").toLowerCase().includes(m.params.searchTerm.toLowerCase())) && !!t.archived===!!m.params.archived && (!t.parent||t.hasOwnTurn||m.params.sectionId) && (m.params.sectionId===undefined||((t.sectionId??null)===m.params.sectionId))).map(t=>({...metadata(t),turns:[]}));
    if(m.params.sortKey==="section_position")saved.sort((a,b)=>(threads.get(a.id).position??0)-(threads.get(b.id).position??0));
    // Intentional inclusive overlap: repeat last row on continuation.
    const page=serverPage(saved,m.params.cursor,"threads:",["many-history","large-catalog","large-section"].includes(mode)?20:2);
    if(!m.params.searchTerm&&!m.params.sectionId&&m.params.cursor&&!["many-history","large-catalog","small-page-catalog","large-section"].includes(mode))page.data.unshift(saved[1]);
    return reply(m.id,page);
  }
  const t=threads.get(m.params?.threadId); if(!t) return error(m.id,-32600);
  if(m.method==="thread/fork"){
    if(mode==="fork-error")return error(m.id,-32600);
    let inherited=[...t.turns];if(m.params.lastTurnId){const end=inherited.findIndex(([id])=>id===m.params.lastTurnId);if(end<0||inherited[end][1].status==="inProgress")return error(m.id,-32600);inherited=inherited.slice(0,end+1);}
    const fork={id:"fork-"+(++threadCount),saved:true,parent:t.id,title:t.title,turns:new Map(inherited.map(([key,v])=>[key,JSON.parse(JSON.stringify(v))]))};threads.set(fork.id,fork);persist();
    const value={thread:{...metadata(fork),id:mode==="wrong-fork"?t.id:fork.id,turns:[]},model:m.params.model,modelProvider:"openai",cwd:m.params.cwd,approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"readOnly",networkAccess:false},reasoningEffort:"low",instructionSources:[],disabledPluginIds:[],serviceTier:null,collaborationMode:null,turnsBackwardsCursor:null,itemsBackwardsCursor:null};
    if(mode==="fork-timeout")return;return mode==="slow-fork"?setTimeout(()=>reply(m.id,value),400):reply(m.id,value);
  }
  if(m.method==="thread/section/move"){if(mode==="section-move-error")return error(m.id,-32600);const sectionId=m.params.sectionId,anchor=m.params.beforeThreadId;if(sectionId&&!sections.has(sectionId)||anchor&&(anchor===t.id||threads.get(anchor)?.sectionId!==sectionId))return error(m.id,-32600);const ordered=[...threads.values()].filter(row=>row.id!==t.id&&row.sectionId===sectionId).sort((a,b)=>(a.position??0)-(b.position??0));const index=anchor?ordered.findIndex(row=>row.id===anchor):ordered.length;ordered.splice(index,0,t);t.sectionId=sectionId;for(const [position,row]of ordered.entries())row.position=position;persist();return reply(m.id,{});}
  if(m.method==="thread/name/set"){t.title=m.params.name.trim();persist();return reply(m.id,{});}
  if(m.method==="thread/archive"){if(mode==="late-archive")return setTimeout(()=>{t.archived=true;persist();reply(m.id,{});},1500);t.archived=true;persist();if(mode==="slow-archive")return;return reply(m.id,{});}
  if(m.method==="thread/unarchive"){t.archived=false;persist();return reply(m.id,{thread:{...metadata(t),id:mode==="wrong-unarchive"?"saved-a":t.id,turns:[]}});}
  if(m.method==="thread/resume"){
    if(!t.saved||t.archived)return error(m.id,-32600);
    const value={thread:{...metadata(t),turns:[]},model:m.params.model,modelProvider:mode==="unsafe-resume"?"local":"openai",cwd:m.params.cwd,approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"readOnly",networkAccess:false},reasoningEffort:"low",instructionSources:[],disabledPluginIds:[],serviceTier:null,collaborationMode:null,turnsBackwardsCursor:null,itemsBackwardsCursor:null};
    return mode==="slow-resume"?setTimeout(()=>reply(m.id,value),400):reply(m.id,value);
  }
  if(m.method==="thread/read") { if(!t.saved&&m.params.includeTurns)return error(m.id,-32600); const result=metadata(t);if(mode==="active-history")result.status={type:"active",activeFlags:[]}; if(!m.params.includeTurns) result.turns=[]; return mode==="slow-read" ? setTimeout(()=>reply(m.id,{thread:result}),400) : reply(m.id,{thread:result}); }
  if(m.method==="thread/turns/list") {
    if(!t.saved)return error(m.id,-32600);
    if(mode==="unsupported-history")return error(m.id,-32601);
    if(mode==="disconnect-history")return process.exit(0);
    const values=[...t.turns.values()].reverse().map(v=>turn(v.id,[...v.items,v.items[1]],v.status));
    const page=serverPage(values,m.params.cursor,"turns:");
    if(m.params.cursor)page.data.unshift(values[1]);
    if(mode==="bad-history-cursor")page.nextCursor=m.params.cursor??"turns:0";
    if((mode==="preview-history"&&t.id==="saved-z")||mode==="shared-management"||(mode==="slow-history"&&t.id==="saved-z")||(mode==="slow-fork-open"&&t.parent))return setTimeout(()=>reply(m.id,page),400);
    return reply(m.id,page);
  }
  if(m.method==="thread/items/list") return error(m.id,-32601);
  if(m.method==="turn/start") {
    t.hasOwnTurn=true;const text=m.params.input[0].text; if(text.includes("[reply-error]")) return error(m.id);
    const id="chat-turn-"+(++turnCount),user={type:"userMessage",id:id+"-user",clientId:null,content:m.params.input};
    const a=agent(id+"-agent",""); const v={id,items:[user,a],status:"inProgress",text,timer:null}; t.turns.set(id,v);persist();
    notify("turn/started",{threadId:t.id,turn:turn(id,[user])});
    notify("item/started",{threadId:t.id,turnId:id,startedAtMs:1000,item:user}); notify("item/started",{threadId:t.id,turnId:id,startedAtMs:1000,item:a});
    setTimeout(()=>reply(m.id,{turn:turn(id,[],"inProgress")}),text.includes("[slow]")?350:25);
    let chunks=["离线协议","流式验证","已完成。"],count=0;
    v.timer=setInterval(()=>{
      if(v.status!=="inProgress") return;
      const delta=chunks[count++]; a.text+=delta; notify("item/agentMessage/delta",{threadId:t.id,turnId:id,itemId:a.id,delta});
      if(text.includes("[disconnect]")) process.exit(0);
      if(count===chunks.length) { notify("item/completed",{threadId:t.id,turnId:id,completedAtMs:1000,item:a}); finish(t,v,text.includes("[fail]")?"failed":"completed"); }
    },text.includes("[slow]")?350:180); return;
  }
  if(m.method==="turn/interrupt") {
    const v=t.turns.get(m.params.turnId);if(!v)return error(m.id,-32602);
    if(v.text.includes("[finish-before-interrupt-error]")) { finish(t,v,"completed"); return setTimeout(()=>error(m.id),50); }
    reply(m.id,{}); if(v.text.includes("[no-cancel-terminal]")) return; setTimeout(()=>{finish(t,v,"interrupted");notify("item/agentMessage/delta",{threadId:t.id,turnId:v.id,itemId:v.id+"-agent",delta:"LATE_MUST_IGNORE"});},100);return;
  }
  error(m.id,-32601);
}
process.stdin.on("data",bytes=>{buffer+=decoder.write(bytes);if(buffer.length>65536)process.exit(3);let end;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);handle(JSON.parse(line));}});
process.stdin.on("end",()=>process.exit(0));
