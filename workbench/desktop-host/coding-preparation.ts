/** Observation-only state machine. No WorkbenchClient, launcher, filesystem access or outbound queue. */
import {randomBytes} from "node:crypto";
import {validDirectoryBinding,type DirectoryBinding} from "../domain/repository.ts";
import {validate} from "../protocol-adapter/contracts.ts";
import {validateCodingContract,validateCodingThreadObservation,validateCodingTurnObservation} from "../protocol-adapter/coding-contracts.ts";
import {CODING_MODE,TEXT_MODE,codingDeclaration,checkCodingConfiguration,observation,record,reject,same,digest,type CodingIntent} from "./coding-policy.ts";
export type PreparationScope={owner:string;generation:number;root:DirectoryBinding};
type Phase="idle"|"checking-configuration"|"configuration-matched"|"checking-thread"|"thread-observed"|"checking-turn"|"turn-observed"|"terminal-observed"|"blocked"|"unknown"|"disposed";
type Ticket={id:string;kind:"configuration"|"thread"|"turn";scope:PreparationScope;threadId:string|null};
const id=(value:unknown):value is string=>typeof value==="string"&&/^[a-z0-9-]{1,64}$/.test(value);
export class CodingPreparation {
 #declaration:ReturnType<typeof codingDeclaration>;#scope:PreparationScope;#phase:Phase="idle";#ticket:Ticket|null=null;
 #thread:string|null=null;#turn:string|null=null;#turns=new Set<string>();#terminal:string|null=null;#unknown=false;#reason:string|null=null;
 constructor(intent:CodingIntent,scope:PreparationScope){this.#declaration=codingDeclaration(intent);this.#scope=this.#validScope(scope);validateCodingContract("profileSelection",{permissions:this.#declaration.profileId,runtimeWorkspaceRoots:[this.#scope.root.path]});if(!same(this.#scope.root,this.#declaration.intent.root))reject("coding-scope-mismatch");}
 #validScope(input:unknown):PreparationScope{const s=record(observation(input));if(Object.keys(s).sort().join()!=="generation,owner,root"||!id(s.owner)||!Number.isSafeInteger(s.generation)||s.generation<1||!validDirectoryBinding(s.root))return reject("coding-scope-invalid");return s as PreparationScope;}
 #current(scope:PreparationScope):void{if(this.#phase==="disposed")reject("coding-preparation-disposed");if(!same(this.#validScope(scope),this.#scope))reject("coding-scope-obsolete");}
 #block(code:string):never{this.#ticket=null;if(this.#phase==="checking-turn"||this.#turn&&this.#terminal===null)this.#unknown=true;this.#phase=this.#unknown?"unknown":"blocked";this.#reason=code;return reject(code);}
 #begin(kind:Ticket["kind"],scope:PreparationScope,phases:Phase[]):string{
  this.#current(scope);if(this.#unknown)reject("coding-recovery-unverified");if(!phases.includes(this.#phase))reject("coding-preparation-order");
  if(kind==="configuration"){this.#thread=null;this.#turn=null;this.#terminal=null;}
  const ticket:Ticket={id:"observe-"+randomBytes(16).toString("hex"),kind,scope:structuredClone(this.#scope),threadId:this.#thread};this.#ticket=ticket;this.#phase=kind==="configuration"?"checking-configuration":kind==="thread"?"checking-thread":"checking-turn";this.#reason=null;return ticket.id;
 }
 #consume(ticket:string,kind:Ticket["kind"],scope:PreparationScope):void{this.#current(scope);const pending=this.#ticket;if(!pending||pending.id!==ticket||pending.kind!==kind||!same(pending.scope,this.#scope)||pending.threadId!==this.#thread)reject("coding-observation-obsolete");this.#ticket=null;}
 #observe<T>(run:()=>T):T{try{return run();}catch(error){const code=error instanceof Error&&/^coding-[a-z-]+$/.test(error.message)?error.message:"coding-contract-invalid";return this.#block(code);}}
 snapshot(){return {mode:CODING_MODE.id,defaultMode:TEXT_MODE.id,canExecute:false as const,transportWired:false as const,runtimeValidation:"awaiting-user-authorization" as const,phase:this.#phase,reason:this.#reason,owner:this.#scope.owner,generation:this.#scope.generation,rootId:this.#scope.root.id,profileId:this.#declaration.profileId,threadId:this.#thread,turnId:this.#turn,observedTurns:this.#turns.size,unknown:this.#unknown,automaticReplay:false as const};}
 beginConfiguration(scope:PreparationScope):string{return this.#begin("configuration",scope,["idle","configuration-matched","blocked"]);}
 acceptConfiguration(ticket:string,scope:PreparationScope,input:unknown):void{
  this.#consume(ticket,"configuration",scope);this.#observe(()=>{
   const value=record(observation(input));if(Object.keys(value).sort().join()!=="configRead,experimentalApi,profileList"||value.experimentalApi!==true)reject("coding-experimental-capability-missing");
   validate("configReadResult",value.configRead);checkCodingConfiguration(value.configRead.config,this.#declaration);validateCodingContract("PermissionProfileListResponse",value.profileList);
   const list=record(value.profileList);if(!Array.isArray(list.data)||list.data.length>64||list.nextCursor!==null||list.data.filter((p:any)=>p.id===this.#declaration.profileId).length!==1||new Set(list.data.map((p:any)=>p.id)).size!==list.data.length||list.data.some((p:any)=>typeof p.id!=="string"||!/^:?[a-z0-9-]{1,64}$/.test(p.id))||list.data.find((p:any)=>p.id===this.#declaration.profileId)?.allowed!==true)reject("coding-profile-selection-unverified");
   this.#phase="configuration-matched";
  });
 }
 beginThread(scope:PreparationScope):string{return this.#begin("thread",scope,["configuration-matched"]);}
 acceptThread(ticket:string,scope:PreparationScope,input:unknown):void{
  this.#consume(ticket,"thread",scope);this.#observe(()=>{
   const value=record(observation(input));validateCodingThreadObservation(value);
   if(!id(value.thread.id)||value.thread.cwd!==this.#scope.root.path||value.cwd!==this.#scope.root.path||value.thread.modelProvider!=="openai"||value.modelProvider!=="openai"||value.model!==this.#declaration.intent.model||value.thread.ephemeral!==true||value.sandbox.type!=="readOnly"||value.sandbox.networkAccess!==false||value.approvalPolicy!=="never"||value.approvalsReviewer!=="user"||!same(value.activePermissionProfile,{id:this.#declaration.profileId,extends:null})||!same(value.runtimeWorkspaceRoots,[this.#scope.root.path]))reject("coding-thread-permissions-mismatch");
   if(value.thread.turns?.length||!['idle','notLoaded'].includes(value.thread.status.type)||value.disabledPluginIds?.length)reject("coding-thread-baseline-unverified");
   this.#thread=value.thread.id;this.#phase="thread-observed";
  });
 }
 beginTurn(scope:PreparationScope,threadId:string):string{this.#current(scope);if(threadId!==this.#thread||!this.#thread)reject("coding-thread-obsolete");return this.#begin("turn",scope,["thread-observed","terminal-observed"]);}
 acceptTurn(ticket:string,scope:PreparationScope,threadId:string,input:unknown):void{
  this.#current(scope);if(threadId!==this.#thread)reject("coding-thread-obsolete");this.#consume(ticket,"turn",scope);
  this.#observe(()=>{const value=record(observation(input));validateCodingTurnObservation(value);if(!id(value.turn.id)||value.turn.status!=="inProgress"||this.#turns.has(value.turn.id)||this.#turns.size>=128)reject("coding-turn-baseline-unverified");this.#turn=value.turn.id;this.#turns.add(this.#turn!);this.#terminal=null;this.#phase="turn-observed";});
 }
 observeEvent(scope:PreparationScope,input:unknown):void{
  this.#current(scope);if(this.#unknown)reject("coding-recovery-unverified");
  const incoming=record(observation(input)),params=record(incoming.params),incomingTurn=incoming.method==="turn/completed"?params.turn?.id:params.turnId;if(params.threadId!==this.#thread||incomingTurn!==this.#turn)reject("coding-event-scope-mismatch");
  this.#observe(()=>{const value=incoming,p=params;if(Object.keys(value).sort().join()!=="method,params"||!['item/started','item/completed','turn/completed'].includes(value.method))reject("coding-event-unsupported");
   const turnId=value.method==="turn/completed"?p.turn?.id:p.turnId;
   if(p.threadId!==this.#thread||turnId!==this.#turn||!this.#turn||!['turn-observed','terminal-observed'].includes(this.#phase))reject("coding-event-scope-mismatch");
   validate(value.method==="item/started"?"itemStarted":value.method==="item/completed"?"itemCompleted":"turnCompleted",p);
   if(value.method==="turn/completed"){
    if(!['completed','interrupted','failed'].includes(p.turn.status))reject("coding-terminal-unverified");const signature=digest(p.turn);if(this.#terminal&&this.#terminal!==signature)reject("coding-terminal-conflict");this.#terminal=signature;this.#phase="terminal-observed";
   }else if(this.#phase==="terminal-observed")reject("coding-event-after-terminal");
  });
 }
 refuseRequest(scope:PreparationScope,input:unknown):{allowed:false;transmit:false;decision:"decline"}{
  this.#current(scope);if(this.#phase!=="turn-observed"||this.#unknown)reject("coding-request-scope-mismatch");const value=record(observation(input)),p=record(value.params);
  if(p.threadId!==this.#thread||p.turnId!==this.#turn||!this.#turn)reject("coding-request-scope-mismatch");
  this.#observe(()=>{if(Object.keys(value).sort().join()!=="id,method,params"||!(typeof value.id==="string"&&value.id.length<=128||Number.isSafeInteger(value.id))||typeof value.method!=="string"||!/^[A-Za-z0-9/_-]{1,128}$/.test(value.method))reject("coding-request-invalid");});
  this.#ticket=null;this.#unknown=this.#unknown||this.#terminal===null;this.#phase=this.#unknown?"unknown":"blocked";this.#reason="coding-elevation-refused";return {allowed:false,transmit:false,decision:"decline"};
 }
 disconnect(scope:PreparationScope):void{this.#current(scope);this.#ticket=null;this.#unknown=this.#unknown||this.#phase==="checking-turn"||!!this.#turn&&this.#terminal===null;this.#phase=this.#unknown?"unknown":"blocked";this.#reason="coding-disconnected";}
 reconnect(scope:PreparationScope):void{const next=this.#validScope(scope);if(this.#phase==="disposed")reject("coding-preparation-disposed");if(next.owner!==this.#scope.owner||!same(next.root,this.#scope.root)||next.generation<=this.#scope.generation)reject("coding-scope-obsolete");this.#scope=next;this.#ticket=null;this.#phase=this.#unknown?"unknown":"idle";this.#reason="coding-runtime-validation-not-authorized";if(!this.#unknown){this.#thread=null;this.#turn=null;this.#terminal=null;}}
 assertExecutable():never{return reject("coding-runtime-validation-not-authorized");}
 dispose():void{this.#ticket=null;this.#phase="disposed";this.#reason="coding-preparation-disposed";}
}
