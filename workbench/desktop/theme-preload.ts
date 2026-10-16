import { ipcRenderer } from "electron";
import {validateThemeState,type ThemeState} from "../desktop-host/theme-contract.ts";
/** Read-only in both windows. A synchronous, bounded local snapshot precedes paint. */
export function createThemeBridge(){
  const fallback:ThemeState={mode:"system",resolved:"dark",revision:0};
  let latest:ThemeState=fallback;
  const listeners=new Set<(state:ThemeState)=>void>();
  const handler=(_event:unknown,value:unknown)=>{try{const state=validateThemeState(value);if(state.revision<=latest.revision)return;latest=state;for(const fn of listeners)try{fn({...state});}catch{}}catch{}};
  ipcRenderer.on("workbench:theme",handler);
  try{const initial=validateThemeState(ipcRenderer.sendSync("workbench:theme-bootstrap"));if(initial.revision>=latest.revision)latest=initial;}catch{/* Use bounded display fallback only. */}
  addEventListener("beforeunload",()=>{listeners.clear();ipcRenderer.off("workbench:theme",handler);},{once:true});
  return Object.freeze({initial:{...latest},subscribe:(listener:(state:ThemeState)=>void)=>{
    if(typeof listener!=="function"||listeners.size>=8)throw new Error("invalid-theme-subscriber");listeners.add(listener);listener({...latest});return()=>{listeners.delete(listener);};
  }});
}
