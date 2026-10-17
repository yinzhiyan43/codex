import {randomBytes} from "node:crypto";
import type {DirectoryBinding,RepositoryView} from "../domain/repository.ts";
import {RepositoryReader,repositoryError} from "./repository-reader.ts";
type State={view:RepositoryView;sequence:number;reader:RepositoryReader;identity:string};
export type RepositoryCommand={type:"repoList"|"repoFile";scope:string;path:string}|{type:"repoStatus"|"repoCancel";scope:string}|{type:"repoDiff";scope:string;entry:string};
export class RepositoryPanels {
 #states=new Map<string,State>();#helper:string;#publish:()=>void;#retired=new Set<Promise<void>>();
 constructor(helper:string,publish:()=>void){this.#helper=helper;this.#publish=publish;}
 snapshot(owner:string,key:string,binding:DirectoryBinding|null,canChoose:boolean):RepositoryView{
  const identity=key+":"+(binding?.id??"unbound");let state=this.#states.get(owner);
  if(!state||state.identity!==identity){if(state)this.#retire(state.reader);state={identity,sequence:0,reader:new RepositoryReader(this.#helper),view:{scope:"repo-"+randomBytes(16).toString("hex"),key,binding:structuredClone(binding),canChoose,busy:false,notice:binding?"本地只读目录；点击刷新读取文件或Git状态。":"尚未授权本地目录。已有会话只能选择与其官方cwd相同的目录；新草稿可显式选择。",directory:"",entries:[],limited:false,file:null,git:{state:"idle",entries:[],limited:false,notice:"Git状态尚未读取。"},diff:null,projectApi:"not-connected"}};this.#states.set(owner,state);}
  state.view.canChoose=canChoose;return structuredClone(state.view);
 }
 capture(owner:string,scope:string):State{const state=this.#states.get(owner);if(!state||state.view.scope!==scope)throw new Error("repository-view-changed");return state;}
 async dispatch(owner:string,command:RepositoryCommand):Promise<void>{const state=this.capture(owner,command.scope),binding=state.view.binding;if(command.type==="repoCancel"){state.sequence++;state.reader.cancel();state.view.busy=false;state.view.notice="已取消读取，未修改文件。";this.#publish();return;}if(!binding)throw new Error("repository-not-bound");const sequence=++state.sequence;state.reader.cancel();state.view.busy=true;state.view.notice="正在读取所绑定目录…";if(command.type==="repoFile")state.view.file=null;if(command.type==="repoDiff")state.view.diff=null;this.#publish();
  const current=()=>this.#states.get(owner)===state&&state.sequence===sequence;
  try{if(command.type==="repoList"){const value=await state.reader.list(binding,command.path);if(current()){state.view.entries=value.entries;state.view.limited=value.limited;state.view.directory=command.path;state.view.file=null;}}
   else if(command.type==="repoFile"){const text=await state.reader.file(binding,command.path);if(current())state.view.file={path:command.path,text};}
   else if(command.type==="repoStatus"){const value=await state.reader.status(binding);if(current()){state.view.git={state:"ready",entries:value.entries,limited:value.limited,notice:value.entries.length?"只读状态；索引列/工作区列分开显示。":"工作区干净。"};state.view.diff=null;}}
   else if(command.type==="repoDiff"){const entry=state.view.git.entries.find(row=>row.id===command.entry);if(!entry)throw new Error("repository-change-expired");const diff=await state.reader.diff(binding,entry);if(current())state.view.diff={path:entry.path,...diff};}
   if(current())state.view.notice=state.view.limited?"仅显示本目录读取到的前200项（或存在不支持的名称）；没有扫描其余目录项。":"读取完成。链接与Git内部目录不开放；文件不作为模型附件自动发送。";
  }catch(error){if(current()){const message=repositoryError(error instanceof Error?error.message:"");state.view.notice=message;if(command.type==="repoStatus"){state.view.git={state:"unavailable",entries:[],limited:false,notice:message};state.view.diff=null;}if(error instanceof Error&&["repository-root-replaced","repository-read-unavailable","repository-file-unreadable"].includes(error.message)){state.view.entries=[];state.view.file=null;state.view.diff=null;state.view.git={state:"unavailable",entries:[],limited:false,notice:message};}if(command.type==="repoList"){state.view.entries=[];state.view.file=null;state.view.directory=command.path;}}}
  finally{if(current()){state.view.busy=false;this.#publish();}}
 }
 notice(owner:string,scope:string,text:string):void{this.capture(owner,scope).view.notice=text;this.#publish();}
  #retire(reader:RepositoryReader):void{reader.cancel();const done=reader.settled();this.#retired.add(done);void done.finally(()=>this.#retired.delete(done));}
 close(owner:string):void{const state=this.#states.get(owner);if(state)this.#retire(state.reader);this.#states.delete(owner);}
 async dispose():Promise<void>{for(const owner of this.#states.keys())this.close(owner);await Promise.all([...this.#retired]);}
}
