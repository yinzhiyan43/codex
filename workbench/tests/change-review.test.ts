import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile,rm,mkdir,rename,symlink} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {numberedPatch} from "../domain/change-review.ts";
import {RepositoryReader,repositoryActiveReads} from "../desktop-host/repository-reader.ts";
import {RepositoryPanels} from "../desktop-host/repository-panels.ts";
import {validateDesktopCommand} from "../desktop-host/ipc-contract.ts";
import {syntheticRepositoryRoots} from "./repository-fixture.ts";
const helper=fileURLToPath(new URL("../.desktop/repository-reader",import.meta.url));
async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const f=await syntheticRepositoryRoots(),reader=new RepositoryReader(helper),panels=new RepositoryPanels(helper,()=>{}),root=await reader.select(f.roots.a);
 t.after(async()=>{reader.cancel();await reader.settled();await panels.dispose();await rm(f.directory,{recursive:true,force:true});});
 const view=()=>panels.snapshot("main","a",root,true),scope=view().scope;
 const select=async(path="tracked.txt")=>{await panels.dispatch("main",{type:"repoStatus",scope});const entry=view().git.entries.find(e=>e.path===path)!;await panels.dispatch("main",{type:"repoDiff",scope,entry:entry.id});assert.ok(view().review);return view().review!;};
 return {...f,reader,panels,root,view,scope,select};
}
test("patch numbering respects hunk counters, additions, removals, multiple hunks and no-newline markers",()=>{
 const patch=numberedPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n@@ -9,0 +10,1 @@\n+tail\n');
 assert.equal(patch.numberingComplete,true);assert.deepEqual(patch.lines.filter(l=>l.oldLine!==null||l.newLine!==null).map(l=>[l.oldLine,l.newLine]),[[1,1],[2,null],[null,2],[null,10]]);
 assert.equal(numberedPatch('@@ -1,2 +1,2 @@\n+unexpected\n').numberingComplete,false);
 assert.equal(numberedPatch('diff --cc x\n@@@ -1,1 -1,1 +1,2 @@@\n').numberingComplete,false);
 assert.equal(numberedPatch('Binary files a/x and b/x differ\n').lines[0]!.oldLine,null);
 assert.equal(numberedPatch('@@ -999999999999999999 +1 @@\n+x\n').numberingComplete,false);
 const bounded=numberedPatch('line\n'.repeat(2100));assert.equal(bounded.lines.length,2000);assert.equal(bounded.limited,true);
});
test("review IPC accepts only opaque scope/review handles; mutations, paths and arbitrary Git argv rejected",()=>{
 const command={type:"repoPlanIsolation",scope:"repo-"+"a".repeat(32),review:"review-"+"b".repeat(24)};
 assert.deepEqual(validateDesktopCommand(command),command);
 for(const value of [{...command,path:"/tmp"},{...command,argv:["reset","--hard"]},{...command,type:"worktreeCreate"},{...command,type:"worktreeRemove"},{...command,review:"HEAD"}])assert.throws(()=>validateDesktopCommand(value));
});
test("review snapshots bind canonical entry, HEAD and staged/working contents without index writes",async t=>{
 const f=await fixture(t),before=await readFile(join(f.roots.a,".git/index")),review=await f.select();
 assert.match(review.head!,/^[a-f0-9]{40}$/);assert.ok(review.staged.lines.some(l=>l.text.includes('unstaged a')));assert.ok(review.unstaged.lines.some(l=>l.text.includes('working a')));
 await f.panels.dispatch("main",{type:"repoVerifyReview",scope:f.scope,review:review.id});assert.equal(f.view().review!.state,"verified");assert.ok(f.view().review!.checkedAt);assert.deepEqual(await readFile(join(f.roots.a,".git/index")),before);
});
test("same-status content edits expire old review and remove its plan instead of silently substituting data",async t=>{
 const f=await fixture(t),review=await f.select();await f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id});const plan=f.view().isolation!;assert.equal(plan.executionEnabled,false);assert.equal(plan.baseCommit,review.head);assert.equal(plan.sessionKey,"a");
 await writeFile(join(f.roots.a,"tracked.txt"),"externally changed\n");await f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id});assert.equal(f.view().isolation,null);assert.equal(f.view().review!.state,"stale");assert.match(f.view().diff!.unstaged,/working a/);assert.match(f.view().notice,/过期/);
});
test("HEAD movement invalidates a review even when selected file status remains unchanged",async t=>{
 const f=await fixture(t),review=await f.select();await f.git(f.roots.a,"commit","--allow-empty","-qm","move synthetic HEAD");await f.panels.dispatch("main",{type:"repoVerifyReview",scope:f.scope,review:review.id});assert.equal(f.view().review!.state,"stale");assert.equal(f.view().isolation,null);
});
test("changed status refuses stale selection; refresh revokes prior review handles",async t=>{
 const f=await fixture(t),review=await f.select();await f.panels.dispatch("main",{type:"repoStatus",scope:f.scope});await assert.rejects(f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id}),/expired/);
 const entry=f.view().git.entries.find(e=>e.path==="tracked.txt")!;await f.git(f.roots.a,"add","tracked.txt");await f.panels.dispatch("main",{type:"repoDiff",scope:f.scope,entry:entry.id});assert.equal(f.view().review,null);assert.match(f.view().notice,/列表已变化/);
});
test("review-to-file uses captured root-relative path, showing current contents rather than staged contents",async t=>{
 const f=await fixture(t),review=await f.select();await writeFile(join(f.roots.a,"tracked.txt"),"current after snapshot\n");await f.panels.dispatch("main",{type:"repoReviewFile",scope:f.scope,review:review.id});assert.equal(f.view().file!.text,"current after snapshot\n");assert.match(f.view().notice,/当前工作文件/);
 await rm(join(f.roots.a,"tracked.txt"));await symlink(join(f.directory,"outside.txt"),join(f.roots.a,"tracked.txt"));await f.panels.dispatch("main",{type:"repoReviewFile",scope:f.scope,review:review.id});assert.equal(f.view().file,null);
});
test("owner, session and root swaps revoke old snapshots and plans without cross-window content",async t=>{
 const f=await fixture(t),review=await f.select();f.panels.snapshot("preview","a",f.root,false);await assert.rejects(f.panels.dispatch("preview",{type:"repoVerifyReview",scope:f.scope,review:review.id}),/changed/);
 const next=f.panels.snapshot("main","b",await f.reader.select(f.roots.b),true);assert.equal(next.review,null);assert.equal(next.isolation,null);await assert.rejects(f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id}),/changed/);
});
test("cancel stops sequential review reads and late results cannot restore a plan after close",async t=>{
 const f=await fixture(t),entry=(await f.reader.status(f.root)).entries.find(e=>e.path==="tracked.txt")!;
 const status=f.reader.status.bind(f.reader);let release!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;});f.reader.status=async binding=>{calls++;const value=await status(binding);await gate;return value;};
 const pending=f.reader.review(f.root,entry);for(let i=0;i<100&&calls===0;i++)await new Promise(r=>setTimeout(r,5));f.reader.cancel();release();await assert.rejects(pending,/cancelled|unavailable/);await f.reader.settled();assert.equal(calls,1);assert.equal(repositoryActiveReads(),0);
 const review=await f.select();const plan=f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id});f.panels.close("main");await plan;assert.equal(f.view().isolation,null);assert.equal(f.view().review,null);
});
test("removed roots clear stale patch, review and isolation plan",async t=>{
 const f=await fixture(t),review=await f.select();await f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id});await rename(f.roots.a,f.roots.a+"-old");await mkdir(f.roots.a);await f.panels.dispatch("main",{type:"repoVerifyReview",scope:f.scope,review:review.id});assert.equal(f.view().review,null);assert.equal(f.view().diff,null);assert.equal(f.view().isolation,null);
});
test("unborn repositories can preview staged changes but cannot plan a committed-HEAD worktree",async t=>{
 const f=await fixture(t);await mkdir(join(f.directory,"unborn"));await f.git(join(f.directory,"unborn"),"init","-q");await writeFile(join(f.directory,"unborn/x"),"new\n");await f.git(join(f.directory,"unborn"),"add","x");const root=await f.reader.select(join(f.directory,"unborn"));// Use a separate owner; snapshot reads must keep their own binding.
  const v=()=>f.panels.snapshot("unborn","a",root,true),s=v().scope;await f.panels.dispatch("unborn",{type:"repoStatus",scope:s});await f.panels.dispatch("unborn",{type:"repoDiff",scope:s,entry:v().git.entries[0]!.id});assert.equal(v().review!.head,null);await f.panels.dispatch("unborn",{type:"repoPlanIsolation",scope:s,review:v().review!.id});assert.equal(v().isolation,null);assert.match(v().notice,/尚无已提交/);
});

test("unexpanded untracked directories cannot be called verified and untracked source cannot forge patch line numbers",async t=>{
 const f=await fixture(t);await mkdir(join(f.roots.a,"directory"));await writeFile(join(f.roots.a,"directory/x"),"first");await f.panels.dispatch("main",{type:"repoStatus",scope:f.scope});const entry=f.view().git.entries.find(e=>e.path==="directory/")!;await f.panels.dispatch("main",{type:"repoDiff",scope:f.scope,entry:entry.id});assert.equal(f.view().review,null);assert.equal(f.view().isolation,null);assert.match(f.view().notice,/目录没有展开/);
 await writeFile(join(f.roots.a,"new.txt"),"@@ -8 +8 @@\n-fake\n+fake\n");const review=await f.select("new.txt");assert.equal(review.untracked,true);assert.equal(review.unstaged.lines.every(l=>l.oldLine===null&&l.newLine===null),true);
});

test("stale review handles stay revoked after original bytes return, including direct renderer IPC",async t=>{
 const f=await fixture(t),review=await f.select(),before=await readFile(join(f.roots.a,"tracked.txt"));await writeFile(join(f.roots.a,"tracked.txt"),"changed\n");await f.panels.dispatch("main",{type:"repoVerifyReview",scope:f.scope,review:review.id});assert.equal(f.view().review!.state,"stale");await writeFile(join(f.roots.a,"tracked.txt"),before);await assert.rejects(f.panels.dispatch("main",{type:"repoPlanIsolation",scope:f.scope,review:review.id}),/expired/);assert.equal(f.view().isolation,null);
});
