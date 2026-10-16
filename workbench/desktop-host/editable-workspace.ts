import {OfficialChatController} from "./official-chat-controller.ts";
import {DraftLeases} from "./draft-leases.ts";
import {SessionPreview,PreviewReadBudget,type PreviewSource} from "./session-preview.ts";
import {validateDesktopCommand,type DesktopCommand} from "./ipc-contract.ts";
import type {DesktopView} from "./demo-controller.ts";
import type {SessionStore} from "./session-store.ts";
import type {WorkbenchClient} from "./client.ts";
type Entry={id:string;source:PreviewSource;preview:SessionPreview;runtime?:OfficialChatController;off:()=>void;runtimeOff?:()=>void;attaching:boolean;closed:boolean;closing:boolean};
type Gate={key:string;owner:string;runtime:OfficialChatController;inflight:number;finishing:boolean;unknown:boolean};
const mutations=new Set(["copySession","forkSession","archiveSession","unarchiveSession","renameSession","assignProject","renameProject","renameSection","createSection","assignSection"]);
/** One process owns all leases, durable writes, execution admission and borrowed runtimes. */
export class EditableWorkspace {
  #client:WorkbenchClient;#cwd:string;#offline:boolean;#store:SessionStore;#leases:DraftLeases;
  #main:OfficialChatController;#mainKey="";#suppressed=new Set<string>();#entries=new Map<string,Entry>();#retired=new Map<string,Entry>();
  #gate:Gate|null=null;#version=0;#listeners=new Map<string,Set<()=>void>>();#notices=new Map<string,string>();#off:()=>void;#storeOff:()=>void;#disposed=false;
  constructor(client:WorkbenchClient,cwd:string,offline:boolean,store:SessionStore,copy:((text:string)=>void)|null=null){
    this.#client=client;this.#cwd=cwd;this.#offline=offline;this.#store=store;this.#leases=new DraftLeases(store);
    this.#main=new OfficialChatController(client,cwd,offline,15000,store,copy,{canWriteDraft:key=>this.#mainWriteAllowed(key)});
    this.#off=this.#main.subscribe(()=>{this.#syncSources();this.#reconcile();this.#publish();});
    this.#storeOff=store.subscribe(()=>{this.#syncSources();this.#reconcile();this.#publish();});
  }
  #key(view=this.#main.snapshot()):string{return view.route.threadId??"official-chat";}
  #mainWriteAllowed(key:string):boolean{
    if(!this.#suppressed.has(key)&&!this.#leases.state(key).owner)this.#leases.claim(key,"main");
    return this.#leases.owns(key,"main");
  }
  #syncMain():void{const view=this.#main.snapshot();if(view.chatStatus?.historyMode)return;const key=this.#key(view);if(key===this.#mainKey)return;const previous=this.#mainKey;this.#mainKey=key;this.#suppressed.delete(key);if(previous&&!this.#leases.busy(previous))this.#leases.release(previous,"main");this.#mainWriteAllowed(key);}
  #publish():void{this.#version++;if(!this.#disposed)for(const rows of this.#listeners.values())for(const listener of rows)try{listener();}catch{}}
  subscribe(listener:()=>void):()=>void{return this.subscribeOwner("main",listener);}
  subscribeOwner(owner:string,listener:()=>void):()=>void{const rows=this.#listeners.get(owner)??new Set();if(this.#disposed||rows.size>=8)throw new Error("workspace-unavailable");rows.add(listener);this.#listeners.set(owner,rows);return()=>{rows.delete(listener);if(!rows.size)this.#listeners.delete(owner);};}
  #runtime(owner:string):OfficialChatController{if(owner==="main")return this.#main;const actor=this.#entries.get(owner)?.runtime;if(!actor)throw new Error("editor-not-attached");return actor;}
  #syncSources():void{for(const entry of [...this.#entries.values(),...this.#retired.values()]){const row=this.#store.find(entry.id);if(row){entry.source={id:entry.id,title:row.title,archived:row.archived,archiveUncertain:!!row.archiveUncertain};entry.preview.sync(entry.source);}}}
  #reconcile():void{
    const gate=this.#gate;if(!gate||gate.inflight||gate.finishing)return;const state=gate.runtime.snapshot();if(state.route.threadId)gate.key=state.route.threadId;
    if(state.chatStatus?.phase==="unknown"){gate.unknown=true;return;}
    if(state.running||state.pending||gate.unknown)return;
    gate.finishing=true;
    void this.#store.settled().then(async()=>{if(this.#gate!==gate)return;await this.#collectRetired(gate.runtime);this.#gate=null;this.#publish();}).catch(()=>{if(this.#gate===gate){gate.finishing=false;gate.unknown=true;this.#notices.set(gate.owner,"执行后的草稿保存未确认，请重连核对；不会自动重发。");this.#publish();}});
  }
  async #collectRetired(finishing?:OfficialChatController):Promise<void>{await this.#store.settled();for(const [owner,entry]of this.#retired){if(this.#gate?.runtime===entry.runtime&&entry.runtime!==finishing)continue;this.#leases.release(entry.id,owner);entry.runtimeOff?.();entry.runtime?.detach();this.#retired.delete(owner);}}
  snapshot():DesktopView{return this.snapshotOwner("main");}
  snapshotOwner(owner:string):DesktopView{
    this.#syncMain();const entry=owner==="main"?null:this.#entries.get(owner);if(owner!=="main"&&!entry)throw new Error("unknown-window");
    const runtime=owner==="main"?this.#main:entry!.runtime;
    let view=runtime?.snapshot()??entry!.preview.snapshot();const key=entry?.id??this.#key(view),state=this.#leases.state(key),browsing=!!view.chatStatus?.historyMode;
    const active=this.#gate?.runtime.snapshot(),same=active&&this.#gate!.key===key;
    if(same&&this.#gate?.runtime!==runtime){const merged=new Map(view.messages.map(m=>[m.id,m]));for(const message of active.messages)merged.set(message.id,message);view={...view,messages:[...merged.values()],running:active.running,chatStatus:{...view.chatStatus!,phase:active.chatStatus?.phase??"idle"},pending:null};}
    const archived=!!entry?.source.archived||!!entry?.source.archiveUncertain||!!this.#store.find(key)?.archived||!!this.#store.find(key)?.archiveUncertain;
    const delivery=this.#store.snapshot().delivery;
    const own=state.owner===owner,available=!delivery&&!this.#gate&&!view.loading&&!view.pending&&!view.running;
    const attached=!entry||!!runtime&&runtime.snapshot().route.threadId===key;
    const canEdit=delivery?.key!==key&&own&&attached&&!archived&&!browsing&&!entry?.attaching&&!entry?.closing&&!same;
    const busyRuntime=[this.#main,...[...this.#entries.values()].flatMap(row=>row.runtime?[row.runtime]:[])].some(actor=>{const value=actor.snapshot();return value.running||!!value.pending||value.loading;});
    const canSend=canEdit&&available&&!busyRuntime&&!!runtime?.snapshot().chatStatus?.ready&&view.connection==="ready";
    const notice=this.#notices.get(owner)??(delivery?"上次发送结果待核对；草稿保留且发送锁定。请在主窗口核对保存记录，不会自动重发。":archived?"此会话已归档或状态待核实，只读。":state.owner&&state.owner!==owner?"另一窗口正在编辑；请先在该窗口保存并释放编辑权。":this.#gate?this.#gate.unknown?"发送结果或保存状态待核实；请在主窗口重连，不会自动重发。":same?"此会话正在确认或生成，所有窗口同步查看。":"另一会话正在确认或生成；此处可继续保存草稿，请等待后再发送。":own?"此窗口持有编辑权；草稿保存后可安全关闭。":"当前只读；可请求编辑权，不会强制覆盖其他窗口。");
    const draft=same&&active.running?active.draft:state.text;
    const common={...view,version:this.#version,draft,editor:{key,revision:state.revision,lease:own?state.token:null,owner:own?"self"as const:state.owner?"other"as const:"none"as const,notice,canEdit,canSend,deliveryPending:!!delivery&&(owner==="main"||delivery.key===key),execution:this.#gate?(this.#gate.unknown?"unknown":this.#gate.key):null}};
    if(!entry)return common;
    return {...common,title:entry.source.title,projects:[{id:"preview",name:"会话副窗口",threads:[{id:entry.id,title:entry.source.title}]}],route:{projectId:"preview",threadId:entry.id},coreStatus:undefined,managedSessions:undefined,sessionSearch:undefined,sessionSections:undefined,sectionOrder:undefined,copyAvailable:false,sessionPreview:{id:entry.id,archived:entry.source.archived,archiveUncertain:!!entry.source.archiveUncertain,notice},pending:state.owner===owner?view.pending:null};
  }
  previewSource(id:string):PreviewSource{return this.#main.previewSource(id);}
  searchPreviewSource(id:string):PreviewSource{return this.#main.searchPreviewSource(id);}
  registerPreview(owner:string,source:PreviewSource,budget:PreviewReadBudget):EditableSessionSurface{
    if(this.#disposed||owner==="main"||this.#entries.has(owner)||this.#entries.size>=4)throw new Error("preview-limit");
    const preview=new SessionPreview(this.#client,source,budget),entry:Entry={id:source.id,source:{...source},preview,off:()=>{},attaching:false,closed:false,closing:false};
    entry.off=preview.subscribe(()=>this.#publish());this.#entries.set(owner,entry);this.#publish();return new EditableSessionSurface(this,owner);
  }
  async #claim(owner:string):Promise<void>{
    const entry=this.#entries.get(owner),key=entry?.id??this.#key();if(owner!=="main"&&!entry)throw new Error("unknown-window");
    if(entry?.source.archived||entry?.source.archiveUncertain||this.#store.find(key)?.ephemeral||this.#store.find(key)?.archived||this.#store.find(key)?.archiveUncertain)throw new Error("editor-read-only-source");
    if(entry?.attaching)throw new Error("editor-attaching");if(entry)entry.attaching=true;
    try{this.#leases.claim(key,owner);}catch(error){if(entry)entry.attaching=false;throw error;}this.#suppressed.delete(key);this.#publish();
    if(!entry){await this.#main.dispatch({type:"draft",routeId:key,text:this.#leases.state(key).text});return;}
    this.#publish();
    try{
      if(!entry.runtime){const borrowed:WorkbenchClient={...this.#client,start:async()=>{if(this.#client.getView().state!=="ready")throw new Error("main-reconnect-required");},reconnect:async()=>{throw new Error("main-reconnect-required");},dispose:async()=>{}};
        entry.runtime=new OfficialChatController(borrowed,this.#cwd,this.#offline,15000,this.#store,null,{fixedThreadId:key,persistSelection:false,canWriteDraft:id=>id===key&&this.#leases.owns(key,owner)});
        entry.runtimeOff=entry.runtime.subscribe(()=>{this.#reconcile();this.#publish();});
      }
      if(!entry.runtime.snapshot().chatStatus?.ready||entry.runtime.snapshot().route.threadId!==key)await entry.runtime.dispatch({type:"connect"});
      const view=entry.runtime.snapshot();if(view.route.threadId!==key||!view.chatStatus?.ready||view.loading)throw new Error("editor-source-unverified");
      await entry.runtime.dispatch({type:"draft",routeId:key,text:this.#leases.state(key).text});
    }catch(error){this.#leases.release(key,owner);throw error;}
    finally{entry.attaching=false;this.#publish();}
  }
  async dispatch(value:unknown):Promise<DesktopView>{return this.dispatchOwner("main",value);}
  async dispatchOwner(owner:string,value:unknown):Promise<DesktopView>{
    if(this.#disposed)throw new Error("workspace-unavailable");const command=validateDesktopCommand(value),entry=this.#entries.get(owner);if(entry?.closing)throw new Error("window-closing");if(owner!=="main"&&!entry)throw new Error("unknown-window");
    if(entry&&!['claimEditor','releaseEditor','editDraft','submit','confirm','cancel','refreshHistory','history','cancelHistory','clearError','retryPersistence'].includes(command.type))throw new Error("fixed-session-command-rejected");
    this.#syncMain();const key=entry?.id??this.#key(),state=this.#leases.state(key);
    try{
      if(command.type==="retryPersistence"){
        const runtime=owner==="main"?this.#main:entry?.runtime;if(runtime)await runtime.flushDraftState();
        if(owner==="main")for(const item of [...this.#entries.values(),...this.#retired.values()])await item.runtime?.flushDraftState();
        await this.#store.settled();
      }else if(command.type==="reconcileDelivery"){
        if(owner!=="main"||this.#gate?.inflight)throw new Error("delivery-check-unavailable");
        const pending=this.#store.snapshot().delivery;if(!pending)throw new Error("no-pending-delivery");
        const generation=this.#client.getView().generation;if(this.#client.getView().state!=="ready")throw new Error("main-reconnect-required");
        const metadata=await this.#client.readThreadMetadata({threadId:pending.key});
        if(metadata.thread.id!==pending.key||metadata.thread.ephemeral||metadata.thread.modelProvider!=="openai"||!["idle","notLoaded"].includes(metadata.thread.status.type))throw new Error("unresolved-delivery");
        const page=await this.#client.listTurns({threadId:pending.key,limit:20,sortDirection:"desc",itemsView:"full"});
        if(this.#client.getView().state!=="ready"||generation!==this.#client.getView().generation||page.data.some(turn=>turn.status==="inProgress"))throw new Error("unresolved-delivery");
        const boundary=pending.beforeTurnId===null?(page.nextCursor? -1:page.data.length):page.data.findIndex(turn=>turn.id===pending.beforeTurnId);
        const accepted=boundary>=0&&page.data.slice(0,boundary).some(turn=>turn.items.some(item=>item.type==="userMessage"&&item.content.filter(value=>value.type==="text").map(value=>value.text).join("\n")===pending.text));
        if(!accepted)throw new Error("delivery-proof-unavailable");
        await this.#store.transaction(()=>{if(this.#store.snapshot().delivery?.token!==pending.token)throw new Error("delivery-record-changed");if(this.#store.find(pending.key)?.draft.trim()===pending.text)this.#store.upsert(pending.key,{draft:""});this.#store.pendingDelivery(null);});
        for(const actor of [this.#main,...[...this.#entries.values(),...this.#retired.values()].flatMap(row=>row.runtime?[row.runtime]:[])])actor.syncDraftFromStore(pending.key);
        if(this.#gate?.key===pending.key){this.#gate=null;await this.#collectRetired();}
      }else if(command.type==="claimEditor")await this.#claim(owner);
      else if(command.type==="releaseEditor"){
        if(this.#gate?.owner===owner||this.#leases.busy(key))throw new Error("editor-busy");
        this.#leases.release(key,owner);if(owner==="main")this.#suppressed.add(key);
      }else if(command.type==="editDraft"){
        if(command.routeId!==key||!this.snapshotOwner(owner).editor?.canEdit)throw new Error("editor-not-writable");
        await this.#leases.write(key,owner,command.revision,command.lease,command.text,()=>this.#runtime(owner).dispatch({type:"draft",routeId:key,text:command.text}));
      }else if(command.type==="draft")throw new Error("draft-revision-required");
      else if(command.type==="submit"){
        if(this.#leases.busy(key)||!this.snapshotOwner(owner).editor?.canSend)throw new Error("execution-occupied");const runtime=this.#runtime(owner),gate:Gate={key,owner,runtime,inflight:1,finishing:false,unknown:false};this.#gate=gate;this.#publish();
        try{await runtime.dispatch({type:"draft",routeId:key,text:state.text});await runtime.dispatch(command);}finally{gate.inflight--;this.#reconcile();}
      }else if(command.type==="confirm"){
        const gate=this.#gate;if(gate?.owner===owner&&gate.runtime.snapshot().running)return this.snapshotOwner(owner);if(!gate||gate.owner!==owner||!this.#leases.owns(key,owner)||!gate.runtime.snapshot().pending)throw new Error("confirmation-not-owned");
        gate.inflight++;try{await gate.runtime.dispatch(command);}finally{gate.inflight--;this.#reconcile();}
      }else if(command.type==="cancel"){
        const gate=this.#gate;if(gate&&gate.key===key){gate.inflight++;try{await gate.runtime.dispatch(command);}finally{gate.inflight--;this.#reconcile();}}else await this.#runtime(owner).dispatch(command);
      }else if(entry){
        if(command.type==="history"&&command.threadId!==entry.id)throw new Error("fixed-session-command-rejected");
        if(entry.runtime&&command.type!=="cancelHistory")await entry.runtime.dispatch(command);else await entry.preview.dispatch(command);
      }else{
        if(command.type==="new"&&this.#gate?.unknown)throw new Error("unresolved-execution");
        if(this.#leases.busy(key)&&!["disconnect","clearError"].includes(command.type))throw new Error("draft-save-inflight");
        if(mutations.has(command.type)&&(this.#store.snapshot().delivery||this.#gate||[...this.#entries.values()].some(row=>row.attaching)))throw new Error("execution-occupied");
        if(command.type==="archiveSession"&&this.#leases.state(command.id).owner&&this.#leases.state(command.id).owner!=="main")throw new Error("editor-occupied");
        if((command.type==="connect"||command.type==="reconnect")&&this.#gate?.runtime.snapshot().running)throw new Error("execution-occupied");
        if(command.type==="selectModel"&&!this.#leases.owns(key,"main"))throw new Error("editor-occupied");
        if(mutations.has(command.type)){const gate:Gate={key,owner:"main",runtime:this.#main,inflight:1,finishing:false,unknown:false};this.#gate=gate;try{await this.#main.dispatch(command);}finally{gate.inflight--;this.#reconcile();}}else{const activeGate=this.#gate;if(activeGate)activeGate.inflight++;try{await this.#main.dispatch(command);}finally{if(activeGate){activeGate.inflight--;this.#reconcile();}}}
        if((command.type==="connect"||command.type==="reconnect")&&!this.#store.snapshot().delivery&&this.#gate?.unknown&&this.#client.getView().state==="ready"){
          const gate=this.#gate,id=gate.key,generation=this.#client.getView().generation;
          if(id!=="official-chat"){const meta=await this.#client.readThreadMetadata({threadId:id});if(meta.thread.id!==id||meta.thread.ephemeral||meta.thread.modelProvider!=="openai"||meta.thread.status.type!=="idle"&&meta.thread.status.type!=="notLoaded")throw new Error("unresolved-execution");const page=await this.#client.listTurns({threadId:id,limit:20,sortDirection:"desc",itemsView:"full"});if(this.#client.getView().state!=="ready"||this.#client.getView().generation!==generation||page.data.some(turn=>turn.status==="inProgress"))throw new Error("unresolved-execution");this.#gate=null;}await this.#collectRetired();
        }
      }
      this.#notices.delete(owner);
    }catch(error){const code=error instanceof Error?error.message:"editor-operation-failed";this.#notices.set(owner,code==="draft-version-conflict"||code==="editor-lease-expired"?"草稿版本或编辑权已变化，本地未保存文字保留；请复制后重新取得编辑权。":code==="editor-occupied"?"此会话由另一窗口编辑，请先在那里保存并释放编辑权。":code==="execution-occupied"?"工作台已有发送或会话操作，请等待完成；草稿保留。":"操作或保存未完成，草稿保留；请检查占用、连接和保存状态后重试。");this.#publish();throw new Error(code);}
    this.#syncSources();this.#syncMain();this.#publish();return this.snapshotOwner(owner);
  }
  async closeOwner(owner:string):Promise<void>{
    const entry=this.#entries.get(owner);if(!entry)return;if(entry.closing||this.#leases.busy(entry.id))throw new Error("draft-save-inflight");
    if(this.#gate?.owner===owner&&this.#gate.runtime.snapshot().pending)await this.dispatchOwner(owner,{type:"cancel"});
    entry.closing=true;this.#publish();
    try{await this.#store.settled();if(this.#leases.busy(entry.id))throw new Error("draft-save-inflight");}
    catch(error){entry.closing=false;this.#publish();throw error;}
    entry.closed=true;entry.off();entry.preview.dispose();this.#entries.delete(owner);this.#listeners.delete(owner);
    if(this.#gate?.runtime===entry.runtime)this.#retired.set(owner,entry);else{this.#leases.release(entry.id,owner);entry.runtimeOff?.();entry.runtime?.detach();}
    this.#publish();
  }
  syncPreview(owner:string,source:PreviewSource):void{const entry=this.#entries.get(owner);if(entry&&entry.id===source.id&&JSON.stringify(entry.source)!==JSON.stringify(source)){entry.source={...source};entry.preview.sync(source);this.#publish();}}
  async verifyClose(owner:string,proof:unknown):Promise<void>{
    if(!proof||typeof proof!=="object"||Array.isArray(proof)||Object.keys(proof).sort().join(",")!=="key,lease,revision,text")throw new Error("invalid-close-proof");
    const value=proof as {key:string;revision:number;lease:string|null;text:string};await this.#store.settled();const view=this.snapshotOwner(owner),editor=view.editor!;
    if(value.key!==editor.key||value.revision!==editor.revision||value.lease!==editor.lease||value.text!==view.draft||this.#leases.busy(editor.key))throw new Error("close-save-not-confirmed");
  }
  async settled():Promise<void>{await this.#store.settled();}
  async dispose():Promise<void>{if(this.#disposed)return;this.#disposed=true;this.#off();this.#storeOff();for(const entry of [...this.#entries.values(),...this.#retired.values()]){entry.off();entry.runtimeOff?.();entry.preview.dispose();entry.runtime?.detach();}this.#entries.clear();this.#retired.clear();this.#listeners.clear();try{await this.#store.settled();}finally{await this.#main.disposeSaved();}}

}
export class EditableSessionSurface {
  #workspace:EditableWorkspace;#owner:string;
  constructor(workspace:EditableWorkspace,owner:string){this.#workspace=workspace;this.#owner=owner;}
  snapshot():DesktopView{return this.#workspace.snapshotOwner(this.#owner);}
  dispatch(value:unknown):Promise<DesktopView>{return this.#workspace.dispatchOwner(this.#owner,value);}
  subscribe(listener:()=>void):()=>void{return this.#workspace.subscribeOwner(this.#owner,listener);}
  sync(source:PreviewSource):void{this.#workspace.syncPreview(this.#owner,source);}
  dispose():void{void this.#workspace.closeOwner(this.#owner).catch(()=>{});}
  close():Promise<void>{return this.#workspace.closeOwner(this.#owner);}
}
