export const OFFICIAL_CODEX_URL = "https://chatgpt.com/backend-api/codex";
/** Session-only overrides; existing files and default profiles are never edited. */
export function officialRouteOverrides() {
  return { model_provider: "openai", forced_login_method: "chatgpt", openai_base_url: OFFICIAL_CODEX_URL, chatgpt_base_url: "https://chatgpt.com/backend-api/", notify: [] as string[], "features.hooks": false };
}
/** Only server names are used; commands, URLs, headers and credential values are ignored. */
export function disableConfiguredMcp(config: Record<string, unknown>): string[] {
  const servers = config.mcp_servers;
  if (servers === undefined || servers === null) return [];
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("invalid-mcp-metadata");
  const names = Object.keys(servers);
  if (names.length > 64 || names.some(name => !name.length || name.length > 128 || /[\x00-\x1f]/.test(name))) throw new Error("mcp-metadata-budget");
  return names.length ? [`mcp_servers={${names.map(name => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`] : [];
}
export function assertOfficialRouteConfiguration(config: Record<string, unknown>): void {
  const features = config.features as Record<string, unknown> | undefined;
  if (config.model_provider !== "openai" || config.forced_login_method !== "chatgpt" || config.openai_base_url !== OFFICIAL_CODEX_URL || config.chatgpt_base_url !== "https://chatgpt.com/backend-api/") throw new Error("official-endpoint-not-confirmed");
  if (!Array.isArray(config.notify) || config.notify.length !== 0 || features?.hooks !== false) throw new Error("lifecycle-callbacks-not-disabled");
}
export function assertOfficialModelConfiguration(config: Record<string, unknown>): void {
  assertOfficialRouteConfiguration(config);
  const servers = config.mcp_servers as Record<string, { enabled?: boolean }> | undefined;
  if (servers && Object.values(servers).some(server => server.enabled !== false)) throw new Error("mcp-startup-not-disabled");
}

/** Pure text chat must not inherit enabled tools through managed config. */
export function assertOfficialChatConfiguration(config: Record<string, unknown>): void {
  assertOfficialModelConfiguration(config);
  const features = config.features as Record<string, unknown> | undefined;
  if (["background_paginated_rollout_migration", "goals", "daemon_auto_start", "shell_tool", "unified_exec", "view_image", "apps", "plugins", "code_mode", "multi_agent", "multi_agent_v2", "image_generation", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use"].some(name => features?.[name] !== false) || config.web_search !== "disabled" || (config.agents as { enabled?: boolean } | undefined)?.enabled !== false) throw new Error("chat-tools-not-disabled");
}
