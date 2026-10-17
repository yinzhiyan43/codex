import {randomBytes} from "node:crypto";
import type {DirectoryBinding,RepositoryView} from "../domain/repository.ts";
import {numberedPatch,untrackedPreview,type CapturedReview} from "../domain/change-review.ts";
import {RepositoryReader,repositoryError} from "./repository-reader.ts";
type State={view:RepositoryView;sequence:number;reader:RepositoryReader;identity:string;captured:CapturedReview|null};
export type RepositoryCommand=
 |{type:"repoList"|"repoFile";scope:string;path:string}
 |{type:"repoStatus"|"repoCancel";scope:string}
 |{type:"repoDiff";scope:string;entry:string}
 |{type:"repoVerifyReview"|"repoPlanIsolation"|"repoReviewFile";scope:string;review:string};
export class RepositoryPanels {
 #states=new Map<string,State>();#helper:string;#publish:()=>void;#retired=new Set<Promise<void>>();
 constructor(helper:string,publish:()=>void){this.#helper=helper;this.#publish=publish;}
 snapshot(owner:string,key:string,binding:DirectoryBinding|null,canChoose:boolean):RepositoryView{
  const identity=JSON.stringify([key,binding]);let state=this.#states.get(owner);
  if(!state||state.identity!==identity){
   if(state)this.#retire(state.reader);
   state={identity,sequence:0,reader:new RepositoryReader(this.#helper),captured:null,view:{scope:"repo-"+randomBytes(16).toString("hex"),key,binding:structuredClone(binding),canChoose,busy:false,notice:binding?"本地只读目录；点击刷新读取文件或Git状态。":"尚未授权本地目录。已有会话只能选择与其官方cwd相同的目录；新草稿可显式选择。",directory:"",entries:[],limited:false,file:null,git:{state:"idle",entries:[],limited:false,notice:"Git状态尚未读取。"},diff:null,review:null,isolation:null,projectApi:"not-connected"}};
   this.#states.set(owner,state);
  }
  state.view.canChoose=canChoose;return structuredClone(state.view);
 }
 capture(owner:string,scope:string):State{const state=this.#states.get(owner);if(!state||state.view.scope!==scope)throw new Error("repository-view-changed");return state;}
 #clearReview(state:State):void{state.view.diff=null;state.view.review=null;state.view.isolation=null;state.captured=null;}
 async dispatch(owner:string,command:RepositoryCommand):Promise<void>{
  const state=this.capture(owner,command.scope),binding=state.view.binding;
  if(command.type==="repoCancel"){
   state.sequence++;state.reader.cancel();state.view.busy=false;
   if(state.view.review){state.view.review.state="stale";state.view.review.checkedAt=null;}
   state.view.isolation=null;state.view.notice="已取消读取，未修改文件。";this.#publish();return;
  }
  if(!binding)throw new Error("repository-not-bound");
  let captured:CapturedReview|null=null;
  if("review" in command){
   if(!state.view.review||state.view.review.id!==command.review||!state.captured)throw new Error("repository-review-expired");
   if(state.view.review.state==="stale"&&command.type!=="repoReviewFile")throw new Error("repository-review-expired");
   captured=state.captured;
  }
  const sequence=++state.sequence;state.reader.cancel();state.view.busy=true;state.view.notice="正在读取所绑定目录…";
  if(command.type==="repoFile"||command.type==="repoReviewFile")state.view.file=null;
  if(command.type==="repoStatus"||command.type==="repoDiff")this.#clearReview(state);
  if(command.type==="repoVerifyReview"||command.type==="repoPlanIsolation"){
   state.view.isolation=null;if(state.view.review)state.view.review.state="snapshot";
  }
  this.#publish();const current=()=>this.#states.get(owner)===state&&state.sequence===sequence;
  try{
   if(command.type==="repoList"){
    const value=await state.reader.list(binding,command.path);
    if(current()){state.view.entries=value.entries;state.view.limited=value.limited;state.view.directory=command.path;state.view.file=null;}
   }else if(command.type==="repoFile"||command.type==="repoReviewFile"){
    const path=command.type==="repoFile"?command.path:captured!.entry.path;
    const text=await state.reader.file(binding,path);
    if(current())state.view.file={path,text};
   }else if(command.type==="repoStatus"){
    const value=await state.reader.status(binding);
    if(current())state.view.git={state:"ready",entries:value.entries,limited:value.limited,notice:value.entries.length?"只读状态；索引列/工作区列分开显示。":"工作区干净。"};
   }else if(command.type==="repoDiff"){
    const entry=state.view.git.entries.find(row=>row.id===command.entry);if(!entry)throw new Error("repository-change-expired");
    const value=await state.reader.review(binding,entry);
    if(current()){
     state.captured=value;state.view.diff={path:entry.path,staged:value.staged,unstaged:value.unstaged};
     state.view.review={id:"review-"+randomBytes(12).toString("hex"),path:entry.path,original:entry.original,head:value.head,capturedAt:new Date().toISOString(),checkedAt:null,state:"snapshot",staged:numberedPatch(value.staged),unstaged:entry.index==="?"?untrackedPreview(value.unstaged):numberedPatch(value.unstaged),untracked:entry.index==="?"};
    }
   }else{
    const value=await state.reader.review(binding,captured!.entry);
    if(current()){
     const review=state.view.review!;review.checkedAt=new Date().toISOString();
     if(value.fingerprint!==captured!.fingerprint){
      review.state="stale";state.view.notice="审阅快照已过期。保留旧快照供对照；请刷新Git状态并重新选择，隔离计划已清除。";return;
     }
     review.state="verified";
     if(command.type==="repoPlanIsolation"){
      if(!value.head)throw new Error("repository-plan-unborn");
      state.view.isolation={id:"plan-"+randomBytes(12).toString("hex"),reviewId:review.id,sessionKey:state.view.key,sourcePath:binding.path,baseCommit:value.head,suggestedName:"experiment-"+randomBytes(6).toString("hex"),mode:"detached",trackedAndUntrackedExcluded:true,ignoredExcluded:true,sharesGitMetadata:true,executionEnabled:false,createdAt:new Date().toISOString()};
     }
    }
   }
   if(current())state.view.notice=command.type==="repoPlanIsolation"?"隔离计划已核对，仅保存在此窗口内存中；创建与清理尚未开放。":command.type==="repoVerifyReview"?"在本次顺序读取中未发现变化；这不是持续监控或原子快照。":command.type==="repoReviewFile"?"当前工作文件；可能与旧/新补丁行号不同，不代表暂存或HEAD版本。":state.view.limited?"仅显示本目录读取到的前200项（或存在不支持的名称）；没有扫描其余目录项。":"读取完成。链接与Git内部目录不开放；文件不作为模型附件自动发送。";
  }catch(error){
   if(current()){
    const code=error instanceof Error?error.message:"",message=repositoryError(code);state.view.notice=message;
    if(command.type==="repoVerifyReview"||command.type==="repoPlanIsolation"){
     state.view.isolation=null;if(state.view.review)state.view.review.state="stale";
    }
    if(command.type==="repoStatus"){state.view.git={state:"unavailable",entries:[],limited:false,notice:message};this.#clearReview(state);}
    if(["repository-root-replaced","repository-read-unavailable","repository-file-unreadable"].includes(code)){
     state.view.entries=[];state.view.file=null;this.#clearReview(state);state.view.git={state:"unavailable",entries:[],limited:false,notice:message};
    }
    if(command.type==="repoList"){state.view.entries=[];state.view.file=null;state.view.directory=command.path;}
   }
  }finally{if(current()){state.view.busy=false;this.#publish();}}
 }
 notice(owner:string,scope:string,text:string):void{this.capture(owner,scope).view.notice=text;this.#publish();}
 #retire(reader:RepositoryReader):void{reader.cancel();const done=reader.settled();this.#retired.add(done);void done.finally(()=>this.#retired.delete(done));}
 close(owner:string):void{const state=this.#states.get(owner);if(state)this.#retire(state.reader);this.#states.delete(owner);}
 async dispose():Promise<void>{for(const owner of this.#states.keys())this.close(owner);await Promise.all([...this.#retired]);}
}
