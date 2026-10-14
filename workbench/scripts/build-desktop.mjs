import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const output = new URL(".desktop/", root);
await mkdir(output, { recursive: true });
for (const [source, target] of [["desktop/main.ts", "main.mjs"], ["desktop/preload.ts", "preload.cjs"], ["desktop/fixture-peer.mjs", "peer.cjs"], ["desktop/chat-fixture-peer.mjs", "chat-peer.cjs"]]) {
  await build({ entryPoints: [new URL(source, root).pathname], outfile: new URL(target, output).pathname, bundle: true, platform: "node", packages: "external", format: target.endsWith(".mjs") ? "esm" : "cjs", target: "node22", sourcemap: false });
}
await build({ entryPoints: [new URL("ui/renderer.ts", root).pathname], outfile: new URL("renderer.js", output).pathname, bundle: true, platform: "browser", format: "iife", target: "chrome130" });
for (const [source, target] of [["ui/index.html", "index.html"], ["ui/style.css", "style.css"], ["assets/workbench-icon.png", "workbench-icon.png"], ["node_modules/@phosphor-icons/web/src/regular/Phosphor.woff2", "Phosphor.woff2"]]) await copyFile(new URL(source, root), new URL(target, output));
const iconCSS = await readFile(new URL("node_modules/@phosphor-icons/web/src/regular/style.css", root), "utf8");
await writeFile(new URL("icons.css", output), iconCSS.replace(/src:[\s\S]*?;/, 'src: url("./Phosphor.woff2") format("woff2");'));
console.log("Built isolated workbench desktop shell");
