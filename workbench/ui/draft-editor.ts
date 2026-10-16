import type {DesktopView} from "../desktop-host/demo-controller.ts";
import type {DesktopCommand} from "../desktop-host/ipc-contract.ts";
/** One renderer queue: local text survives failed writes and stale snapshots. */
export class DraftEditor {
  #input:HTMLTextAreaElement;#send:(command:DesktopCommand)=>Promise<DesktopView>;#apply:(view:DesktopView)=>void;#status:HTMLElement;
  #view:DesktopView|null=null;#key="";#lease:string|null=null;#revision=0;#saved="";#dirty=false;#failed=false;#inflight:Promise<void>|null=null;
  constructor(input:HTMLTextAreaElement,status:HTMLElement,send:(command:DesktopCommand)=>Promise<DesktopView>,apply:(view:DesktopView)=>void){this.#input=input;this.#status=status;this.#send=send;this.#apply=apply;input.addEventListener("input",()=>{if(!this.#view?.editor?.canEdit)return;this.#dirty=true;this.#failed=false;void this.#pump().catch(()=>{});});}
  render(view:DesktopView):void{
    const editor=view.editor;if(!editor)return;this.#view=view;
    const changed=editor.key!==this.#key||editor.lease!==this.#lease;
    if(changed&&(this.#dirty||this.#inflight)){this.#failed=true;this.#status.textContent="编辑权变化，本地未保存文字保留；请先复制，或明确使用已保存草稿。";this.#input.readOnly=true;return;}
    if(changed||!this.#dirty&&!this.#inflight){this.#key=editor.key;this.#lease=editor.lease;this.#revision=editor.revision;this.#saved=view.draft;this.#input.value=view.draft;}
    this.#input.readOnly=!editor.canEdit;
    this.#status.textContent=this.#failed?"草稿保存未确认，本地文字保留；可重试保存或先复制。":this.#dirty||this.#inflight?"正在保存草稿…":editor.notice;
  }
  async #pump():Promise<void>{
    if(this.#inflight)return this.#inflight;if(!this.#dirty||this.#failed)return;
    if(!this.#lease||!this.#view?.editor?.canEdit){this.#failed=true;throw new Error("draft-not-writable");}
    const text=this.#input.value,key=this.#key,lease=this.#lease,revision=this.#revision;
    this.#inflight=(async()=>{try{const view=await this.#send({type:"editDraft",routeId:key,text,revision,lease});if(this.#key!==key||this.#lease!==lease)throw new Error("draft-editor-changed");this.#revision=view.editor!.revision;this.#saved=text;this.#dirty=this.#input.value!==text;this.#apply(view);}catch(error){this.#failed=true;this.#dirty=true;this.#status.textContent="草稿保存未确认，本地文字保留；请重试或复制后处理编辑权冲突。";if(this.#view)this.#apply(this.#view);throw error;}finally{this.#inflight=null;}})();
    await this.#inflight;if(this.#dirty&&!this.#failed)await this.#pump();else if(this.#view)this.render(this.#view);
  }
  async flush():Promise<void>{
    if(this.#view?.editor?.canEdit&&this.#input.value!==this.#saved)this.#dirty=true;
    if(this.#inflight)await this.#inflight;
    if(this.#failed)throw new Error("draft-save-unconfirmed");
    if(this.#dirty)await this.#pump();
    if(this.#dirty||this.#failed)throw new Error("draft-save-unconfirmed");
  }
  async retry():Promise<void>{this.#failed=false;await this.flush();}
  useSaved(view:DesktopView):void{if(this.#inflight)return;this.#dirty=false;this.#failed=false;this.#key="";this.#lease=null;this.render(view);}
  failed():boolean{return this.#failed;}
}
