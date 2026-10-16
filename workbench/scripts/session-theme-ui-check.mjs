import {spawn} from "node:child_process";
import {mkdir,mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
const output=process.argv[2];if(process.argv.length!==3||!output?.startsWith("/")||output.includes("\0"))throw new Error("absolute-output-required");
await mkdir(output,{recursive:true,mode:0o700});const fixture=await mkdtemp(join(output,".offline-fixture-")),executable=join(process.cwd(),"node_modules","electron","dist",(await readFile("node_modules/electron/path.txt","utf8")).trim());
let active=null,closed=true;
try{for(const phase of ["write","restart","invalid","corrupt"]){
 if(phase==="invalid"){const path=join(fixture,"ui-preferences.json"),value=JSON.parse(await readFile(path,"utf8"));await writeFile(path,JSON.stringify({...value,theme:"invalid-theme"}));}
 if(phase==="corrupt")await writeFile(join(fixture,"ui-preferences.json"),"invalid synthetic JSON");
 closed=false;const child=spawn(executable,[".desktop/main.mjs","--official-chat-offline","--theme-smoke",phase,"--persistence-root",fixture,"--smoke-output",join(output,phase)],{stdio:["ignore","pipe","pipe"],shell:false});active=child;let log="";const capture=bytes=>{log+=bytes.toString();if(log.length>32768)child.kill("SIGTERM");};child.stdout.on("data",capture);child.stderr.on("data",capture);
 const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>child.kill("SIGTERM"),40000),hard=setTimeout(()=>child.kill("SIGKILL"),43000);child.once("error",reject);child.once("close",code=>{clearTimeout(timeout);clearTimeout(hard);closed=true;resolve(code);});});
 await writeFile(join(output,phase+".log"),log);if(code!==0)throw new Error("offline-theme-ui-failed:"+phase);const evidence=JSON.parse(await readFile(join(output,phase,"smoke-results.json"),"utf8")),close=JSON.parse(await readFile(join(output,phase,"windows-close-results.json"),"utf8"));if(evidence.result!=="passed"||evidence.realModelRequests!==0||evidence.officialNativeExecuted||close.opened!==close.closed||close.activeWindows!==0||close.activeReads!==0||close.coreActive)throw new Error("unexpected-theme-evidence");console.log(phase+" passed "+evidence.checks.length+" theme checks; all "+close.closed+" previews closed");active=null;
}}
finally{if(active&&!closed){active.kill("SIGKILL");await new Promise(resolve=>active.once("close",()=>{closed=true;resolve();}));}if(closed)await rm(fixture,{recursive:true,force:true});}
