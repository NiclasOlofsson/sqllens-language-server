// Config layering: ~/.sqllens.json (user layer) merges under the workspace
// .sqllens.json (project layer). Project wins on scalars; plugin lists
// concatenate user-first with per-module option deep-merge (the dbt
// profiles.yml split: the repo says WHAT, the user file says HOW).
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDialectConfig } from "../src/dialect-config.js";

function workspace(files: Record<string, string>): { root: string; user: string; done: () => void } {
	const root = mkdtempSync(join(tmpdir(), "sqllens-layer-"));
	const home = join(root, "home");
	mkdirSync(home);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
	return { root, user: join(home, ".sqllens.json"), done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("config layering", () => {
	it("parses project plugins into specs with project layer and workspace baseDir", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({
				default: "duckdb",
				plugins: ["sqllens-plugin-databricks", { module: "./tools/lint.mjs", options: { maxJoins: 6 } }],
			}),
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.plugins).toHaveLength(2);
		expect(config.plugins[0]).toMatchObject({
			module: "sqllens-plugin-databricks",
			layer: "project",
			baseDir: ws.root,
			options: {},
		});
		expect(config.plugins[1]).toMatchObject({
			module: "./tools/lint.mjs",
			layer: "project",
			options: { maxJoins: 6 },
		});
		ws.done();
	});

	it("loads user-layer plugins ordered before project plugins, based in the user config dir", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({ plugins: ["./project-plugin.mjs"] }),
			"home/.sqllens.json": JSON.stringify({ plugins: ["./user-plugin.mjs"] }),
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.plugins.map((p) => p.module)).toEqual(["./user-plugin.mjs", "./project-plugin.mjs"]);
		expect(config.plugins[0].layer).toBe("user");
		expect(config.plugins[0].baseDir).toBe(join(ws.root, "home"));
		expect(config.plugins[1].baseDir).toBe(ws.root);
		ws.done();
	});

	it("dedupes the same bare module across layers: one spec, project layer, options deep-merged project-wins", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({
				plugins: [{ module: "sqllens-plugin-databricks", options: { profile: "oatly-prod" } }],
			}),
			"home/.sqllens.json": JSON.stringify({
				plugins: [{ module: "sqllens-plugin-databricks", options: { token: "secret", profile: "dev" } }],
			}),
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.plugins).toHaveLength(1);
		expect(config.plugins[0].layer).toBe("project");
		expect(config.plugins[0].options).toEqual({ token: "secret", profile: "oatly-prod" });
		ws.done();
	});

	it("project default dialect wins over the user layer's", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({ default: "tsql" }),
			"home/.sqllens.json": JSON.stringify({ default: "snowflake" }),
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.dialectFor("q.sql")).toBe("tsql");
		ws.done();
	});

	it("user default dialect applies when the project sets none", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({}),
			"home/.sqllens.json": JSON.stringify({ default: "snowflake" }),
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.dialectFor("q.sql")).toBe("snowflake");
		ws.done();
	});

	it("a missing user config is zero-config: no warnings, no plugins", () => {
		const ws = workspace({ ".sqllens.json": JSON.stringify({ default: "duckdb" }) });
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.plugins).toEqual([]);
		expect(config.warnings).toEqual([]);
		ws.done();
	});

	it("a malformed user config warns but never creates positioned issues (those are project-file-only)", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({ default: "duckdb" }),
			"home/.sqllens.json": "{ not json",
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.warnings.some((w) => w.includes("user"))).toBe(true);
		expect(config.issues).toEqual([]);
		ws.done();
	});

	it("user schema applies when the project has none, resolved relative to the user config dir", () => {
		const ws = workspace({
			".sqllens.json": JSON.stringify({}),
			"home/.sqllens.json": JSON.stringify({ schema: "catalog.json" }),
			"home/catalog.json": JSON.stringify({ sales: { amount: "decimal" } }),
		});
		const config = loadDialectConfig(ws.root, undefined, ws.user);
		expect(config.schema?.columnsFor(["sales"])).toBeDefined();
		ws.done();
	});
});
