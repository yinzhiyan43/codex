// Explicit isolated native metadata/history probe. Never reads the user's CODEX_HOME.
import { prepareIsolatedCore, DEFAULT_CORE_BINARY } from '../desktop-host/isolated-core.ts';
import { officialRouteOverrides } from '../desktop-host/official-config.ts';
import { JsonlDecoder } from '../protocol-adapter/jsonl.ts';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv from 'ajv';
import assert from 'node:assert/strict';
const argumentsList=process.argv.slice(2);
if(argumentsList.length && (argumentsList.length!==2 || argumentsList[0]!=='--result' || !argumentsList[1]?.startsWith('/') || argumentsList[1].includes('\0'))) throw new Error('history-probe-arguments-invalid');
const output=argumentsList[1]??null;
const methods=[],pending=new Map();let child,sequence=0,failure=null;
const types={'initialize':['v1/InitializeParams','v1/InitializeResponse'],'thread/list':['v2/ThreadListParams','v2/ThreadListResponse'],'thread/read':['v2/ThreadReadParams','v2/ThreadReadResponse'],'thread/turns/list':['v2/ThreadTurnsListParams','v2/ThreadTurnsListResponse'],'thread/resume':['v2/ThreadResumeParams','v2/ThreadResumeResponse'],'thread/start':['v2/ThreadStartParams','v2/ThreadStartResponse']};
const validators={},ajv=new Ajv({strict:false,validateFormats:false});
for(const [method,pair] of Object.entries(types)) validators[method]=await Promise.all(pair.map(async type=>ajv.compile(JSON.parse(await readFile(new URL('../../codex-rs/app-server-protocol/schema/json/'+type+'.json',import.meta.url),'utf8')))));
const prepared=await prepareIsolatedCore(new URL('../tests/real-core/.runs/',import.meta.url).pathname);
const result={result:'failed',isolatedSyntheticData:true,networkDeniedByPolicy:true,identity:prepared.identity,modelRequests:0,methods};
const ids=[1,2,3].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
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
function rpc(method,params){if(!validators[method]||!validators[method][0](params))throw new Error('invalid-fixed-history-request:'+method);methods.push(method);const id='history-'+(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('history-rpc-timeout'));},10000);pending.set(id,{method,resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
const restrictions={...officialRouteOverrides(),'features.apps':false,'features.plugins':false,'features.memories':false,'features.shell_tool':false,'features.unified_exec':false,'features.multi_agent':false,'features.multi_agent_v2':false,'agents.enabled':false,'features.code_mode':false,'features.browser_use':false,'features.computer_use':false,'skills.include_instructions':false,project_doc_max_bytes:0,web_search:'disabled'};
const args=['-f',prepared.policyPath,DEFAULT_CORE_BINARY,'app-server','--listen','stdio://','--strict-config',...Object.entries(restrictions).flatMap(([key,value])=>['-c',key+'='+JSON.stringify(value)])];
try{
 child=spawn('/usr/bin/sandbox-exec',args,{cwd:prepared.cwd,env:prepared.environment,shell:false,stdio:['pipe','pipe','pipe']});
 const decoder=new JsonlDecoder(1024*1024);child.stderr.resume();child.on('error',()=>{failure='native-spawn-failed';});child.stdin.on('error',()=>{failure='native-input-closed';});
 child.stdout.on('data',bytes=>{try{for(const frame of decoder.push(bytes)){if(frame.id!==undefined&&!frame.method){const p=pending.get(frame.id);if(!p)continue;pending.delete(frame.id);clearTimeout(p.timer);if(frame.error)p.reject(Object.assign(new Error('history-rpc-error'),{code:frame.error.code}));else if(!validators[p.method][1](frame.result))p.reject(new Error('invalid-history-response:'+p.method));else p.resolve(frame.result);}else if(frame.id!==undefined&&frame.method){failure='unexpected-server-request';child.stdin.write(JSON.stringify({id:frame.id,error:{code:-32601,message:'History probe provides no callbacks'}})+'\n');}}}catch{failure='invalid-native-history-output';}});
 await rpc('initialize',{clientInfo:{name:'isolated_history_probe',version:'0.1.0'},capabilities:{experimentalApi:false,requestAttestation:false}});methods.push('initialized');child.stdin.write('{"method":"initialized"}\n');
 const first=await rpc('thread/list',{limit:1,sortKey:'created_at',sortDirection:'desc',modelProviders:[],archived:false});assert.equal(first.data.length,1);assert.equal(first.data[0].id,ids[2]);assert.ok(first.nextCursor);
 const second=await rpc('thread/list',{limit:1,sortKey:'created_at',sortDirection:'desc',modelProviders:[],archived:false,cursor:first.nextCursor});assert.equal(second.data[0].id,ids[1]);result.threadListCursorConfirmed=true;
 const saved=await rpc('thread/read',{threadId:ids[0],includeTurns:true});assert.equal(saved.thread.turns.length,3);assert.equal(saved.thread.ephemeral,false);result.persistedFullReadTurns=saved.thread.turns.length;
 const page=await rpc('thread/turns/list',{threadId:ids[0],limit:1,sortDirection:'desc',itemsView:'full'});assert.equal(page.data.length,1);assert.equal(page.data[0].id,'probe-turn-3');assert.equal(page.data[0].itemsView,'full');assert.equal(page.data[0].items.length,2);assert.ok(page.nextCursor);
 const next=await rpc('thread/turns/list',{threadId:ids[0],limit:1,sortDirection:'desc',itemsView:'full',cursor:page.nextCursor});assert.equal(next.data[0].id,'probe-turn-2');result.serverFullTurnCursorConfirmed=true;
 const restored=await rpc('thread/resume',{threadId:ids[0],cwd:prepared.cwd,modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only',excludeTurns:false});assert.equal(restored.thread.id,ids[0]);assert.equal(restored.thread.turns.length,3);result.metadataResumeConfirmed=true;
 const refreshed=await rpc('thread/read',{threadId:ids[0],includeTurns:true});assert.equal(refreshed.thread.turns.length,3);result.restoredThreadRefreshConfirmed=true;
 const fresh=await rpc('thread/start',{cwd:prepared.cwd,modelProvider:'openai',ephemeral:true,approvalPolicy:'never',sandbox:'read-only'});assert.equal(fresh.thread.ephemeral,true);
 const current=await rpc('thread/read',{threadId:fresh.thread.id,includeTurns:false});assert.equal(current.thread.id,fresh.thread.id);result.ephemeralMetadataRefreshConfirmed=true;
 for(const [method,params,key] of [['thread/read',{threadId:fresh.thread.id,includeTurns:true},'ephemeralFullReadCode'],['thread/turns/list',{threadId:fresh.thread.id,limit:1,itemsView:'full'},'ephemeralTurnsCode']]){try{await rpc(method,params);throw new Error('unexpected-ephemeral-history-success');}catch(error){assert.equal(error.code,-32600);result[key]=error.code;}}
 if(failure)throw new Error(failure);result.result='passed';
}catch(error){result.error=error.message;result.errorCode=error.code??null;}
finally{
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('probe-closed'));}pending.clear();
 if(child){child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const term=setTimeout(()=>child.kill('SIGTERM'),2000),kill=setTimeout(()=>child.kill('SIGKILL'),4000),deadline=setTimeout(resolve,6000);child.once('close',()=>{clearTimeout(term);clearTimeout(kill);clearTimeout(deadline);resolve();});});result.processExitCode=child.exitCode;result.processSignal=child.signalCode;if(child.exitCode!==0||child.signalCode!==null)result.result='failed';}
 if(!child||child.exitCode!==null||child.signalCode!==null)await rm(prepared.directory,{recursive:true,force:true});
 if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=result.result==='passed'?0:1;
}
