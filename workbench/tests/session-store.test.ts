import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,writeFile,rm,stat,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../desktop-host/session-store.ts";
async function location(t:{after(fn:()=>Promise<void>):void}){const root=await mkdtemp(join(tmpdir(),"workbench-store-test-"));t.after(()=>rm(root,{recursive:true,force:true}));return join(root,"sessions.json");}
test("metadata/drafts/pin/unread survive atomic private writes and reopening",async t=>{
 const path=await location(t),first=new SessionStore(path);await first.load();first.upsert("known",{title:"Known",draft:"unsubmitted",model:"gpt-fixture-one",pinned:true,unread:true});first.select("known");await first.flush();first.upsert("known",{draft:"latest"});await first.flush();const second=new SessionStore(path);await second.load();assert.equal(second.find("known")!.draft,"latest");assert.equal(second.find("known")!.pinned,true);assert.equal(second.snapshot().lastId,"known");assert.equal((await stat(path)).mode&0o777,0o600);
});
test("corrupt or newer store is preserved and cannot be overwritten by fallback",async t=>{
 const path=await location(t),original='{"version":999,"original":"preserve"}';await writeFile(path,original);const store=new SessionStore(path);await assert.rejects(store.load(),/unavailable/);await assert.rejects(store.flush(),/not-loaded/);assert.equal(await readFile(path,"utf8"),original);
});
test("store rejects symlink targets without reading or overwriting outside bytes",async t=>{
 const path=await location(t),other=path+".other";await writeFile(other,"unchanged");await symlink(other,path);const store=new SessionStore(path);await assert.rejects(store.load(),/unavailable/);assert.equal(await readFile(other,"utf8"),"unchanged");
});
test("only observed temporary text is retained as stale cache without invented success",async t=>{
 const path=await location(t),store=new SessionStore(path);await store.load();store.upsert("old-temp",{ephemeral:true});store.preserveTemporary("old-temp",[{id:"observed",role:"assistant",text:"partial",status:"running"}]);store.select("old-temp");await store.flush();const reopened=new SessionStore(path);await reopened.load();assert.deepEqual(reopened.snapshot().temporary!.messages,[{id:"observed",role:"assistant",text:"partial",status:"unknown",stale:true}]);
});

test("invalid new ownership metadata is rejected before it can corrupt a durable store",async t=>{
 const path=await location(t),store=new SessionStore(path);await store.load();store.upsert("known",{localProject:"Valid",sectionId:"section-1",sectionName:"Known"});await store.flush();await assert.rejects(store.transaction(()=>store.upsert("known",{sectionName:"bad\u0000label"})),/invalid-session-metadata/);assert.equal(store.find("known")!.sectionName,"Known");const reopened=new SessionStore(path);await reopened.load();assert.equal(reopened.find("known")!.localProject,"Valid");assert.equal(reopened.find("known")!.sectionName,"Known");
});
