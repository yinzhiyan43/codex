import { isThemeMode,resolveTheme,type ThemeMode,type ThemeState } from "./theme-contract.ts";
export type SystemAppearance={isDark():boolean;subscribe(listener:()=>void):()=>void};
/** Workbench window appearance only. Never sets OS appearance or nativeTheme.themeSource. */
export class ThemeController {
  #state:ThemeState;#source:SystemAppearance;#off:()=>void;#listeners=new Set<(state:ThemeState)=>void>();#disposed=false;
  constructor(mode:ThemeMode,source:SystemAppearance){if(!isThemeMode(mode))throw new Error("invalid-theme-mode");this.#source=source;this.#state={mode,resolved:resolveTheme(mode,source.isDark()),revision:0};this.#off=source.subscribe(()=>this.#apply(this.#state.mode));}
  snapshot():ThemeState{return {...this.#state};}
  subscribe(listener:(state:ThemeState)=>void):()=>void{if(this.#disposed||this.#listeners.size>=16)throw new Error("theme-unavailable");this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  #apply(mode:ThemeMode):void{if(this.#disposed)return;const resolved=resolveTheme(mode,this.#source.isDark());if(mode===this.#state.mode&&resolved===this.#state.resolved)return;this.#state={mode,resolved,revision:this.#state.revision+1};for(const listener of this.#listeners)try{listener(this.snapshot());}catch{}}
  setMode(value:unknown):void{if(!isThemeMode(value)||this.#disposed)throw new Error("invalid-theme-mode");this.#apply(value);}
  dispose():void{if(this.#disposed)return;this.#disposed=true;this.#off();this.#listeners.clear();}
}
