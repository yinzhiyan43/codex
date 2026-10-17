/** TEST ONLY: actual Git mutations exclusively in a fresh disposable fixture.
 * This module is never imported into desktop host, IPC, renderer or its build. */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile,rm,mkdir,lstat,access} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {RepositoryReader} from "../desktop-host/repository-reader.ts";
import {RepositoryPanels} from "../desktop-host/repository-panels.ts";
import {syntheticRepositoryRoots} from "./repository-fixture.ts";
const helper=fileURLToPath(new URL("../.desktop/repository-reader",import.meta.url));
async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const f=await syntheticRepositoryRoots(),reader=new RepositoryReader(helper),panels=new RepositoryPanels(helper,()=>{}),root=await reader.select(f.roots.a),view=()=>panels.snapshot("fixture","synthetic-session",root,true),scope=view().scope;
 t.after(async()=>{reader.cancel();await reader.settled();await panels.dispose();await rm(f.directory,{recursive:true,force:true});});
 await panels.dispatch("fixture",{type:"repoStatus",scope});await panels.dispatch("fixture",{type:"repoDiff",scope,entry:view().git.entries.find(e=>e.path==="tracked.txt")!.id});await panels.dispatch("fixture",{type:"repoPlanIsolation",scope,review:view().review!.id});const plan=view().isolation!;assert.ok(plan);assert.equal(plan.executionEnabled,false);
 await mkdir(join(f.roots.a,".git/info"),{recursive:true});await mkdir(join(f.roots.a,".git/hooks"),{recursive:true});
 const target=join(f.directory,"experiments",plan.suggestedName);await mkdir(join(f.directory,"experiments"));const before={index:await readFile(join(f.roots.a,".git/index")),file:await readFile(join(f.roots.a,"tracked.txt")),main:await readFile(join(f.roots.a,".git/refs/heads/main"))};
 // Boolean here is the explicit synthetic confirmation; no product mutation handler exists.
 const create=async(confirmed:boolean)=>{if(!confirmed)return;await f.git(f.roots.a,"worktree","add","--detach",target,plan.baseCommit);};
 const remove=async(confirmed:boolean)=>{if(!confirmed)return;
  // Git's ordinary remove may erase ignored files. Explicitly include them in preflight.
  const status=await promisify(execFile)("/usr/bin/git",["--no-optional-locks","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","core.excludesFile=/dev/null","status","--porcelain=v1","-z","--untracked-files=all","--ignored=matching"],{cwd:target,env:{PATH:"/usr/bin:/bin",HOME:f.directory,LANG:"C",LC_ALL:"C",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},timeout:4000,maxBuffer:524288});
  if(status.stdout.length)throw new Error("synthetic-cleanup-preserves-all-content");
  await f.git(f.roots.a,"worktree","remove",target);
 };
 const sourcePreserved=async()=>{assert.deepEqual(await readFile(join(f.roots.a,".git/index")),before.index);assert.deepEqual(await readFile(join(f.roots.a,"tracked.txt")),before.file);assert.deepEqual(await readFile(join(f.roots.a,".git/refs/heads/main")),before.main);};
 return {...f,reader,panels,root,plan,target,create,remove,sourcePreserved};
}
test("fixed-HEAD detached worktree isolates files, excludes all unsaved content and preserves source index/main",async t=>{
 const f=await fixture(t);await writeFile(join(f.roots.a,".git/info/exclude"),"ignored-secret\n");await writeFile(join(f.roots.a,"ignored-secret"),"synthetic ignored value");await f.create(false);await assert.rejects(access(f.target));await f.create(true);
 assert.equal(await readFile(join(f.target,"tracked.txt"),"utf8"),"initial a\n");for(const path of ["new.txt","outside-link","ignored-secret"])await assert.rejects(access(join(f.target,path)));
 assert.equal((await readFile(join(f.target,".git"),"utf8")).startsWith("gitdir: "),true);await assert.rejects(f.git(f.target,"symbolic-ref","--quiet","HEAD"));
 const isolated=await f.reader.select(f.target);assert.equal(await f.reader.file(isolated,"tracked.txt"),"initial a\n");await assert.rejects(f.reader.status(isolated),/git-unavailable/);await writeFile(join(f.target,"tracked.txt"),"isolated experiment\n");await f.sourcePreserved();
});
test("guarded worktree removal refuses tracked edits, untracked files and ignored files without losing bytes",async t=>{
 const f=await fixture(t);await f.create(true);await writeFile(join(f.target,"tracked.txt"),"keep synthetic edit\n");await f.remove(false);assert.equal(await readFile(join(f.target,"tracked.txt"),"utf8"),"keep synthetic edit\n");await assert.rejects(f.remove(true));assert.equal(await readFile(join(f.target,"tracked.txt"),"utf8"),"keep synthetic edit\n");
 // Explicitly restore only this test's known synthetic file, then exercise other refusal categories.
 await writeFile(join(f.target,"tracked.txt"),"initial a\n");await writeFile(join(f.target,"untracked"),"keep untracked\n");await assert.rejects(f.remove(true));assert.equal(await readFile(join(f.target,"untracked"),"utf8"),"keep untracked\n");await rm(join(f.target,"untracked"));
 await writeFile(join(f.roots.a,".git/info/exclude"),"ignored\n");await writeFile(join(f.target,"ignored"),"keep ignored\n");await assert.rejects(f.remove(true));assert.equal(await readFile(join(f.target,"ignored"),"utf8"),"keep ignored\n");await f.sourcePreserved();
});
test("same target and locked worktrees reject replacement/removal; clean explicit removal does not run hooks",async t=>{
 const f=await fixture(t),canary=join(f.roots.a,".git/hooks/post-checkout");await writeFile(canary,'#!/bin/sh\ntouch "$0.ran"\n',{mode:0o700});await f.create(true);await assert.rejects(access(canary+".ran"));await assert.rejects(f.create(true));assert.equal((await lstat(f.target)).isDirectory(),true);
 await f.git(f.roots.a,"worktree","lock",f.target);await assert.rejects(f.remove(true));await f.git(f.roots.a,"worktree","unlock",f.target);await f.remove(false);await access(f.target);await f.remove(true);await assert.rejects(access(f.target));await f.sourcePreserved();
});
