import {validateThemeState,type ThemeState} from "../desktop-host/theme-contract.ts";
// Blocking self-hosted head script, before either window's stylesheets.
const bridge=(window as unknown as {workbench:{theme:{initial:ThemeState;subscribe(fn:(state:ThemeState)=>void):()=>void}}}).workbench.theme;
let revision=-1;
function apply(value:ThemeState){try{const state=validateThemeState(value);if(state.revision<revision)return;revision=state.revision;document.documentElement.dataset.theme=state.resolved;document.documentElement.dataset.themeMode=state.mode;}catch{}}
apply(bridge.initial);const off=bridge.subscribe(apply);addEventListener("beforeunload",off,{once:true});
