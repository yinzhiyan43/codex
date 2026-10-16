import { installInteractions, setText } from "./interactions.ts";
installInteractions();
import type {DesktopView} from "../desktop-host/demo-controller.ts";
import type {DesktopCommand} from "../desktop-host/ipc-contract.ts";
declare global{interface Window{workbench:{snapshot():Promise<DesktopView>;dispatch(command:DesktopCommand):Promise<DesktopView>;subscribe(listener:(view:DesktopView)=>void):()=>void}}}
const el=(id:string)=>document.getElementById(id)!;let version=-1;
function render(view:DesktopView){if(view.version<version)return;version=view.version;el("title").textContent=view.title;document.title=view.title+" — Codex Workbench 只读";
 setText(el("state"),(view.sessionPreview?.archiveUncertain?"归档结果待核实 · ":view.sessionPreview?.archived?"已归档 · ":"")+(view.loading?"正在读取 · ":"")+(view.stale?"缓存待刷新 · ":"")+view.history.turnCount+"个保存轮次 · "+(view.connection==="ready"?"已连接":"连接未就绪"));
 el("notice").textContent=view.sessionPreview?.notice??"只读副窗口";el("error").hidden=!view.error;el("error").textContent=view.error??"";
 (el("refresh")as HTMLButtonElement).disabled=view.loading||view.connection!=="ready";(el("older")as HTMLButtonElement).disabled=view.loading||!view.history.hasMore||view.connection!=="ready";el("cancel").hidden=!view.history.loading;
 const nodes=view.messages.map(message=>{const node=document.createElement("article"),role=document.createElement("span");node.className="message "+message.role;node.dataset.messageId=message.id;role.className="role";role.textContent=(message.role==="user"?"用户":"助手")+(message.stale?" · 缓存":"");node.append(role,document.createTextNode(message.text));return node;});const scroll=scrollY;el("messages").replaceChildren(...nodes);scrollTo(0,scroll);
}
async function send(command:DesktopCommand){try{render(await window.workbench.dispatch(command));}catch{el("error").hidden=false;el("error").textContent="读取未完成，请稍后刷新。";}}
el("refresh").addEventListener("click",()=>void send({type:"refreshHistory"}));el("older").addEventListener("click",()=>void window.workbench.snapshot().then(view=>{if(view.route.threadId)void send({type:"history",threadId:view.route.threadId});}));el("cancel").addEventListener("click",()=>void send({type:"cancelHistory"}));const off=window.workbench.subscribe(render);addEventListener("beforeunload",off,{once:true});void window.workbench.snapshot().then(render);
