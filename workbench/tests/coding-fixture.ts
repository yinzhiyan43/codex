/** In-memory peer only. No launcher, sockets, child process, repository or filesystem writes. */
import {CodingPreparation,type PreparationScope} from "../desktop-host/coding-preparation.ts";
import {codingDeclaration} from "../desktop-host/coding-policy.ts";
import {syntheticThread,syntheticTurn} from "./helpers.ts";
export const codingIntent=()=>({root:{id:"root-"+"a".repeat(32),path:"/synthetic/coding-project",device:"1",inode:"20"},model:"gpt-fixture-one"});
export const codingScope=():PreparationScope=>({owner:"main",generation:1,root:codingIntent().root});
export class MemoryCodingPeer {
 readonly calls:string[]=[];
 configuration(){this.calls.push("config/read","permissionProfile/list");const d=codingDeclaration(codingIntent());return {experimentalApi:true,configRead:{config:d.config,origins:{}},profileList:{data:[{id:":read-only",allowed:true,description:null},{id:d.profileId,allowed:true,description:null}],nextCursor:null}};}
 thread(){this.calls.push("thread/start-observation-only");const d=codingDeclaration(codingIntent());return {thread:{...syntheticThread(),id:"coding-thread",cwd:d.intent.root.path,ephemeral:true,modelProvider:"openai",status:{type:"idle"},turns:[]},model:d.intent.model,modelProvider:"openai",cwd:d.intent.root.path,approvalPolicy:"never",approvalsReviewer:"user",sandbox:{type:"readOnly",networkAccess:false},activePermissionProfile:{id:d.profileId,extends:null},runtimeWorkspaceRoots:[d.intent.root.path],disabledPluginIds:[],reasoningEffort:null};}
 turn(turnId="coding-turn"){this.calls.push("turn/start-observation-only");return {turn:{...syntheticTurn(),id:turnId}};}
}
export function prepared(){const guard=new CodingPreparation(codingIntent(),codingScope()),peer=new MemoryCodingPeer(),scope=codingScope();guard.acceptConfiguration(guard.beginConfiguration(scope),scope,peer.configuration());return {guard,peer,scope};}
export function threaded(){const f=prepared();f.guard.acceptThread(f.guard.beginThread(f.scope),f.scope,f.peer.thread());return f;}
export function active(){const f=threaded();f.guard.acceptTurn(f.guard.beginTurn(f.scope,"coding-thread"),f.scope,"coding-thread",f.peer.turn());return f;}
export const terminal=(status="completed",turnId="coding-turn")=>({method:"turn/completed",params:{threadId:"coding-thread",turn:{...syntheticTurn(status),id:turnId}}});
