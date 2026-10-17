import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {CodingPreparation} from "../desktop-host/coding-preparation.ts";
import {CODING_MODE,TEXT_MODE,codingDeclaration,observation} from "../desktop-host/coding-policy.ts";
import {validateCodingContract} from "../protocol-adapter/coding-contracts.ts";
import {validateDesktopCommand} from "../desktop-host/ipc-contract.ts";
import {ready,outgoing} from "./helpers.ts";
import {codingIntent,codingScope,MemoryCodingPeer,prepared,threaded,active,terminal} from "./coding-fixture.ts";
const fresh=()=>new CodingPreparation(codingIntent(),codingScope());
const declaration=()=>codingDeclaration(codingIntent());
const assertClosed=(g:CodingPreparation)=>{assert.equal(g.snapshot().canExecute,false);assert.equal(g.snapshot().transportWired,false);assert.equal(g.snapshot().runtimeValidation,"awaiting-user-authorization");assert.throws(()=>g.assertExecutable(),/coding-runtime-validation-not-authorized/);};

test("independent coding preparation always remains unavailable and the default stays text-only",()=>{
 assert.equal(TEXT_MODE.default,true);assert.equal(CODING_MODE.default,false);assert.equal(CODING_MODE.canExecute,false);assert.ok(Object.isFrozen(CODING_MODE));
 assert.throws(()=>new CodingPreparation({...codingIntent(),nativeValidationPassed:true}as any,codingScope()),/intent-invalid/);
 assert.throws(()=>new CodingPreparation(codingIntent(),{...codingScope(),runtimeValidated:true}as any),/scope-invalid/);assertClosed(fresh());
});
test("experimental subset accepts only named selection and provenance, not legacy sandbox or arbitrary fields",()=>{
 validateCodingContract("profileSelection",{permissions:declaration().profileId,runtimeWorkspaceRoots:[codingIntent().root.path]});
 for(const fields of [{permissions:":workspace",runtimeWorkspaceRoots:[codingIntent().root.path]},{permissions:declaration().profileId,sandbox:"workspace-write",runtimeWorkspaceRoots:[codingIntent().root.path]},{permissions:declaration().profileId,runtimeWorkspaceRoots:[codingIntent().root.path,"/other"]}])assert.throws(()=>validateCodingContract("profileSelection",fields),/contract-invalid/);
 const manifest=JSON.parse(readFileSync(new URL('../contracts/coding/manifest.json',import.meta.url),'utf8'));assert.equal(manifest.sourceSubsetsAreBinaryGenerated,false);assert.equal(manifest.liveTransportEnabled,false);assert.equal(manifest.coreCommit,'092d3acd6bec3e3a14bdc7e7a2810ab628ab759d');
});
test("in-memory configuration/thread/turn/terminal observations never enable execution or mutate intent",()=>{
 const intent=codingIntent(),scope=codingScope(),g=new CodingPreparation(intent,scope),peer=new MemoryCodingPeer();intent.root.inode="999";scope.owner="other";
 const bound=codingScope();g.acceptConfiguration(g.beginConfiguration(bound),bound,peer.configuration());assert.equal(g.snapshot().phase,'configuration-matched');g.acceptThread(g.beginThread(bound),bound,peer.thread());g.acceptTurn(g.beginTurn(bound,'coding-thread'),bound,'coding-thread',peer.turn());g.observeEvent(bound,terminal());assert.equal(g.snapshot().phase,'terminal-observed');assert.equal(g.snapshot().observedTurns,1);assertClosed(g);
 assert.deepEqual(peer.calls,['config/read','permissionProfile/list','thread/start-observation-only','turn/start-observation-only']);
});
test("permissive filesystem inheritance, special roots, extra write roots and network fail closed",()=>{
 const mutations=[(c:any)=>c.permissions[c.default_permissions].extends=':workspace',(c:any)=>c.permissions[c.default_permissions].filesystem[':root']='read',(c:any)=>c.permissions[c.default_permissions].filesystem[':minimal']='read',(c:any)=>c.permissions[c.default_permissions].filesystem['/other']='write',(c:any)=>c.permissions[c.default_permissions].network.enabled=true,(c:any)=>c.permissions[c.default_permissions].network.domains={'*':'allow'},(c:any)=>c.default_permissions=':workspace'];
 for(const mutate of mutations){const g=fresh(),peer=new MemoryCodingPeer(),v=peer.configuration(),t=g.beginConfiguration(codingScope());mutate(v.configRead.config);assert.throws(()=>g.acceptConfiguration(t,codingScope(),v),/coding-permissions-mismatch/);assert.equal(g.snapshot().phase,'blocked');assertClosed(g);}
});
test("environment inheritance, snapshot/login shell and credential-bearing overrides are rejected without echo",()=>{
 const secret='UNIQUE_CODING_SECRET_VALUE',mutations=[(c:any)=>c.shell_environment_policy.inherit='all',(c:any)=>c.shell_environment_policy.inherit='core',(c:any)=>c.shell_environment_policy.set.AWS_SECRET_ACCESS_KEY=secret,(c:any)=>c.shell_environment_policy.include_only=[],(c:any)=>c.shell_environment_policy.filters={'*':'include'},(c:any)=>c.allow_login_shell=true,(c:any)=>c.features.shell_snapshot=true,(c:any)=>c.features.shell_snapshot_v2=true];
 for(const mutate of mutations){const g=fresh(),v=new MemoryCodingPeer().configuration(),t=g.beginConfiguration(codingScope());mutate(v.configRead.config);assert.throws(()=>g.acceptConfiguration(t,codingScope(),v),e=>e instanceof Error&&!e.message.includes(secret)&&e.message.startsWith('coding-'));assert.equal(JSON.stringify(g.snapshot()).includes(secret),false);assertClosed(g);}
});
test("route, model, features, project trust and callbacks cannot silently inherit a different configuration",()=>{
 const mutations=[(c:any)=>c.openai_base_url='https://example.invalid',(c:any)=>c.model='gpt-other',(c:any)=>c.notify=['private-command'],(c:any)=>c.features.hooks=true,(c:any)=>c.features.new_exec_feature=true,(c:any)=>c.agents.enabled=true,(c:any)=>c.mcp_servers={inherited:{enabled:true}},(c:any)=>c.projects[codingIntent().root.path].trust_level='trusted',(c:any)=>c.skills.bundled.enabled=true,(c:any)=>c.unreviewed_executor={enabled:true},(c:any)=>c.instructions="inherited",(c:any)=>c.developer_instructions="inherited",(c:any)=>c.tools={web_search_request:true},(c:any)=>c.browser_use={enabled:true},(c:any)=>c.allow_symlinked_codex_home=true];
 for(const mutate of mutations){const g=fresh(),v=new MemoryCodingPeer().configuration(),t=g.beginConfiguration(codingScope());mutate(v.configRead.config);assert.throws(()=>g.acceptConfiguration(t,codingScope(),v),/coding-/);assertClosed(g);}
});
test("legacy sandbox overrides and incomplete effective evidence are never accepted as proof",()=>{
 for(const key of ['sandbox_mode','sandbox','sandboxPolicy','sandbox_workspace_write']){const g=fresh(),v=new MemoryCodingPeer().configuration(),t=g.beginConfiguration(codingScope());(v.configRead.config as any)[key]=key==='sandbox_workspace_write'?{writable_roots:[],network_access:false,exclude_tmpdir_env_var:true,exclude_slash_tmp:true}:'read-only';assert.throws(()=>g.acceptConfiguration(t,codingScope(),v),/legacy-policy-conflict/);assertClosed(g);}
 const g=fresh(),v=new MemoryCodingPeer().configuration(),t=g.beginConfiguration(codingScope());delete (v.configRead.config as any).shell_environment_policy;assert.throws(()=>g.acceptConfiguration(t,codingScope(),v),/environment-mismatch/);
});
test("experimental negotiation, complete catalog, exact allowed profile and duplicates are checked",()=>{
 const changes=[(v:any)=>v.experimentalApi=false,(v:any)=>v.profileList.nextCursor='next',(v:any)=>v.profileList.data[1].allowed=false,(v:any)=>v.profileList.data.push(v.profileList.data[1]),(v:any)=>v.profileList.data=[]];
 for(const change of changes){const g=fresh(),v=new MemoryCodingPeer().configuration(),t=g.beginConfiguration(codingScope());change(v);assert.throws(()=>g.acceptConfiguration(t,codingScope(),v),/coding-/);assertClosed(g);}
});
test("thread binding requires both cwd facts, exact profile provenance and unchanged model/approval mode",()=>{
 const mutations=[(v:any)=>v.cwd='/other',(v:any)=>v.thread.cwd='/other',(v:any)=>v.runtimeWorkspaceRoots.push('/other'),(v:any)=>v.activePermissionProfile.id=':workspace',(v:any)=>v.activePermissionProfile.extends=':workspace',(v:any)=>delete v.activePermissionProfile,(v:any)=>v.model='gpt-other',(v:any)=>v.approvalPolicy='on-request',(v:any)=>v.approvalsReviewer='auto_review',(v:any)=>v.sandbox={type:'dangerFullAccess'},(v:any)=>v.thread.ephemeral=false];
 for(const mutate of mutations){const {guard,peer,scope}=prepared(),v=peer.thread(),t=guard.beginThread(scope);mutate(v);assert.throws(()=>guard.acceptThread(t,scope,v),/coding-/);assertClosed(guard);}
});
test("wrong owner, root identity or epoch cannot consume another observation ticket",()=>{
 const g=fresh(),scope=codingScope(),t=g.beginConfiguration(scope),v=new MemoryCodingPeer().configuration();for(const changed of [{...scope,owner:'other'},{...scope,generation:2},{...scope,root:{...scope.root,inode:'999'}},{...scope,root:{...scope.root,path:'/other'}}])assert.throws(()=>g.acceptConfiguration(t,changed,v),/scope-obsolete/);
 assert.equal(g.snapshot().phase,'checking-configuration');g.acceptConfiguration(t,scope,v);assert.equal(g.snapshot().phase,'configuration-matched');assert.throws(()=>g.acceptConfiguration(t,scope,v),/observation-obsolete/);assertClosed(g);
});
test("reconnect invalidates delayed configuration callbacks and does not replay observations",()=>{
 const g=fresh(),scope=codingScope(),old=g.beginConfiguration(scope),peer=new MemoryCodingPeer(),v=peer.configuration(),next={...scope,generation:2};g.disconnect(scope);g.reconnect(next);assert.throws(()=>g.acceptConfiguration(old,scope,v),/scope-obsolete/);assert.throws(()=>g.acceptConfiguration(old,next,v),/observation-obsolete/);assert.equal(peer.calls.length,2);g.acceptConfiguration(g.beginConfiguration(next),next,v);assertClosed(g);
});
test("thread and turn observations are ordered, one-shot and cannot reuse a prior turn ID",()=>{
 const g=fresh();assert.throws(()=>g.beginThread(codingScope()),/preparation-order/);const f=threaded();assert.throws(()=>f.guard.beginTurn(f.scope,'different-thread'),/thread-obsolete/);const t=f.guard.beginTurn(f.scope,'coding-thread');assert.throws(()=>f.guard.acceptTurn(t,f.scope,'other-thread',f.peer.turn()),/thread-obsolete/);f.guard.acceptTurn(t,f.scope,'coding-thread',f.peer.turn());assert.throws(()=>f.guard.acceptTurn(t,f.scope,'coding-thread',f.peer.turn()),/observation-obsolete/);f.guard.observeEvent(f.scope,terminal());const next=f.guard.beginTurn(f.scope,'coding-thread');assert.throws(()=>f.guard.acceptTurn(next,f.scope,'coding-thread',f.peer.turn()),/turn-baseline-unverified/);assertClosed(f.guard);
});
test("cross-thread and old-turn events do not poison the bound simulation; terminal conflicts fail closed",()=>{
 const f=active(),before=f.guard.snapshot();assert.throws(()=>f.guard.observeEvent(f.scope,{...terminal(),params:{...terminal().params,threadId:'other-thread'}}),/scope-mismatch/);assert.deepEqual(f.guard.snapshot(),before);assert.throws(()=>f.guard.observeEvent(f.scope,terminal('completed','other-turn')),/scope-mismatch/);f.guard.observeEvent(f.scope,terminal());f.guard.observeEvent(f.scope,terminal());assert.equal(f.guard.snapshot().phase,'terminal-observed');assert.throws(()=>f.guard.observeEvent(f.scope,terminal('failed')),/terminal-conflict/);assertClosed(f.guard);
});
test("command/file/network/grant/permission requests are decline-only classifications, never transmitted",()=>{
 for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/mcpToolCall/requestApproval']){const f=active();assert.deepEqual(f.guard.refuseRequest(f.scope,{id:1,method,params:{threadId:'coding-thread',turnId:'coding-turn',grantRoot:'/other',additionalPermissions:{network:true},execpolicyAmendment:['anything']}}),{allowed:false,transmit:false,decision:'decline'});assert.equal(f.guard.snapshot().unknown,true);assert.throws(()=>f.guard.beginConfiguration(f.scope),/recovery-unverified/);assertClosed(f.guard);}
});
test("misrouted permission requests cannot affect the current task",()=>{
 const f=active(),before=f.guard.snapshot();assert.throws(()=>f.guard.refuseRequest(f.scope,{id:'1',method:'item/permissions/requestApproval',params:{threadId:'other',turnId:'coding-turn'}}),/request-scope-mismatch/);assert.deepEqual(f.guard.snapshot(),before);
});
test("disconnect before a turn ACK preserves unknown state across reconnect instead of assuming no execution",()=>{
 const f=threaded();const t=f.guard.beginTurn(f.scope,'coding-thread');f.guard.disconnect(f.scope);assert.equal(f.guard.snapshot().unknown,true);const next={...f.scope,generation:2};f.guard.reconnect(next);f.guard.disconnect(next);assert.equal(f.guard.snapshot().phase,'unknown');assert.throws(()=>f.guard.beginConfiguration(next),/recovery-unverified/);assert.throws(()=>f.guard.acceptTurn(t,next,'coding-thread',f.peer.turn()),/observation-obsolete/);assertClosed(f.guard);
});
test("disconnect during an observed turn cannot unlock through new configuration or forged validation flags",()=>{
 const f=active();f.guard.disconnect(f.scope);f.guard.reconnect({...f.scope,generation:2});assert.equal(f.guard.snapshot().unknown,true);assert.throws(()=>f.guard.beginConfiguration({...f.scope,generation:2}),/recovery-unverified/);assert.throws(()=>f.guard.reconnect({...f.scope,generation:3,runtimeValidation:'passed'}as any),/scope-invalid/);assertClosed(f.guard);
});
test("oversized, cyclic, accessor and prototype-bearing observations fail without reflecting payloads",()=>{
 const cyclic:any={};cyclic.value=cyclic;const getter=Object.defineProperty({},'secret',{get(){throw Error('SHOULD_NOT_RUN');},enumerable:true});for(const value of [cyclic,getter,JSON.parse('{"__proto__":{"bad":true}}'),{value:'x'.repeat(8193)},new Date()])assert.throws(()=>observation(value),/coding-observation-/);
 const g=fresh(),t=g.beginConfiguration(codingScope());assert.throws(()=>g.acceptConfiguration(t,codingScope(),{experimentalApi:true,private:'UNIQUE_PRIVATE_TEXT'}),/coding-/);assert.equal(JSON.stringify(g.snapshot()).includes('UNIQUE_PRIVATE_TEXT'),false);assertClosed(g);
});
test("observation caches are bounded and disposed preparations cannot consume late callbacks",()=>{
 const f=threaded();for(let n=0;n<128;n++){const id='turn-'+n;f.guard.acceptTurn(f.guard.beginTurn(f.scope,'coding-thread'),f.scope,'coding-thread',f.peer.turn(id));f.guard.observeEvent(f.scope,terminal('completed',id));}const t=f.guard.beginTurn(f.scope,'coding-thread');assert.throws(()=>f.guard.acceptTurn(t,f.scope,'coding-thread',f.peer.turn('over-limit')),/turn-baseline-unverified/);assert.equal(f.guard.snapshot().observedTurns,128);const g=fresh(),ticket=g.beginConfiguration(codingScope());g.dispose();assert.throws(()=>g.acceptConfiguration(ticket,codingScope(),new MemoryCodingPeer().configuration()),/disposed/);assertClosed(g);
});
test("production ProtocolSession and renderer IPC still reject coding preparation and experimental execution fields",async()=>{
 const session=await ready({searchApi:true});assert.throws(()=>session.request('permissionProfile/list',{}),/unsupported-method/);assert.throws(()=>session.startThread({model:'gpt-fixture-one',modelProvider:'openai',cwd:codingIntent().root.path,ephemeral:true,approvalPolicy:'never',permissions:declaration().profileId,runtimeWorkspaceRoots:[codingIntent().root.path]}as any),/unsupported-field/);assert.throws(()=>session.startTurn({threadId:'coding-thread',model:'gpt-fixture-one',input:[],approvalPolicy:'never',permissions:declaration().profileId}as any),/unsupported-field/);assert.deepEqual(outgoing(session),[]);
 for(const type of ['codingMode','prepareCoding','runCoding','approveCoding','validateCodingRuntime'])assert.throws(()=>validateDesktopCommand({type}),/invalid-command/);assertClosed(fresh());
});

test("items are observed only within the bound turn and do not store command or patch bodies",()=>{
 const f=active(),item={id:'patch-one',type:'fileChange',status:'inProgress',changes:[{path:codingIntent().root.path+'/a.txt',kind:{type:'update',move_path:null},diff:'UNIQUE_CODING_PATCH_BODY'}]};
 f.guard.observeEvent(f.scope,{method:'item/started',params:{threadId:'coding-thread',turnId:'coding-turn',item,startedAtMs:1000}});assert.equal(JSON.stringify(f.guard.snapshot()).includes('UNIQUE_CODING_PATCH_BODY'),false);assert.equal(f.guard.snapshot().phase,'turn-observed');assertClosed(f.guard);
});

test("unrelated reviewed model parameters are preserved as observations and do not change the selected model",()=>{
 const g=fresh(),v=new MemoryCodingPeer().configuration();Object.assign(v.configRead.config,{model_reasoning_effort:'high',model_reasoning_summary:'auto',model_verbosity:'medium',service_tier:null});g.acceptConfiguration(g.beginConfiguration(codingScope()),codingScope(),v);assert.equal(g.snapshot().phase,'configuration-matched');assert.equal(JSON.stringify(g.snapshot()).includes('model_reasoning_effort'),false);assert.equal(declaration().intent.model,'gpt-fixture-one');assertClosed(g);
});


test("late requests for a terminal turn cannot erase the next turn awaiting its ACK",()=>{
 const f=active();f.guard.observeEvent(f.scope,terminal());const t=f.guard.beginTurn(f.scope,'coding-thread'),before=f.guard.snapshot();
 assert.throws(()=>f.guard.refuseRequest(f.scope,{id:1,method:'item/permissions/requestApproval',params:{threadId:'coding-thread',turnId:'coding-turn'}}),/request-scope-mismatch/);assert.deepEqual(f.guard.snapshot(),before);
 f.guard.disconnect(f.scope);const next={...f.scope,generation:2};f.guard.reconnect(next);assert.equal(f.guard.snapshot().unknown,true);assert.equal(f.guard.snapshot().phase,'unknown');assert.throws(()=>f.guard.beginConfiguration(next),/recovery-unverified/);assert.throws(()=>f.guard.acceptTurn(t,next,'coding-thread',f.peer.turn('next-turn')),/observation-obsolete/);assertClosed(f.guard);
});
