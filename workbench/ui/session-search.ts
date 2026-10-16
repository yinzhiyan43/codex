import { focusHandle, openModal, setText } from "./interactions.ts";
import { searchShortcut } from "./keyboard-policy.ts";
import type { DesktopView } from "../desktop-host/demo-controller.ts";
import type { DesktopCommand } from "../desktop-host/ipc-contract.ts";
export function setupSessionSearch(flushDraft:()=>Promise<void>,apply:(view:DesktopView)=>void){
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  const dialog=el<HTMLDialogElement>("session-search-dialog"),input=el<HTMLInputElement>("session-search-input"),scope=el<HTMLSelectElement>("session-search-scope"),kind=el<HTMLSelectElement>("session-search-kind");
  let opening=false,signature="";
  const dispatch=async(command:DesktopCommand)=>{try{apply(await window.workbench.dispatch(command));return true;}catch{el("session-search-status").textContent="操作未完成，请重试。";return false;}};
  const invalidate=()=>{signature="";void dispatch({type:"cancelSessionSearch"});};
  const close=()=>{dialog.close();};
  const open=(source:ReturnType<typeof focusHandle>)=>{void(async()=>{if(opening)return;opening=true;try{await flushDraft();openModal(dialog,source,input);}finally{opening=false;}})();};
  el("search-all-sessions").addEventListener("click",event=>open(focusHandle(event.currentTarget as HTMLElement)));
  el("session-search-close").addEventListener("click",close);
  dialog.addEventListener("close",()=>{invalidate();});
  input.addEventListener("input",invalidate);scope.addEventListener("change",invalidate);kind.addEventListener("change",invalidate);
  el("session-search-form").addEventListener("submit",event=>{event.preventDefault();if(input.value.trim())void dispatch({type:"searchSessions",text:input.value,archived:scope.value==="archived",kind:kind.value==="title"?"title":"content"});});
  el("session-search-more").addEventListener("click",()=>{void dispatch({type:"moreSessionSearch"});});
  el("session-search-cancel").addEventListener("click",invalidate);
  el("session-search-results").addEventListener("click",event=>{const target=(event.target as HTMLElement).closest<HTMLButtonElement>("button[data-search-result]");if(!target||target.disabled)return;void(async()=>{await flushDraft();if(await dispatch({type:"openSearchResult",id:target.dataset.searchResult!}))close();})();});
  document.addEventListener("keydown",event=>{if(searchShortcut(event)&&!document.querySelector('dialog[open]')){event.preventDefault();if(!el<HTMLButtonElement>("search-all-sessions").disabled)open(focusHandle());}});
  return (next:DesktopView)=>{
    const enabled=next.mode==="official-chat";el("search-all-sessions").hidden=!enabled;
    el<HTMLButtonElement>("search-all-sessions").disabled=!enabled||next.connection!=="ready";
    const state=next.sessionSearch;if(!state)return;
    setText(el("session-search-status"),state.notice);
    el("session-search-results").setAttribute("aria-busy",String(state.loading||state.inflight));
    el<HTMLButtonElement>("session-search-submit").disabled=next.connection!=="ready";
    el<HTMLButtonElement>("session-search-more").disabled=state.loading||state.inflight||state.stale||!state.more||next.connection!=="ready";
    el<HTMLButtonElement>("session-search-cancel").disabled=!state.loading&&!state.inflight;
    const key=JSON.stringify([state.rows,state.stale,state.loading,next.chatStatus?.phase,next.pending]);
    if(key!==signature){signature=key;const root=el("session-search-results"),focused=root.contains(document.activeElement)?(document.activeElement as HTMLElement).dataset.searchResult:null;root.replaceChildren();
      for(const row of state.rows){const li=document.createElement("li"),button=document.createElement("button"),title=document.createElement("strong"),snippet=document.createElement("span");button.type="button";button.dataset.searchResult=row.id;button.disabled=state.stale||state.loading||next.chatStatus?.phase!=="idle"||!!next.pending;button.setAttribute("aria-label",row.title+"，在只读副窗口中打开保存记录");title.textContent=row.title;snippet.textContent=row.snippet;snippet.id="search-snippet-"+root.children.length;button.setAttribute("aria-describedby",snippet.id);button.append(title,snippet);button.title="在只读副窗口中打开保存记录";li.append(button);root.append(li);}if(focused){const replacement=[...root.querySelectorAll<HTMLButtonElement>("button[data-search-result]")].find(button=>button.dataset.searchResult===focused&&!button.disabled);(replacement??input).focus();}
    }
  };
}
