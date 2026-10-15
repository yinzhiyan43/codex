import type { WorkbenchClient } from "./client.ts";
import type { DesktopView } from "./demo-controller.ts";
import { FullTurnsWindow } from "../domain/full-turns-window.ts";
import { validateDesktopCommand } from "./ipc-contract.ts";
export type PreviewSource={id:string;title:string;archived:boolean;archiveUncertain?:boolean};
/** Includes requests whose windows have already closed; never cancels the shared core. */
export class PreviewReadBudget {
  #active=0;
  acquire():()=>void{if(this.#active>=4)throw new Error("preview-read-budget");this.#active++;let released=false;return()=>{if(!released){released=true;this.#active--;}};}
  active():number{return this.#active;}
}
/** Fixed source, no draft store, no mutation or model RPCs, no ownership of client lifetime. */
export class SessionPreview {
  #client:WorkbenchClient;#source:PreviewSource;#window:FullTurnsWindow;#budget:PreviewReadBudget;#title:string;
  #sourceRevision=0;#version=0;#intent=0;#inflight=false;#busy=false;#disposed=false;#error:string|null=null;#notice="只读副窗口；草稿与发送由主窗口管理。";
  #listeners=new Set<()=>void>();#unsubscribe:()=>void;#generation:number;#connection:ReturnType<WorkbenchClient["getView"]>["state"];
  constructor(client:WorkbenchClient,source:PreviewSource,budget:PreviewReadBudget){
    if(!/^[a-z0-9-]{1,64}$/.test(source.id))throw new Error("invalid-preview-source");this.#client=client;this.#source={...source};this.#title=source.title;this.#window=new FullTurnsWindow(source.id);this.#budget=budget;this.#generation=client.getView().generation;this.#connection=client.getView().state;
    this.#unsubscribe=client.subscribe(()=>{const host=client.getView(),changed=host.state!==this.#connection||host.generation!==this.#generation;if(!changed)return;const invalidate=host.state!=="ready"||host.generation!==this.#generation;this.#generation=host.generation;this.#connection=host.state;if(invalidate){this.#intent++;this.#busy=false;this.#window.markStale();this.#notice="连接已改变，缓存仅供查看；主窗口重连后请显式刷新。";}this.#publish();});
  }
  #publish(){this.#version++;if(!this.#disposed)for(const listener of this.#listeners)try{listener();}catch{}}
  subscribe(listener:()=>void):()=>void{if(this.#disposed||this.#listeners.size>=8)throw new Error("preview-unavailable");this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  sync(source:PreviewSource):void{if(this.#disposed||source.id!==this.#source.id)return;if(JSON.stringify(source)===JSON.stringify(this.#source))return;if(source.title!==this.#source.title)this.#title=source.title;this.#source={...source};this.#sourceRevision++;this.#publish();}
  snapshot():DesktopView{const saved=this.#window.snapshot(),host=this.#client.getView();return {mode:"official-chat",version:this.#version,connection:host.state,stale:saved.stale||host.state!=="ready",projects:[{id:"preview",name:"只读副窗口",threads:[{id:this.#source.id,title:this.#title}]}],route:{projectId:"preview",threadId:this.#source.id},title:this.#title,messages:saved.messages,draft:"",search:"",loading:this.#inflight,pending:null,running:false,error:this.#error,approvals:[],sessionPreview:{id:this.#source.id,archived:this.#source.archived,archiveUncertain:!!this.#source.archiveUncertain,notice:this.#notice},history:{turnCount:saved.turnCount,itemCount:saved.messages.length,hasMore:saved.hasMore,busy:this.#inflight,loading:this.#busy,stale:saved.stale||host.state!=="ready",notice:this.#notice}};}
  async #read(refresh:boolean):Promise<void>{
    if(this.#disposed||this.#inflight||this.#client.getView().state!=="ready")throw new Error("preview-read-unavailable");if(!refresh&&!this.#window.hasMore())return;
    let release:()=>void;try{release=this.#budget.acquire();}catch{this.#error="副窗口读取仍在返回，请稍后刷新。";this.#publish();return;}
    const sourceRevision=this.#sourceRevision,intent=++this.#intent,generation=this.#client.getView().generation;this.#inflight=true;this.#busy=true;this.#error=null;if(refresh)this.#window.restart();this.#publish();
    const current=()=>!this.#disposed&&intent===this.#intent&&generation===this.#client.getView().generation&&this.#client.getView().state==="ready";
    try{const meta=await this.#client.readThreadMetadata({threadId:this.#source.id});if(!current())return;if(meta.thread.id!==this.#source.id||meta.thread.ephemeral)throw new Error("preview-persistent-required");
      const cursor=this.#window.cursor(),page=await this.#client.listTurns({threadId:this.#source.id,cursor,limit:20,sortDirection:"desc",itemsView:"full"});if(!current())return;this.#window.commit(page,cursor);if(sourceRevision===this.#sourceRevision)this.#title=(meta.thread.name||this.#source.title||meta.thread.preview||"持久会话").replace(/\s+/g," ").slice(0,100);this.#notice=this.#window.limited()?"已到副窗口展示上限，停止加载；可显式刷新。":"只读保存文字；附件/工具未展开，草稿与发送仅在主窗口。";
    }catch{if(current())this.#error="副窗口读取未完成，缓存保留；可刷新重试。";}
    finally{release();this.#inflight=false;if(intent===this.#intent)this.#busy=false;this.#publish();}
  }
  async dispatch(value:unknown):Promise<DesktopView>{if(this.#disposed)throw new Error("preview-unavailable");const command=validateDesktopCommand(value);
    if(command.type==="refreshHistory")await this.#read(true);
    else if(command.type==="history"&&command.threadId===this.#source.id)await this.#read(false);
    else if(command.type==="cancelHistory"){this.#intent++;this.#busy=false;this.#window.markStale();this.#notice="已取消此副窗口读取；其他窗口和核心继续运行。";}
    else if(command.type==="clearError")this.#error=null;
    else throw new Error("preview-read-only");this.#publish();return this.snapshot();
  }
  dispose():void{if(this.#disposed)return;this.#disposed=true;this.#intent++;this.#busy=false;this.#unsubscribe();this.#listeners.clear();}
}
