import {setupToolWorkflow} from "./tool-workflow.ts";
import {setupRepository} from "./repository.ts";
import {installInteractions,setText,openModal,focusHandle} from "./interactions.ts";
import {plainEnter} from "./keyboard-policy.ts";
import {DraftEditor} from "./draft-editor.ts";
import {setupClose,type CloseBridge} from "./close-ui.ts";
import type {DesktopView} from "../desktop-host/demo-controller.ts";
import type {DesktopCommand} from "../desktop-host/ipc-contract.ts";
declare global{interface Window{workbench:{close:CloseBridge;snapshot():Promise<DesktopView>;dispatch(command:DesktopCommand):Promise<DesktopView>;subscribe(listener:(view:DesktopView)=>void):()=>void}}}
installInteractions();
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id)as T;let version=-1,view:DesktopView|null=null,editor:DraftEditor|null=null;
const workflowUI=setupToolWorkflow(el("tool-workflow"),command=>window.workbench.dispatch(command),render);
const repositoryUI=setupRepository(el("repository-panel"),command=>window.workbench.dispatch(command),render,async()=>{await editor?.flush();});
setupClose(window.workbench.close,async()=>{await editor?.flush();},()=>window.workbench.snapshot(),el("close-status"));
function createEditor():void{
 if(editor)return;
 const form=document.createElement("form");form.id="preview-composer";
 const label=document.createElement("label");label.htmlFor="preview-draft";label.textContent="此会话的消息草稿";
 const input=document.createElement("textarea");input.id="preview-draft";input.maxLength=4000;input.rows=3;
 const send=document.createElement("button");send.id="preview-send";send.type="submit";send.textContent="确认发送";
 const stop=document.createElement("button");stop.id="preview-stop";stop.type="button";stop.textContent="停止本轮";stop.hidden=true;stop.addEventListener("click",()=>void dispatch({type:"cancel"}));
 form.append(label,input,send,stop);el("editor-form").append(form);
 editor=new DraftEditor(input,el("editor-status"),command=>window.workbench.dispatch(command),render);
 form.addEventListener("submit",event=>{event.preventDefault();void(async()=>{try{await editor!.flush();await dispatch({type:"submit"});}catch{el("editor-status").textContent="草稿尚未保存，未发送；本地文字保留。";}})();});
 input.addEventListener("input",()=>{send.disabled=!view?.editor?.canSend||!input.value.trim()||!!editor?.failed();});
 input.addEventListener("keydown",event=>{if(plainEnter(event)){event.preventDefault();if(view?.editor?.canSend)form.requestSubmit();}});
 input.focus();
}
function render(next:DesktopView):void{
 if(next.version<version)return;workflowUI.render(next.workflow);repositoryUI.render(next.repository);version=next.version;view=next;
 const editable=next.editor?.owner==="self";el("title").textContent=next.title;document.title=next.title+" — Codex Workbench "+(editable?"会话编辑":"只读");
 setText(el("state"),(next.sessionPreview?.archiveUncertain?"归档结果待核实 · ":next.sessionPreview?.archived?"已归档 · ":"")+(next.loading?"正在读取 · ":"")+(next.running?"正在生成 · ":"")+(next.stale?"缓存待刷新 · ":"")+next.history.turnCount+"个保存轮次 · "+(next.connection==="ready"?"已连接":"连接未就绪"));
 setText(el("notice"),next.editor?.notice??next.sessionPreview?.notice??"只读副窗口");el("error").hidden=!next.error;setText(el("error"),next.error??"");
 el<HTMLButtonElement>("refresh").disabled=next.loading||next.running||next.connection!=="ready";el<HTMLButtonElement>("older").disabled=next.loading||next.running||!next.history.hasMore||next.connection!=="ready";el("cancel").hidden=!next.history.loading;
 const nodes=next.messages.map(message=>{const node=document.createElement("article"),role=document.createElement("span");node.className="message "+message.role;node.dataset.messageId=message.id;role.className="role";role.textContent=(message.role==="user"?"用户":"助手")+(message.stale?" · 缓存":"");node.append(role,document.createTextNode(message.text));return node;});const scroll=scrollY;el("messages").replaceChildren(...nodes);scrollTo(0,scroll);
 el("editor-controls").hidden=!next.editor;
 if(next.editor){el("enable-editor").textContent=editable&&!next.chatStatus?.ready?"重新核验会话":"取得编辑权";el("enable-editor").hidden=editable&&!!next.chatStatus?.ready;el<HTMLButtonElement>("enable-editor").disabled=next.editor.owner==="other"||!!next.sessionPreview?.archived||!!next.sessionPreview?.archiveUncertain||next.loading;el("release-editor").hidden=!editable;el<HTMLButtonElement>("release-editor").disabled=!!next.editor.execution;setText(el("editor-model"),next.chatStatus?.model?"沿用会话模型："+next.chatStatus.model:"");if(editable)createEditor();if(editor){editor.render(next);el("retry-draft").hidden=!editor.failed();el("use-saved-draft").hidden=!editor.failed();el<HTMLButtonElement>("preview-send").disabled=!next.editor.canSend||!el<HTMLTextAreaElement>("preview-draft").value.trim()||editor.failed();el("preview-stop").hidden=!next.running;}}
 const dialog=el<HTMLDialogElement>("preview-confirm");if(next.pending){setText(el("preview-pending"),next.pending);if(!dialog.open)openModal(dialog,focusHandle(el("preview-draft")),el("preview-cancel-confirm"));}else if(dialog.open)dialog.close();
}
async function dispatch(command:DesktopCommand):Promise<void>{try{render(await window.workbench.dispatch(command));}catch{el("error").hidden=false;el("error").textContent="操作未完成，草稿保留；请检查编辑权、保存状态与连接后重试。";}}
el("refresh").addEventListener("click",()=>void dispatch({type:"refreshHistory"}));el("older").addEventListener("click",()=>{if(view?.route.threadId)void dispatch({type:"history",threadId:view.route.threadId});});el("cancel").addEventListener("click",()=>void dispatch({type:"cancelHistory"}));
el("enable-editor").addEventListener("click",()=>void dispatch({type:"claimEditor"}));el("release-editor").addEventListener("click",()=>{void(async()=>{try{await editor?.flush();await dispatch({type:"releaseEditor"});}catch{el("editor-status").textContent="草稿保存未确认，编辑权保留。";}})();});
el("retry-draft").addEventListener("click",()=>void editor?.retry().catch(()=>{}));el("use-saved-draft").addEventListener("click",()=>void window.workbench.snapshot().then(next=>{editor?.useSaved(next);render(next);}));
el("preview-confirm-send").addEventListener("click",()=>void dispatch({type:"confirm"}));el("preview-cancel-confirm").addEventListener("click",()=>void dispatch({type:"cancel"}));el("preview-confirm").addEventListener("cancel",event=>{event.preventDefault();void dispatch({type:"cancel"});});
const off=window.workbench.subscribe(render);addEventListener("beforeunload",off,{once:true});void window.workbench.snapshot().then(render);

el("retry-persistence").addEventListener("click",()=>void dispatch({type:"retryPersistence"}));
