import test from "node:test";
import assert from "node:assert/strict";
import { CompositionGuard, plainEnter, searchShortcut, menuIndex } from "../ui/keyboard-policy.ts";
test("IME lifecycle protects commit/cancel and the trailing composition-end key",()=>{
 let now=0;const guard=new CompositionGuard(()=>now);
 assert.equal(guard.blocked(),false);guard.start();now=200;
 assert.equal(guard.blocked({key:"Enter"}),true);assert.equal(guard.blocked({key:"Escape"}),true);
 guard.end();assert.equal(guard.blocked({key:"Enter"}),true);now=249;assert.equal(guard.blocked(),true);
 now=250;assert.equal(guard.blocked(),false);
});
test("legacy 229 and event composition protect even without lifecycle events",()=>{
 let now=0;const guard=new CompositionGuard(()=>now);
 assert.equal(guard.blocked({key:"Enter",keyCode:229}),true);assert.equal(guard.blocked(),true);
 now=51;assert.equal(guard.blocked(),false);assert.equal(guard.blocked({key:"Escape",isComposing:true}),true);
});
test("only an unmodified, non-repeated Enter can open send confirmation",()=>{
 assert.equal(plainEnter({key:"Enter"}),true);
 for(const patch of [{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true},{keyCode:229},{repeat:true}])assert.equal(plainEnter({key:"Enter",...patch}),false);
 assert.equal(plainEnter({key:"a"}),false);
});
test("search shortcut accepts platform modifiers but rejects Alt and repeat",()=>{
 assert.equal(searchShortcut({key:"F",metaKey:true,shiftKey:true}),true);assert.equal(searchShortcut({key:"f",ctrlKey:true,shiftKey:true}),true);
 for(const event of [{key:"f",shiftKey:true},{key:"f",metaKey:true},{key:"f",metaKey:true,shiftKey:true,altKey:true},{key:"f",ctrlKey:true,shiftKey:true,repeat:true}])assert.equal(searchShortcut(event),false);
});
test("menu navigation wraps both ends and handles empty menus",()=>{
 assert.equal(menuIndex("ArrowUp",0,3),2);assert.equal(menuIndex("ArrowDown",2,3),0);
 assert.equal(menuIndex("Home",2,3),0);assert.equal(menuIndex("End",0,3),2);assert.equal(menuIndex("ArrowDown",-1,3),0);
 assert.equal(menuIndex("Home",0,0),null);assert.equal(menuIndex("Enter",0,3),null);
});
