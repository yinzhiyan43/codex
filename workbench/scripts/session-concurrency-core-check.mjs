// Explicit native check with synthetic records, isolated HOME and denied network. No turn/start.
import { prepareIsolatedCore, DEFAULT_CORE_BINARY } from "../desktop-host/isolated-core.ts";
import { officialRouteOverrides, assertOfficialChatConfiguration } from "../desktop-host/official-config.ts";
import { JsonlDecoder } from "../protocol-adapter/jsonl.ts";
import { spawn } from "node:child_process";
import { mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import assert from "node:assert/strict";
const cli=process.argv.slice(2);if(cli.length&&(cli.length!==2||cli[0]!=="--result"||!cli[1]?.startsWith("/")||cli[1].includes("\0")))throw new Error("invalid-native-persistence-arguments");
const types={initialize:["v1/InitializeParams","v1/InitializeResponse"],"config/read":["v2/ConfigReadParams","v2/ConfigReadResponse"],"thread/list":["v2/ThreadListParams","v2/ThreadListResponse"],"thread/read":["v2/ThreadReadParams","v2/ThreadReadResponse"],"thread/turns/list":["v2/ThreadTurnsListParams","v2/ThreadTurnsListResponse"],"thread/start":["v2/ThreadStartParams","v2/ThreadStartResponse"],"thread/resume":["v2/ThreadResumeParams","v2/ThreadResumeResponse"],"thread/fork":["v2/ThreadForkParams","v2/ThreadForkResponse"],"thread/name/set":["v2/ThreadSetNameParams","v2/ThreadSetNameResponse"],"thread/archive":["v2/ThreadArchiveParams","v2/ThreadArchiveResponse"],"thread/unarchive":["v2/ThreadUnarchiveParams","v2/ThreadUnarchiveResponse"]};
const ajv=new Ajv({strict:false,validateFormats:false}),validators={};for(const [method,pair] of Object.entries(types))validators[method]=await Promise.all(pair.map(async name=>ajv.compile(JSON.parse(await readFile(new URL("../../codex-rs/app-server-protocol/schema/json/"+name+".json",import.meta.url),"utf8")))));
for(const [method,pair] of Object.entries({"threadSection/update":["ThreadSectionUpdateParams","ThreadSectionUpdateResponse"],"threadSection/list":["ThreadSectionListParams","ThreadSectionListResponse"],"threadSection/create":["ThreadSectionCreateParams","ThreadSectionCreateResponse"],"thread/section/move":["ThreadSectionMoveParams","ThreadSectionMoveResponse"]}))validators[method]=await Promise.all(pair.map(async name=>ajv.compile(JSON.parse(await readFile(new URL("../../codex-rs/app-server-protocol/schema/json/v2/"+name+".json",import.meta.url),"utf8")))));
const prepared=await prepareIsolatedCore(new URL("../tests/real-core/.runs/",import.meta.url).pathname);
const result={result:"failed",twoConcurrentClients:true,identity:prepared.identity,isolatedSyntheticData:true,networkDeniedByPolicy:true,modelRequests:0,turnStartRequests:0,processes:[],methods:[]};
const ids=[1,2,3,4].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
try {
for(let n=0;n<3;n++){
 const stamp=`2026-10-14T01:00:0${n}Z`,filenameStamp=stamp.replaceAll(':','-').replace('Z','');
 const line=(type,payload)=>({timestamp:stamp,type,payload});
 const lines=[line('session_meta',{id:ids[n],session_id:ids[n],timestamp:stamp,cwd:prepared.cwd,originator:'codex',cli_version:'0.162.1',source:'cli',model_provider:'openai',history_mode:'legacy',base_instructions:null,dynamic_tools:null})];
 for(let t=1;t<=3;t++){
  const id='probe-turn-'+t;
  lines.push(line('event_msg',{type:'task_started',turn_id:id,model_context_window:null}),line('event_msg',{type:'user_message',message:`SYNTHETIC ${n+1} USER ${t}`,images:[],local_images:[],text_elements:[]}),line('event_msg',{type:'agent_message',message:`SYNTHETIC ${n+1} ANSWER ${t}`}),line('event_msg',{type:'task_complete',turn_id:id,last_agent_message:`SYNTHETIC ${n+1} ANSWER ${t}`}));
 }
 const directory=join(prepared.codexHome,'sessions','2026','10','14');await mkdir(directory,{recursive:true});
 const path=join(directory,`rollout-${filenameStamp}-${ids[n]}.jsonl`);await writeFile(path,lines.map(v=>JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
}
} catch(error) { await rm(prepared.directory,{recursive:true,force:true}); throw error; }

const paginatedId=ids[3],stamp="2026-10-14T01:00:04Z",lines=[];
const add=(type,payload)=>lines.push({timestamp:stamp,ordinal:lines.length,type,payload});
try{
 add("session_meta",{id:paginatedId,session_id:paginatedId,timestamp:stamp,cwd:prepared.cwd,originator:"codex",cli_version:"0.162.1",source:"cli",model_provider:"openai",history_mode:"paginated",base_instructions:null,dynamic_tools:null});
 for(let n=1;n<=3;n++){
   const turn="paged-turn-"+n,user="SYNTHETIC PAGINATED USER "+n,answer="SYNTHETIC PAGINATED ANSWER "+n;
   add("event_msg",{type:"task_started",turn_id:turn,root_turn_id:turn,started_at:10,model_context_window:null});
   add("response_item",{type:"message",role:"user",content:[{type:"input_text",text:user}]});
   add("event_msg",{type:"item_completed",thread_id:paginatedId,turn_id:turn,item:{type:"UserMessage",id:turn+"-user",content:[{type:"text",text:user,text_elements:[]}]},started_at_ms:0,completed_at_ms:1});
   add("response_item",{type:"message",role:"assistant",content:[{type:"output_text",text:answer}]});
   add("event_msg",{type:"item_completed",thread_id:paginatedId,turn_id:turn,item:{type:"AgentMessage",id:turn+"-agent",content:[{type:"Text",text:answer}]},started_at_ms:0,completed_at_ms:1});
   add("event_msg",{type:"task_complete",turn_id:turn,root_turn_id:turn,last_agent_message:answer,started_at:10,completed_at:20,duration_ms:10000});
 }
 await writeFile(join(prepared.codexHome,"sessions","2026","10","14","rollout-2026-10-14T01-00-04-"+paginatedId+".jsonl"),lines.map(line=>JSON.stringify(line)).join("\n")+"\n",{mode:0o600});
}catch(error){await rm(prepared.directory,{recursive:true,force:true});throw error;}
const disabled={...officialRouteOverrides(),sqlite_home:join(prepared.directory,"durable-state"),'features.goals':false,'features.daemon_auto_start':false,'features.apps':false,'features.plugins':false,'features.memories':false,'features.shell_tool':false,'features.unified_exec':false,'features.view_image':false,'features.multi_agent':false,'features.multi_agent_v2':false,'agents.enabled':false,'features.code_mode':false,'features.image_generation':false,'features.browser_use':false,'features.browser_use_external':false,'features.browser_use_full_cdp_access':false,'features.computer_use':false,'skills.include_instructions':false,project_doc_max_bytes:0,web_search:'disabled'};
try{await mkdir(disabled.sqlite_home,{mode:0o700});}catch(error){await rm(prepared.directory,{recursive:true,force:true});throw error;}let sequence=0,client=null,other=null;
function launch(phase){
 const child=spawn("/usr/bin/sandbox-exec",["-f",prepared.policyPath,DEFAULT_CORE_BINARY,"app-server","--listen","stdio://","--strict-config",...Object.entries(disabled).flatMap(([key,value])=>["-c",key+"="+JSON.stringify(value)])],{cwd:prepared.cwd,env:prepared.environment,shell:false,stdio:["pipe","pipe","pipe"]});
 const decoder=new JsonlDecoder(1024*1024),pending=new Map();let fatal=null,closed=false;const closedPromise=new Promise(resolve=>child.once("close",()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("native-process-closed"));}pending.clear();resolve();}));child.stderr.resume();child.on("error",()=>{fatal="native-spawn-failed";});child.stdin.on("error",()=>{fatal="native-input-closed";});
 child.stdout.on("data",bytes=>{try{for(const frame of decoder.push(bytes)){if(frame.id!==undefined&&frame.method){fatal="unexpected-server-request";child.stdin.write(JSON.stringify({id:frame.id,error:{code:-32601,message:"Synthetic persistence check has no callbacks"}})+"\n");continue;}const p=pending.get(frame.id);if(!p)continue;pending.delete(frame.id);clearTimeout(p.timer);if(frame.error)p.reject(Object.assign(new Error("native-persistence-rpc-error"),{code:frame.error.code}));else if(!validators[p.method][1](frame.result))p.reject(new Error("native-persistence-schema-invalid"));else p.resolve(frame.result);}}catch{fatal="native-frame-invalid";}});
 const rpc=(method,params)=>{if(!validators[method]||!validators[method][0](params))throw new Error("invalid-probe-rpc");result.methods.push({phase,method});const id="persist-"+(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error("native-persistence-timeout"));},10000);pending.set(id,{method,resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+"\n");});};
 const initialize=async()=>{await rpc("initialize",{clientInfo:{name:"isolated_persistence_probe",version:"0.1.0"},capabilities:{experimentalApi:false,requestAttestation:false}});result.methods.push({phase,method:"initialized"});child.stdin.write('{"method":"initialized"}\n');const config=await rpc("config/read",{includeLayers:false});assertOfficialChatConfiguration(config.config);};
 const stop=async()=>{child.stdin.end();let a,b,c;try{await Promise.race([closedPromise,new Promise((_,reject)=>{a=setTimeout(()=>child.kill("SIGTERM"),2000);b=setTimeout(()=>child.kill("SIGKILL"),4000);c=setTimeout(()=>reject(new Error("native-close-unconfirmed")),6000);})]);}finally{clearTimeout(a);clearTimeout(b);clearTimeout(c);}result.processes.push({phase,exitCode:child.exitCode,signal:child.signalCode});if(fatal||child.exitCode!==0||child.signalCode!==null)throw new Error(fatal??"native-close-failed");};
 return {rpc,initialize,stop,isClosed:()=>closed};
}
try{



 const sourcePath=join(prepared.codexHome,"sessions","2026","10","14","rollout-2026-10-14T01-00-04-"+paginatedId+".jsonl"),sourceBytes=await readFile(sourcePath);
 client=launch("client-A");await client.initialize();
 const params={threadId:paginatedId,lastTurnId:"paged-turn-2",cwd:prepared.cwd,modelProvider:"openai",ephemeral:false,approvalPolicy:"never",sandbox:"read-only",excludeTurns:true};const first=await client.rpc("thread/fork",params),second=await client.rpc("thread/fork",params),firstId=first.thread.id,secondId=second.thread.id;
 const section=(await client.rpc("threadSection/create",{name:"SYNTHETIC ORIGINAL"})).section,sectionId=section.id,otherId=(await client.rpc("threadSection/create",{name:"SYNTHETIC OTHER"})).section.id;
 await client.rpc("threadSection/update",{sectionId,name:"SYNTHETIC ORIGINAL",appearance:{icon:"star",color:"blue"}});
 for(const threadId of [firstId,secondId,paginatedId])await client.rpc("thread/section/move",{threadId,sectionId});
 const listing={limit:20,archived:false,sectionId,sortKey:"section_position",sortDirection:"asc",sourceKinds:["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]};
 const observed=(await client.rpc("thread/list",listing)).data.map(t=>t.id);assert.deepEqual(observed,[firstId,secondId,paginatedId]);
 other=launch("client-B");await other.initialize();assert.deepEqual((await other.rpc("thread/list",listing)).data.map(t=>t.id),observed);result.sameStateAcrossClients=true;
 await other.rpc("thread/section/move",{threadId:secondId,sectionId,beforeThreadId:firstId});const reordered=(await client.rpc("thread/list",listing)).data.map(t=>t.id);assert.deepEqual(reordered,[secondId,firstId,paginatedId]);assert.notDeepEqual(reordered,observed);result.externalReorderObserved=true;
 await other.rpc("threadSection/update",{sectionId,name:"SYNTHETIC EXTERNAL NAME"});const renamed=(await client.rpc("threadSection/list",{limit:20})).data.find(s=>s.id===sectionId);assert.equal(renamed.name,"SYNTHETIC EXTERNAL NAME");assert.deepEqual(renamed.appearance,{icon:"star",color:"blue"});result.externalRenameObserved=true;result.externalAppearancePreserved=true;
 await other.rpc("thread/section/move",{threadId:firstId,sectionId:otherId});const moved=await client.rpc("thread/read",{threadId:firstId,includeTurns:false});assert.equal(moved.thread.section.id,otherId);assert.deepEqual((await client.rpc("thread/list",listing)).data.map(t=>t.id),[secondId,paginatedId]);result.externalMembershipObserved=true;
 await other.rpc("thread/name/set",{threadId:firstId,name:"SYNTHETIC EXTERNAL CONVERSATION"});assert.equal((await client.rpc("thread/read",{threadId:firstId,includeTurns:false})).thread.name,"SYNTHETIC EXTERNAL CONVERSATION");result.externalThreadRenameObserved=true;
 await client.stop();client=null;await other.rpc("threadSection/update",{sectionId,name:"SYNTHETIC AFTER A DISCONNECT"});result.otherClientSurvivesDisconnect=true;
 client=launch("client-A-reconnect");await client.initialize();const reconnected=(await client.rpc("threadSection/list",{limit:20})).data.find(s=>s.id===sectionId);assert.equal(reconnected.name,"SYNTHETIC AFTER A DISCONNECT");assert.equal((await client.rpc("thread/read",{threadId:firstId,includeTurns:false})).thread.section.id,otherId);assert.deepEqual((await client.rpc("thread/list",listing)).data.map(t=>t.id),[secondId,paginatedId]);result.reconnectReadsExternalUpdates=true;
 const textPass=async()=>{const page=await client.rpc("thread/turns/list",{threadId:paginatedId,limit:20,sortDirection:"desc",itemsView:"full"});assert.equal(page.nextCursor,null);assert.equal(page.data.length,3);assert.ok(page.data.every(t=>t.status!=="inProgress"));return page.data.map(t=>({id:t.id,status:t.status,text:t.items.flatMap(i=>i.type==="userMessage"?i.content.filter(c=>c.type==="text").map(c=>c.text):i.type==="agentMessage"?[i.text]:[])}));};const body=await textPass();assert.deepEqual(await textPass(),body);result.completeSavedTextDoubleRead=true;result.sourceTurns=3;
 assert.ok((await readFile(sourcePath)).equals(sourceBytes));result.sourceRolloutBytesUnchanged=true;assert.equal(result.methods.some(row=>["turn/start","thread/start","thread/resume","thread/share","thread/delete"].includes(row.method)),false);
 await client.stop();client=null;await other.stop();other=null;result.result="passed";

}catch(error){result.error=error.message;result.errorCode=error.code??null;}
finally{for(const active of [client,other])if(active){try{await active.stop();}catch(error){result.closeError=error.message;}}const closed=[client,other].every(active=>active===null||active.isClosed());result.cleanupConfirmed=closed;if(closed)await rm(prepared.directory,{recursive:true,force:true});if(cli[1])await writeFile(cli[1],JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));process.exitCode=result.result==="passed"?0:1;}
