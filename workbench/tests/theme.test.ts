import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {UiPreferencesStore} from "../desktop-host/ui-preferences-store.ts";
import {defaultUiPreferences,validateUiPreferencesPatch} from "../desktop-host/ui-preferences-contract.ts";
import {ThemeController} from "../desktop-host/theme-controller.ts";
import {validateThemeState,resolveTheme,themeBackground} from "../desktop-host/theme-contract.ts";
async function root(t:{after(fn:()=>Promise<void>):void}){const p=await mkdtemp(join(tmpdir(),"workbench-theme-"));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
function system(){let dark=false;const observers=new Set<()=>void>();return {source:{isDark:()=>dark,subscribe:(fn:()=>void)=>{observers.add(fn);return()=>{observers.delete(fn);};}},set(value:boolean){dark=value;for(const fn of observers)fn();},count:()=>observers.size};}
test("v1 preferences migrate in memory preserving prior dark appearance and all layout fields",async t=>{
 const path=join(await root(t),"prefs.json"),legacy={version:1,sidebarVisible:false,sidebarWidth:300,density:"compact",fontSize:16,collapsedGroups:["official-chat"]},bytes=JSON.stringify(legacy);await writeFile(path,bytes);const store=new UiPreferencesStore(path);assert.deepEqual(await store.read(),{...legacy,version:2,theme:"dark"});assert.equal(await readFile(path,"utf8"),bytes);await store.update({theme:"light"});const saved=JSON.parse(await readFile(path,"utf8"));assert.deepEqual(saved,{...legacy,version:2,theme:"light"});
});
test("theme preference persists all modes and serialized patches preserve unrelated values",async t=>{
 const path=join(await root(t),"prefs.json"),store=new UiPreferencesStore(path);assert.equal((await store.read()).theme,"system");for(const theme of ["light","dark","system"] as const){await Promise.all([store.update({theme}),store.update({fontSize:16})]);assert.equal((await new UiPreferencesStore(path).read()).theme,theme);assert.equal((await store.read()).fontSize,16);}for(const theme of [null,undefined,"auto",{},0,"LIGHT"]){assert.throws(()=>validateUiPreferencesPatch({theme}));}
});
test("invalid persisted theme falls back to system without rewriting the file or other preferences",async t=>{
 const path=join(await root(t),"prefs.json");for(const theme of ["invalid",null,7,{}]){const text=JSON.stringify({...defaultUiPreferences(),sidebarWidth:300,theme});await writeFile(path,text);const value=await new UiPreferencesStore(path).read();assert.equal(value.theme,"system");assert.equal(value.sidebarWidth,300);assert.equal(await readFile(path,"utf8"),text);}
});
test("theme system events are read-only, explicit modes ignore appearance changes, snapshots isolate observers",()=>{
 const s=system(),controller=new ThemeController("system",s.source),updates:unknown[]=[];controller.subscribe(state=>{updates.push({...state});state.resolved="dark";});assert.deepEqual(controller.snapshot(),{mode:"system",resolved:"light",revision:0});s.set(true);assert.equal(controller.snapshot().resolved,"dark");controller.setMode("light");s.set(false);s.set(true);assert.equal(controller.snapshot().resolved,"light");assert.equal(updates.length,2);controller.setMode("system");assert.equal(controller.snapshot().resolved,"dark");controller.setMode("dark");s.set(false);assert.equal(controller.snapshot().resolved,"dark");controller.setMode("system");assert.equal(controller.snapshot().resolved,"light");controller.dispose();assert.equal(s.count(),0);const count=updates.length;s.set(true);assert.equal(updates.length,count);assert.throws(()=>controller.setMode("light"));
});
test("failed preference writes do not change effective appearance; successful retry propagates",async t=>{
 const path=join(await root(t),"prefs.json"),store=new UiPreferencesStore(path),s=system(),controller=new ThemeController("dark",s.source);t.after(async()=>controller.dispose());await store.update({theme:"dark"});await rm(path);await mkdir(path);await assert.rejects((async()=>{const p=await store.update({theme:"light"});controller.setMode(p.theme);})());assert.equal(controller.snapshot().resolved,"dark");await rm(path,{recursive:true});controller.setMode((await store.update({theme:"light"})).theme);assert.equal(controller.snapshot().resolved,"light");
});
test("theme bridge state admits only bounded display data, with no arbitrary preference or execution scope",()=>{
 for(const mode of ["light","dark","system"] as const)for(const dark of [true,false])assert.equal(validateThemeState({mode,resolved:resolveTheme(mode,dark),revision:0}).mode,mode);
 for(const value of [null,[],{mode:"auto",resolved:"dark",revision:0},{mode:"light",resolved:"dark",revision:0},{mode:"system",resolved:"dark",revision:-1},{mode:"system",resolved:"dark",revision:Infinity},{mode:"dark",resolved:"dark",revision:0,path:"/private"}])assert.throws(()=>validateThemeState(value));
});
test("shared palettes cover both surfaces with readable text, focus and selected states",async()=>{
 const css=await readFile(new URL("../ui/theme.css",import.meta.url),"utf8");const parts=css.match(/\{[^{}]+\}/g)!;const luminance=(value:string)=>{const c=value.slice(1).match(/../g)!.map(v=>parseInt(v,16)/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);return c[0]!*.2126+c[1]!*.7152+c[2]!*.0722;};const contrast=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(const [i,part] of parts.slice(0,2).entries()){const tokens:Record<string,string>=Object.fromEntries([...part.matchAll(/(--[a-z-]+):([^;]+);/g)].map(m=>[m[1]!,m[2]!]));const hex=(key:string)=>tokens[key]!.length===4?'#'+tokens[key]!.slice(1).split('').map(c=>c+c).join(''):tokens[key]!;
  for(const [fg,bg] of [["--text","--content"],["--text","--sidebar"],["--text","--selected"],["--muted","--card"],["--muted","--input"],["--disabled","--disabled-bg"],["--on-accent","--blue"],["--on-accent","--primary"],["--warning","--warning-bg"],["--danger","--card"]])assert.ok(contrast(hex(fg!),hex(bg!))>=4.5,`${i} ${fg}/${bg}`);
  assert.ok(contrast(hex("--focus"),hex("--content"))>=3);assert.ok(contrast(hex("--border"),hex("--field"))>=3);assert.equal(hex("--content"),themeBackground(i===0?"dark":"light"));
  for(const file of ["style.css","preview.css"]){const s=await readFile(new URL("../ui/"+file,import.meta.url),"utf8");assert.equal(/#[0-9a-f]{3,8}(?=[;},)\s])/i.test(s),false);for(const match of s.matchAll(/var\((--[a-z-]+)\)/g))assert.ok(tokens[match[1]!]||["--sidebar-width","--sidebar-row-height","--reading-size"].includes(match[1]!),match[1]!);}
 }
});
