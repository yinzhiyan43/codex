/** Simulation-only experimental subsets. Not a new ProtocolSession capability. */
import Ajv from "ajv";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import type {ActivePermissionProfile} from "../../codex-rs/app-server-protocol/schema/typescript/v2/ActivePermissionProfile.ts";
import {validate} from "./contracts.ts";
export type CodingProfileSelection={permissions:string;runtimeWorkspaceRoots:[string]};
export type CodingProfileProvenance={activePermissionProfile:ActivePermissionProfile;runtimeWorkspaceRoots:[string]};
const base=new URL("../",import.meta.url),manifest=JSON.parse(readFileSync(new URL("contracts/coding/manifest.json",base),"utf8"));
if(manifest.liveTransportEnabled!==false||manifest.nativeValidationAuthorized!==false||manifest.sourceSubsetsAreBinaryGenerated!==false)throw Error("coding-contract-boundary-changed");
const ajv=new Ajv({strict:false,validateFormats:false}),checks=new Map<string,ReturnType<typeof ajv.compile>>();
for(const [name,entry]of Object.entries(manifest.entries) as [string,{path:string;sha256:string}][]){const bytes=readFileSync(new URL(entry.path,base));if(createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw Error("coding-contract-drift");const schema=JSON.parse(bytes.toString());if(name==="sourceSubsets")for(const [id,fragment]of Object.entries(schema.schemas))checks.set(id,ajv.compile(fragment as object));else checks.set(name,ajv.compile(schema));}
export function validateCodingContract(name:string,value:unknown):void{if(!checks.get(name)?.(value))throw Error("coding-contract-invalid");}
export function validateCodingThreadObservation(value:Record<string,unknown>):void{
 const {activePermissionProfile,runtimeWorkspaceRoots,...stable}=value;
 try{validate("threadStartResult",stable);validateCodingContract("profileProvenance",{activePermissionProfile,runtimeWorkspaceRoots});}catch{throw Error("coding-contract-invalid");}
}
export function validateCodingTurnObservation(value:unknown):void{try{validate("turnStartResult",value);}catch{throw Error("coding-contract-invalid");}}
