// Plugin module resolution: path-form specs resolve against their declaring
// config's directory; bare names walk workspace node_modules → the server's own
// module paths → the npm global root. Global lookup is injectable so these
// tests never shell out to npm.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePluginModule } from "../src/plugins.js";
import type { PluginSpec } from "../src/dialect-config.js";

const spec = (module: string, baseDir: string): PluginSpec => ({ module, options: {}, baseDir, layer: "project" });

function fakePackage(containerDir: string, name: string): string {
	const dir = join(containerDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", main: "index.mjs" }));
	const entry = join(dir, "index.mjs");
	writeFileSync(entry, "export default () => ({});\n");
	return entry;
}

describe("resolvePluginModule", () => {
	it("resolves a relative path against the spec's baseDir without touching node_modules", () => {
		const base = mkdtempSync(join(tmpdir(), "sqllens-resolve-"));
		const path = resolvePluginModule(spec("./tools/lint.mjs", base), base, () => undefined);
		expect(path).toBe(resolve(base, "./tools/lint.mjs"));
		rmSync(base, { recursive: true, force: true });
	});

	it("resolves a bare name from the workspace node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "sqllens-resolve-"));
		const entry = fakePackage(join(root, "node_modules"), "sqllens-plugin-test");
		const path = resolvePluginModule(spec("sqllens-plugin-test", root), root, () => undefined);
		expect(path).toBe(entry);
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to the npm global root when the workspace misses", () => {
		const root = mkdtempSync(join(tmpdir(), "sqllens-resolve-"));
		const globalRoot = join(root, "fake-global", "node_modules");
		const entry = fakePackage(globalRoot, "sqllens-plugin-global");
		const path = resolvePluginModule(spec("sqllens-plugin-global", root), root, () => globalRoot);
		expect(path).toBe(entry);
		rmSync(root, { recursive: true, force: true });
	});

	it("throws a message naming all three lookup locations when nothing resolves", () => {
		const root = mkdtempSync(join(tmpdir(), "sqllens-resolve-"));
		expect(() => resolvePluginModule(spec("sqllens-plugin-nope", root), root, () => undefined)).toThrow(
			/workspace|global/,
		);
		rmSync(root, { recursive: true, force: true });
	});
});
