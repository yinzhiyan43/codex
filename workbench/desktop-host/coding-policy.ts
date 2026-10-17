/** Pure preparation declarations. Never write these values to a file or apply them to a core here. */
import {createHash} from "node:crypto";
import {posix} from "node:path";
import {validDirectoryBinding,type DirectoryBinding} from "../domain/repository.ts";
import {officialRouteOverrides,assertOfficialModelConfiguration} from "./official-config.ts";
export const CODING_MODE=Object.freeze({id:"coding-preparation",default:false,canExecute:false,runtimeValidation:"awaiting-user-authorization",transportWired:false} as const);
export const TEXT_MODE=Object.freeze({id:"text-only",default:true} as const);
export type CodingIntent={root:DirectoryBinding;model:string};
export class CodingPreparationError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;this.name="CodingPreparationError";}}
export function reject(code:string):never{throw new CodingPreparationError(code);}
/** Bound and clone untrusted observations before schema traversal; reject accessors and cycles. */
export function observation(value:unknown):any{
 let nodes=0;const seen=new Set<object>();
 const walk=(v:unknown,depth:number):void=>{
  if(++nodes>4096||depth>16)reject("coding-observation-limit");
  if(v===null||typeof v==="boolean")return;
  if(typeof v==="string"){if(v.length>8192)reject("coding-observation-limit");return;}
  if(typeof v==="number"&&Number.isSafeInteger(v))return;
  if(typeof v!=="object"||!v||seen.has(v))reject("coding-observation-invalid");seen.add(v);
  if(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))reject("coding-observation-invalid");
  if(Object.getOwnPropertySymbols(v).length)reject("coding-observation-invalid");
  for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&key==="length")continue;if(["__proto__","prototype","constructor"].includes(key)||!("value" in descriptor))reject("coding-observation-invalid");walk(descriptor.value,depth+1);}
  seen.delete(v);
 };
 walk(value,0);let encoded:string;try{encoded=JSON.stringify(value);}catch{return reject("coding-observation-invalid");}if(Buffer.byteLength(encoded)>65536)reject("coding-observation-limit");return JSON.parse(encoded);
}
export function record(value:unknown):Record<string,any>{if(!value||typeof value!=="object"||Array.isArray(value))return reject("coding-observation-invalid");return value as Record<string,any>;}
export const same=(a:unknown,b:unknown):boolean=>{
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
};
export const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const runtimeReads=Object.freeze(["/bin","/usr/bin","/usr/lib","/System/Library","/Library/Apple"]);
const disabled=["hooks","shell_snapshot","shell_snapshot_v2","shell_zsh_fork","background_paginated_rollout_migration","goals","daemon_auto_start","view_image","apps","plugins","code_mode","multi_agent","multi_agent_v2","image_generation","browser_use","browser_use_external","browser_use_full_cdp_access","computer_use","network_proxy"];
export function codingDeclaration(input:CodingIntent):{intent:CodingIntent;profileId:string;config:Record<string,any>}{
 const value=record(observation(input));if(Object.keys(value).sort().join()!=="model,root"||!validDirectoryBinding(value.root)||typeof value.model!=="string"||!/^gpt-[a-z0-9.-]{1,100}$/.test(value.model))return reject("coding-intent-invalid");
 const path=value.root.path;
 if(posix.normalize(path)!==path||path.endsWith("/")||path.split("/").some((p:string)=>[".git",".codex"].includes(p.toLowerCase()))||["/","/Users","/home","/tmp","/private/tmp"].includes(path)||["/System","/Library","/usr","/bin","/sbin","/opt"].some(p=>path===p||path.startsWith(p+"/")))return reject("coding-root-declaration-invalid");
 const intent=structuredClone(value) as CodingIntent,profileId="wb-coding-"+digest(intent).slice(0,24);
 const environment={PATH:"/usr/bin:/bin",HOME:path+"/.workbench/home",TMPDIR:path+"/.workbench/tmp",LANG:"C",LC_ALL:"C"};
 const config={...officialRouteOverrides(),model:intent.model,default_permissions:profileId,
  permissions:{[profileId]:{workspace_roots:{[path]:true},filesystem:{[path]:"write",...Object.fromEntries(runtimeReads.map(p=>[p,"read"])),[path+"/.git"]:"deny",[path+"/.codex"]:"deny"},network:{enabled:false}}},
  shell_environment_policy:{inherit:"none",ignore_default_excludes:false,exclude:[],set:environment,include_only:Object.keys(environment).sort(),experimental_use_profile:false},
  allow_login_shell:false,allow_symlinked_codex_home:false,approval_policy:"never",approvals_reviewer:"user",features:{...Object.fromEntries(disabled.map(k=>[k,false])),shell_tool:true,unified_exec:true},
  web_search:"disabled",agents:{enabled:false},memories:{generate_memories:false,use_memories:false},skills:{include_instructions:false,bundled:{enabled:false}},project_doc_max_bytes:0,
  projects:{[path]:{trust_level:"untrusted"}},mcp_servers:{},
 };
 return {intent,profileId,config};
}
/** Exact product subset, not evidence that the declared configuration was applied by an OS. */
export function checkCodingConfiguration(config:unknown,declaration:ReturnType<typeof codingDeclaration>):string{
 const value=record(config),expected=declaration.config;
 const allowed=new Set([...Object.keys(expected),"sandbox_mode","sandbox","sandboxPolicy","sandbox_workspace_write","model_reasoning_effort","model_reasoning_summary","model_verbosity","service_tier"]);
 if(Object.keys(value).some(key=>!allowed.has(key)))return reject("coding-configuration-unreviewed-field");
 for(const key of ["sandbox_mode","sandbox","sandboxPolicy","sandbox_workspace_write"])if(value[key]!==undefined&&value[key]!==null)reject("coding-legacy-policy-conflict");
 try{assertOfficialModelConfiguration(value);}catch{return reject("coding-official-route-mismatch");}
 for(const key of Object.keys(expected))if(!same(value[key],expected[key]))return reject(key==="permissions"||key==="default_permissions"?"coding-permissions-mismatch":key==="shell_environment_policy"||key==="allow_login_shell"?"coding-environment-mismatch":key==="projects"?"coding-trust-declaration-mismatch":"coding-configuration-mismatch");
 // Required guard values above stay authoritative; unrelated model settings are never changed here.
 return digest(expected);
}
