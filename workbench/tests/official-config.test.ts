import test from "node:test";
import assert from "node:assert/strict";
import { officialRouteOverrides, disableConfiguredMcp, assertOfficialModelConfiguration, assertOfficialRouteConfiguration, OFFICIAL_CODEX_URL } from "../desktop-host/official-config.ts";
const safe = () => ({ model_provider: "openai", forced_login_method: "chatgpt", openai_base_url: OFFICIAL_CODEX_URL, chatgpt_base_url: "https://chatgpt.com/backend-api/", notify: [], features: { hooks: false }, mcp_servers: {} });
test("official route overrides replace custom endpoint and notification hooks without file changes", () => {
  const original = { model_provider: "local", openai_base_url: "http://localhost:9999", notify: ["must-not-run"] };
  const merged = { ...original, ...officialRouteOverrides() };
  assert.equal(merged.openai_base_url, OFFICIAL_CODEX_URL); assert.equal(merged.model_provider, "openai"); assert.deepEqual(merged.notify, []); assert.equal(merged["features.hooks"], false);
  assert.equal(original.openai_base_url, "http://localhost:9999");
});
test("MCP override generation uses names only and quotes dotted server names", () => {
  const args = disableConfiguredMcp({ mcp_servers: { "server.with.dots": { command: "must-not-run", env: { TOKEN: "must-not-copy" } } } });
  assert.deepEqual(args, ['mcp_servers={"server.with.dots"={enabled=false}}']); assert.equal(args.join().includes("must-not"), false);
  assert.throws(() => disableConfiguredMcp({ mcp_servers: { "bad\nname": {} } }), /budget/);
});
test("model guard fails closed for custom routes, MCP and hooks before thread creation", () => {
  assert.doesNotThrow(() => assertOfficialModelConfiguration(safe()));
  for (const config of [{ ...safe(), openai_base_url: "http://localhost:9999" }, { ...safe(), notify: ["must-not-run"] }, { ...safe(), features: { hooks: true } }, { ...safe(), mcp_servers: { unused: {} } }]) assert.throws(() => assertOfficialModelConfiguration(config));
  assert.doesNotThrow(() => assertOfficialModelConfiguration({ ...safe(), mcp_servers: { disabled: { enabled: false } } }));
});

test("route guard handles managed provider and ChatGPT base overrides before catalog access", () => {
  assert.doesNotThrow(() => assertOfficialRouteConfiguration({ ...safe(), mcp_servers: { metadataOnly: {} } }));
  for (const config of [{ ...safe(), model_provider: "other" }, { ...safe(), chatgpt_base_url: "https://example.invalid/" }]) assert.throws(() => assertOfficialRouteConfiguration(config), /official-endpoint-not-confirmed/);
});
