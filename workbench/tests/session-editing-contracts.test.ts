import test from "node:test";
import assert from "node:assert/strict";
import {ready,outgoing,feed} from "./helpers.ts";
test("editing protocol rejects experimental boundaries, appearance edits and unscoped order",async()=>{
 const session=await ready();const base={threadId:"source",model:"gpt-fixture-one",modelProvider:"openai",cwd:"/synthetic",approvalPolicy:"never",sandbox:"read-only",excludeTurns:true,ephemeral:false};
 for(const params of [{...base,lastTurnId:"../private"},{...base,beforeTurnId:"turn"}])assert.throws(()=>session.request("thread/fork",params));
 for(const params of [{sectionId:"section",name:"Name",appearance:null},{sectionId:"section",name:"Name",projectId:"x"}])assert.throws(()=>session.request("threadSection/update",params),/unsupported-field/);
 for(const params of [{sortKey:"section_position"},{sortKey:"section_position",sectionId:null}])assert.throws(()=>session.request("thread/list",params),/requires-filter/);
 for(const params of [{threadId:"source",sectionId:null,beforeThreadId:"other"},{threadId:"source",sectionId:"section",beforeThreadId:"source"}])assert.throws(()=>session.request("thread/section/move",params),/anchor/);assert.deepEqual(outgoing(session),[]);
});
test("section update response cannot rename another section in the projection",async()=>{
 const session=await ready(),result=session.updateSection({sectionId:"section-a",name:"New"});const rejection=assert.rejects(result,/invalid-protocol/),frame=outgoing(session)[0]!;feed(session,{id:frame.id,result:{section:{id:"section-b",name:"New",appearance:null}}});await rejection;assert.equal(session.state,"failed");
});
