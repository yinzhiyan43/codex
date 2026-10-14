import test from "node:test";
import assert from "node:assert/strict";
import { FullTurnsWindow } from "../domain/full-turns-window.ts";
import type { Turn, ThreadTurnsListResponse } from "../protocol-adapter/contracts.ts";
const turn=(id:string,text=id,status:Turn["status"]="completed"):Turn=>({id,rootTurnId:null,status,itemsView:"full",error:null,startedAt:1,completedAt:1,durationMs:1,items:[{type:"agentMessage",id:"same-item-id",text,phase:null,memoryCitation:null,delivery:null,questions:null}]});
const page=(data:Turn[],nextCursor:string|null):ThreadTurnsListResponse=>({data,nextCursor,backwardsCursor:null});
test("full turns retain server chronology, deduplicate overlapping turns/items without text deduplication",()=>{
 const window=new FullTurnsWindow("saved");window.commit(page([turn("a"),turn("z")],"next"),null);window.commit(page([turn("z"),{...turn("m"),items:[...turn("m").items,...turn("m").items]}],null),"next");
 assert.deepEqual(window.snapshot().messages.map(m=>m.text),["m","z","a"]);assert.equal(window.snapshot().turnCount,3);assert.equal(window.snapshot().hasMore,false);
});
test("refresh begins with cache and atomically replaces removed old records on first authoritative page",()=>{
 const window=new FullTurnsWindow("saved");window.commit(page([turn("old")],null),null);window.restart();assert.equal(window.snapshot().messages[0]!.stale,true);window.commit(page([turn("new")],null),null);assert.deepEqual(window.snapshot().messages.map(m=>m.text),["new"]);assert.equal(window.snapshot().stale,false);
});
test("bad cursor, summary items, and loop cannot move committed cursor or clear cache",()=>{
 const window=new FullTurnsWindow("saved");window.commit(page([turn("kept")],"next"),null);
 assert.throws(()=>window.commit(page([turn("lost")],null),"wrong"),/obsolete/);
 assert.throws(()=>window.commit(page([{...turn("lost"),itemsView:"summary"}],null),"next"),/full-turn/);
 assert.throws(()=>window.commit(page([turn("lost")],"next"),"next"),/cursor-loop/);
 assert.deepEqual(window.snapshot().messages.map(m=>m.text),["kept"]);assert.equal(window.cursor(),"next");
});
test("older overlap cannot reopen terminal turn and over-budget page is rejected atomically",()=>{
 const window=new FullTurnsWindow("saved");window.commit(page([turn("kept")],"next"),null);window.commit(page([turn("kept","obsolete","inProgress")],"last"),"next");assert.equal(window.snapshot().messages[0]!.status,"completed");
 assert.throws(()=>window.commit(page([turn("large","x".repeat(2*1024*1024))],null),"last"),/display-limit/);assert.equal(window.cursor(),"last");assert.equal(window.snapshot().messages.length,1);
});

test("full-turn display capacity preserves old data and stops older loads until refresh",()=>{
 const window=new FullTurnsWindow("saved");window.commit(page(Array.from({length:256},(_,n)=>turn("turn-"+n)),"next"),null);assert.equal(window.hasMore(),false);assert.throws(()=>window.commit(page([turn("excess")],null),"next"),/display-limit/);assert.equal(window.snapshot().turnCount,256);assert.equal(window.snapshot().hasMore,false);window.restart();assert.equal(window.hasMore(),true);window.commit(page([turn("fresh")],null),null);assert.equal(window.snapshot().turnCount,1);
});

test("64 committed turn pages stop at the exact page budget without another read",()=>{
 const window=new FullTurnsWindow("saved");for(let n=0;n<64;n++)window.commit(page([turn("turn-"+n)],"page-"+(n+1)),n===0?null:"page-"+n);assert.equal(window.snapshot().turnCount,64);assert.equal(window.hasMore(),false);assert.equal(window.limited(),true);window.restart();assert.equal(window.hasMore(),true);
});
