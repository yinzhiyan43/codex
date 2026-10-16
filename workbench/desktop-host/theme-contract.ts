export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type ThemeState = { mode:ThemeMode; resolved:ResolvedTheme; revision:number };
export const isThemeMode = (value:unknown):value is ThemeMode => value==="light"||value==="dark"||value==="system";
export const resolveTheme = (mode:ThemeMode,systemDark:boolean):ResolvedTheme => mode==="system"?(systemDark?"dark":"light"):mode;
export const themeBackground = (theme:ResolvedTheme):string => theme==="dark"?"#181818":"#ffffff";
export function validateThemeState(value:unknown):ThemeState {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid-theme-state");
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join()!=="mode,resolved,revision"||!isThemeMode(v.mode)||!["light","dark"].includes(v.resolved as string)||!Number.isSafeInteger(v.revision)||(v.revision as number)<0||(v.mode!=="system"&&v.mode!==v.resolved))throw new Error("invalid-theme-state");
  return {...v} as ThemeState;
}
