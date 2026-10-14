// OFFLINE protocol simulator. No Codex binary, credentials, files, network or models.
import { StringDecoder } from "node:string_decoder";
const decoder = new StringDecoder("utf8"); let buffer = "", threads = new Map(), threadCount = 0, turnCount = 0;
const mode = process.argv[2] ?? "normal";
const send = value => process.stdout.write(JSON.stringify(value)+"\n");
const reply = (id,result) => send({id,result});
const error = (id,code=-32603) => send({id,error:{code,message:"offline-rpc-error"}});
const notify = (method,params) => send({method,params});
const turn = (id,items=[],status="inProgress") => ({id,rootTurnId:null,items,itemsView:"full",status,error:status==="failed"?{message:"not-for-renderer",additionalDetails:null,codexErrorInfo:null}:null,startedAt:1,completedAt:status==="inProgress"?null:1,durationMs:null});
const metadata = t => ({id:t.id,sessionId:"offline",projectId:null,preview:"offline fixture",ephemeral:t.saved?false:true,name:t.title??null,path:t.saved?"/synthetic/private-never-in-renderer":null,historyMode:"legacy",modelProvider:"openai",createdAt:1,updatedAt:1,status:{type:"idle"},cwd:"/synthetic/chat",cliVersion:"0.162.1",source:"cli",turns:[...t.turns.values()].map(v=>turn(v.id,v.items,v.status))});
const agent = (id,text) => ({type:"agentMessage",id,text,phase:null,memoryCitation:null,delivery:null,questions:null});
const model = (name,isDefault) => ({id:name,model:name,displayName:name,description:"Offline fixture only",hidden:false,isDefault,inputModalities:["text"],supportsPersonality:false,supportedReasoningEfforts:[{reasoningEffort:"low",description:"fixture"}],defaultReasoningEffort:"low"});
for (const [id,title] of (["many-history","large-catalog","small-page-catalog"].includes(mode) ? Array.from({length:mode!=="many-history"?210:130},(_,n)=>["saved-"+n,"合成历史"+n]) : [["saved-z","合成历史Z"],["saved-a","合成历史A"],["saved-b","合成历史B"],["saved-c","合成历史C"]])) {
 const t={id,title,saved:true,turns:new Map()};
 for (const [index,key] of [[1,"turn-z"],[2,"turn-a"],[3,"turn-m"]]) {
   const u={type:"userMessage",id:key+"-user",clientId:null,content:[{type:"text",text:title+" 用户 "+index,text_elements:[]}]};
   const a=agent(key+"-agent",title+" 回应 "+index); t.turns.set(key,{id:key,items:[u,a],status:"completed"});
 }
 threads.set(id,t);
}
function serverPage(values,cursor,prefix,limit=2) {
 const start=cursor===null||cursor===undefined?0:Number(String(cursor).slice(prefix.length));
 const end=Math.min(start+limit,values.length),data=values.slice(start,end);
 return {data,nextCursor:end<values.length?prefix+end:null,backwardsCursor:data.length?prefix+start:null};
}
function finish(t,v,status) { if (v.status!=="inProgress") return; v.status=status; clearInterval(v.timer); notify("turn/completed",{threadId:t.id,turn:turn(v.id,v.items,status)}); }
function handle(m) {
  if(m.method==="initialize") return reply(m.id,{userAgent:"OFFLINE-chat-fixture",codexHome:"/synthetic/home",platformFamily:"unix",platformOs:"macos"});
  if(m.method==="initialized") return;
  if(m.method==="config/read") return reply(m.id,{config:{model_provider:mode==="unsafe-config"?"local":"openai",forced_login_method:"chatgpt",openai_base_url:"https://chatgpt.com/backend-api/codex",chatgpt_base_url:"https://chatgpt.com/backend-api/",notify:[],features:{hooks:false,shell_tool:mode==="unsafe-tools",unified_exec:false,view_image:false,apps:false,plugins:false,code_mode:false,multi_agent:false,multi_agent_v2:mode==="unsafe-agents",image_generation:false,browser_use:false,browser_use_external:false,browser_use_full_cdp_access:false,computer_use:mode==="unsafe-computer"},agents:{enabled:mode==="unsafe-agents"},web_search:"disabled",mcp_servers:{disabled:{enabled:false}}},origins:{},layers:null});
  if(m.method==="account/read") return reply(m.id,{account:mode==="no-account"?null:{type:"chatgpt",email:"fixture@example.invalid",planType:"pro"},requiresOpenaiAuth:true});
  if(m.method==="model/list") return reply(m.id,{data:[model("gpt-fixture-one",true),model("gpt-fixture-two",false)],nextCursor:null});
  if(m.method==="thread/start") { const id="chat-"+(++threadCount); const t={id,turns:new Map()};threads.set(id,t);return reply(m.id,{thread:metadata(t),model:m.params.model,modelProvider:"openai",cwd:"/synthetic/chat",approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"readOnly",networkAccess:false},reasoningEffort:"low",instructionSources:[],disabledPluginIds:[],serviceTier:null}); }
  if(m.method==="thread/list") {
    const saved=[...threads.values()].filter(t=>t.saved).map(t=>({...metadata(t),turns:[]}));
    // Intentional inclusive overlap: repeat last row on continuation.
    const page=serverPage(saved,m.params.cursor,"threads:",["many-history","large-catalog"].includes(mode)?20:2);
    if(m.params.cursor&&!["many-history","large-catalog","small-page-catalog"].includes(mode))page.data.unshift(saved[1]);
    return reply(m.id,page);
  }
  const t=threads.get(m.params?.threadId); if(!t) return error(m.id,-32600);
  if(m.method==="thread/read") { if(!t.saved&&m.params.includeTurns)return error(m.id,-32600); const result=metadata(t); if(!m.params.includeTurns) result.turns=[]; return mode==="slow-read" ? setTimeout(()=>reply(m.id,{thread:result}),400) : reply(m.id,{thread:result}); }
  if(m.method==="thread/turns/list") {
    if(!t.saved)return error(m.id,-32600);
    if(mode==="unsupported-history")return error(m.id,-32601);
    if(mode==="disconnect-history")return process.exit(0);
    const values=[...t.turns.values()].reverse().map(v=>turn(v.id,[...v.items,v.items[1]],v.status));
    const page=serverPage(values,m.params.cursor,"turns:");
    if(m.params.cursor)page.data.unshift(values[1]);
    if(mode==="bad-history-cursor")page.nextCursor=m.params.cursor??"turns:0";
    if(mode==="slow-history"&&t.id==="saved-z")return setTimeout(()=>reply(m.id,page),400);
    return reply(m.id,page);
  }
  if(m.method==="thread/items/list") return error(m.id,-32601);
  if(m.method==="turn/start") {
    const text=m.params.input[0].text; if(text.includes("[reply-error]")) return error(m.id);
    const id="chat-turn-"+(++turnCount),user={type:"userMessage",id:id+"-user",clientId:null,content:m.params.input};
    const a=agent(id+"-agent",""); const v={id,items:[user,a],status:"inProgress",text,timer:null}; t.turns.set(id,v);
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
