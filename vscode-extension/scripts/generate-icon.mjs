// Marketplace icon generator — adapted from dbt Anvil's scripts/generate-icon.mjs
// (same wordmark family: two lines, #777777, transparent background, works on
// both dark and light Marketplace/VS Code surfaces).
// Run: node scripts/generate-icon.mjs   (from vscode-extension/)
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wordmark = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <text
    x="64" y="38"
    font-family="Arial, Helvetica, sans-serif"
    font-size="64"
    font-weight="700"
    fill="${fill}"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="108"
    lengthAdjust="spacingAndGlyphs"
  >sql</text>
  <text
    x="64" y="90"
    font-family="Arial, Helvetica, sans-serif"
    font-size="64"
    font-weight="500"
    fill="${fill}"
    text-anchor="middle"
    dominant-baseline="middle"
    textLength="108"
    lengthAdjust="spacingAndGlyphs"
  >lens</text>
</svg>`;

function renderSvg(svgStr, size, destPath) {
	const r = new Resvg(svgStr, {
		fitTo: { mode: "width", value: size },
		background: "rgba(0,0,0,0)",
	});
	const buf = r.render().asPng();
	fs.mkdirSync(path.dirname(destPath), { recursive: true });
	fs.writeFileSync(destPath, buf);
	console.log("Written:", destPath);
}

const icons = path.join(__dirname, "..", "resources", "icons");
renderSvg(wordmark("#777777"), 128, path.join(icons, "sqllens-128.png"));
renderSvg(wordmark("#777777"), 512, path.join(icons, "sqllens-512.png"));
renderSvg(wordmark("#ffffff"), 256, path.join(icons, "sqllens-white-256.png"));
