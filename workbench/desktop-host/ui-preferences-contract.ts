import { isThemeMode,type ThemeMode } from "./theme-contract.ts";
/** Workbench-owned presentation only. Never accepts core/config/account fields. */
export type UiPreferences = {
  version: 2;
  theme:ThemeMode;
  sidebarVisible: boolean;
  sidebarWidth: 220 | 259 | 300;
  density: "comfortable" | "compact";
  fontSize: 13 | 14 | 16;
  collapsedGroups: string[];
};
export type UiPreferencesPatch = Partial<Omit<UiPreferences, "version">>;
export const defaultUiPreferences = (): UiPreferences => ({
  version: 2, theme:"system", sidebarVisible: true, sidebarWidth: 259, density: "comfortable", fontSize: 13, collapsedGroups: [],
});
const legacyKeys = ["sidebarVisible", "sidebarWidth", "density", "fontSize", "collapsedGroups"];
const keys = ["theme","sidebarVisible", "sidebarWidth", "density", "fontSize", "collapsedGroups"];
export function validateUiPreferencesPatch(value: unknown): UiPreferencesPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-ui-preferences");
  const v = value as Record<string, unknown>, fields = Object.keys(v);
  if (!fields.length || fields.some(key => !keys.includes(key))) throw new Error("invalid-ui-preferences");
  if (("theme" in v && !isThemeMode(v.theme)) ||
      ("sidebarVisible" in v && typeof v.sidebarVisible !== "boolean") ||
      ("sidebarWidth" in v && ![220, 259, 300].includes(v.sidebarWidth as number)) ||
      ("density" in v && !["comfortable", "compact"].includes(v.density as string)) ||
      ("fontSize" in v && ![13, 14, 16].includes(v.fontSize as number))) throw new Error("invalid-ui-preferences");
  if ("collapsedGroups" in v && (!Array.isArray(v.collapsedGroups) || v.collapsedGroups.length > 512 ||
      v.collapsedGroups.some(id => typeof id !== "string" || !/^[a-z0-9-]{1,64}$/.test(id)) ||
      new Set(v.collapsedGroups).size !== v.collapsedGroups.length)) throw new Error("invalid-ui-preferences");
  return structuredClone(value) as UiPreferencesPatch;
}
export function validateUiPreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-ui-preferences");
  const { version, ...patch } = value as Record<string, unknown>;
  const fields=Object.keys(patch);
  if(version===1&&fields.length===legacyKeys.length&&fields.every(key=>legacyKeys.includes(key))){
    // Existing v1 installations retain the dark appearance they previously had.
    return {version:2,theme:"dark",...validateUiPreferencesPatch(patch)} as UiPreferences;
  }
  if(version!==2||fields.length!==keys.length||fields.some(key=>!keys.includes(key)))throw new Error("invalid-ui-preferences");
  // Invalid persisted theme falls back without rewriting the original file.
  return {version:2,...validateUiPreferencesPatch({...patch,theme:isThemeMode(patch.theme)?patch.theme:"system"})} as UiPreferences;
}
