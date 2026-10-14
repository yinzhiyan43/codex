import test from "node:test";
import assert from "node:assert/strict";
import { discoverChatMcp } from "../desktop-host/chat-bootstrap.ts";
test("bootstrap configuration failure cleans only after successful disposal and preserves original error", async () => {
  const failure=new Error("official-endpoint-not-confirmed");let closed=false,cleaned=0;
  const boot={start:async()=>{},configurationMcpOverrides:async()=>{throw failure;},dispose:async()=>{closed=true;},getView:()=>({processActive:!closed})};
  await assert.rejects(discoverChatMcp(boot,async()=>{assert.equal(closed,true);cleaned++;}),error=>error===failure);assert.equal(cleaned,1);
});
for(const active of [true,false]) test(`bootstrap disposal failure ${active?"retains live cwd":"cleans confirmed closed cwd"}`,async()=>{
  let cleaned=0;const boot={start:async()=>{},configurationMcpOverrides:async()=>[],dispose:async()=>{throw new Error("shutdown-timeout");},getView:()=>({processActive:active})};
  await assert.rejects(discoverChatMcp(boot,async()=>{cleaned++;}),/core-bootstrap-shutdown-unconfirmed/);assert.equal(cleaned,active?0:1);
});
test("successful metadata bootstrap closes before returning MCP override and retains future run cwd", async () => {
  let closed=false,cleaned=false;const boot={start:async()=>{},configurationMcpOverrides:async()=>['mcp_servers={"fixture"={enabled=false}}'],dispose:async()=>{closed=true;},getView:()=>({processActive:!closed})};
  assert.deepEqual(await discoverChatMcp(boot,async()=>{cleaned=true;}),['mcp_servers={"fixture"={enabled=false}}']);assert.equal(closed,true);assert.equal(cleaned,false);
});
