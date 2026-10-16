import type {DesktopView} from "../desktop-host/demo-controller.ts";
import type {CloseProof} from "../desktop/close-preload.ts";
import {composition} from "./interactions.ts";
export type CloseBridge={onRequest(prepare:()=>Promise<CloseProof>,failed:()=>void):()=>void};
export function setupClose(bridge:CloseBridge,flush:()=>Promise<void>,snapshot:()=>Promise<DesktopView>,status:HTMLElement):void{
 bridge.onRequest(async()=>{if(composition.blocked())throw new Error("finish-composition-first");document.body.inert=true;await flush();const view=await snapshot(),editor=view.editor;return editor?{key:editor.key,revision:editor.revision,lease:editor.lease,text:view.draft}:null;},()=>{document.body.inert=false;status.textContent="关闭前的草稿保存尚未确认；窗口已保留。请完成输入法编辑、检查保存状态后再关闭。";status.hidden=false;status.setAttribute("role","alert");});
}
