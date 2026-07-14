// End-to-end plugin system: ESM modules declared in .sqllens.json (either layer)
// are imported, activate(ctx) runs, schema providers feed the catalog through
// the CallbackSchema seam, and hooks shape diagnostics/hover/completion/code
// actions. A broken plugin degrades to absent — never to a broken server.
import { describe, it, expect, afterEach } from "vitest";
import {
	HoverRequest,
	CompletionRequest,
	CodeActionRequest,
	type CompletionItem,
	type CodeAction,
} from "vscode-languageserver-protocol/node";
import { startLspHarness, type LspHarness } from "./helpers/lsp-harness.js";

let h: LspHarness | undefined;
afterEach(() => {
	h?.dispose();
	h = undefined;
	delete process.env.SQLLENS_NO_PLUGINS;
});

const SCHEMA_PLUGIN = `
export const api = 1;
export default function activate() {
	return {
		schema: {
			resolve(parts) {
				if (parts.join(".") === "sales") return [{ name: "id", type: "bigint" }, { name: "amount", type: "decimal" }];
				return undefined;
			},
		},
	};
}
`;

const LAZY_SCHEMA_PLUGIN = `
export const api = 1;
export default function activate() {
	const cache = new Map();
	return {
		schema: {
			resolve(parts) { return cache.get(parts.join(".")); },
			async fetch(missing) {
				for (const parts of missing) {
					if (parts.join(".") === "sales") cache.set("sales", [{ name: "amount", type: "decimal" }]);
				}
			},
		},
	};
}
`;

const HOOKS_PLUGIN = `
export const api = 1;
export default function activate(ctx) {
	return {
		hooks: {
			diagnostics({ diagnostics }) {
				diagnostics.push({
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
					severity: 2,
					message: "custom rule from plugin; options=" + JSON.stringify(ctx.options),
					source: "test-plugin",
				});
			},
			hover({ cards }) { cards.push("Owner: data-platform"); },
			completion({ items }) { items.push({ label: "magic_snippet" }); },
			codeActions({ actions }) { actions.push({ title: "Apply magic fix" }); },
		},
	};
}
`;

const THROWING_PLUGIN = `
export const api = 1;
export default function activate() {
	return {
		hooks: {
			diagnostics() { throw new Error("plugin exploded"); },
			hover() { throw new Error("plugin exploded"); },
		},
	};
}
`;

const hoverValue = (hover: unknown): string => (hover as { contents: { value: string } }).contents.value;
// Diagnostic.message is string | MarkupContent in protocol 3.18 — normalize for matching.
const msgText = (m: unknown): string => (typeof m === "string" ? m : (m as { value: string }).value);

describe("plugin system (e2e)", () => {
	it("a path plugin's schema provider feeds unknown-column diagnostics", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./catalog-plugin.mjs"] }),
			"catalog-plugin.mjs": SCHEMA_PLUGIN,
		});
		const uri = h.open("q.sql", "SELECT amont FROM sales");
		const d = await h.waitForDiagnosticsWhere(uri, (p) =>
			p.diagnostics.some((x) => /amont/.test(msgText(x.message))),
		);
		expect(d.diagnostics.some((x) => /amont/.test(msgText(x.message)))).toBe(true);
	});

	it("an async-fetch schema plugin self-heals through the prime loop", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./lazy-plugin.mjs"] }),
			"lazy-plugin.mjs": LAZY_SCHEMA_PLUGIN,
		});
		const uri = h.open("q.sql", "SELECT amont FROM sales");
		const d = await h.waitForDiagnosticsWhere(uri, (p) =>
			p.diagnostics.some((x) => /amont/.test(msgText(x.message))),
		);
		expect(d.diagnostics.some((x) => /amont/.test(msgText(x.message)))).toBe(true);
	});

	it("the diagnostics hook appends plugin diagnostics with merged layered options in ctx", async () => {
		h = await startLspHarness({
			".sqllens.user.json": JSON.stringify({
				plugins: [{ module: "./hooks-plugin.mjs", options: { token: "home-secret", profile: "dev" } }],
			}),
			".sqllens.json": JSON.stringify({
				plugins: [{ module: "./hooks-plugin.mjs", options: { profile: "prod" } }],
			}),
			"hooks-plugin.mjs": HOOKS_PLUGIN,
		});
		const uri = h.open("q.sql", "SELECT 1");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.some((x) => x.source === "test-plugin"));
		const custom = d.diagnostics.find((x) => x.source === "test-plugin")!;
		expect(custom.message).toContain('"token":"home-secret"');
		expect(custom.message).toContain('"profile":"prod"');
	});

	it("a user-layer plugin is active with no project config at all", async () => {
		h = await startLspHarness({
			".sqllens.user.json": JSON.stringify({ plugins: ["./user-plugin.mjs"] }),
			"user-plugin.mjs": HOOKS_PLUGIN,
		});
		const uri = h.open("q.sql", "SELECT 1");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.some((x) => x.source === "test-plugin"));
		expect(d.diagnostics.some((x) => x.source === "test-plugin")).toBe(true);
	});

	it("a bare npm name loads from the workspace node_modules", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["sqllens-plugin-test"] }),
			"node_modules/sqllens-plugin-test/package.json": JSON.stringify({
				name: "sqllens-plugin-test",
				type: "module",
				main: "index.mjs",
			}),
			"node_modules/sqllens-plugin-test/index.mjs": HOOKS_PLUGIN,
		});
		const uri = h.open("q.sql", "SELECT 1");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.some((x) => x.source === "test-plugin"));
		expect(d.diagnostics.some((x) => x.source === "test-plugin")).toBe(true);
	});

	it("the hover hook appends a card to the server's own hover", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./hooks-plugin.mjs"] }),
			"hooks-plugin.mjs": HOOKS_PLUGIN,
		});
		const sql = "SELECT amount FROM sales";
		const uri = h.open("q.sql", sql);
		await h.waitForDiagnostics(uri);
		const hover = await h.client.sendRequest(HoverRequest.type, {
			textDocument: { uri },
			position: { line: 0, character: sql.indexOf("sales") },
		});
		expect(hover).not.toBeNull();
		expect(hoverValue(hover)).toContain("— table"); // the server's own card survives
		expect(hoverValue(hover)).toContain("Owner: data-platform");
	});

	it("the completion hook appends items", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./hooks-plugin.mjs"] }),
			"hooks-plugin.mjs": HOOKS_PLUGIN,
		});
		const sql = "SELECT  FROM sales";
		const uri = h.open("q.sql", sql);
		await h.waitForDiagnostics(uri);
		const items = (await h.client.sendRequest(CompletionRequest.type, {
			textDocument: { uri },
			position: { line: 0, character: "SELECT ".length },
		})) as CompletionItem[];
		expect(items.some((i) => i.label === "magic_snippet")).toBe(true);
	});

	it("the codeActions hook appends actions on SQL documents", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./hooks-plugin.mjs"] }),
			"hooks-plugin.mjs": HOOKS_PLUGIN,
		});
		const uri = h.open("q.sql", "SELECT 1");
		await h.waitForDiagnostics(uri);
		const actions = (await h.client.sendRequest(CodeActionRequest.type, {
			textDocument: { uri },
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			context: { diagnostics: [] },
		})) as CodeAction[];
		expect(actions.some((a) => a.title === "Apply magic fix")).toBe(true);
	});

	it("a throwing hook is isolated: the server's own answers still ship", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./throwing-plugin.mjs"] }),
			"throwing-plugin.mjs": THROWING_PLUGIN,
		});
		const sql = "SELECT amount FROM sales";
		const uri = h.open("q.sql", "SELEC 1");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.length > 0);
		expect(d.diagnostics.some((x) => x.source !== "test-plugin")).toBe(true);
		const uri2 = h.open("q2.sql", sql);
		await h.waitForDiagnostics(uri2);
		const hover = await h.client.sendRequest(HoverRequest.type, {
			textDocument: { uri: uri2 },
			position: { line: 0, character: sql.indexOf("sales") },
		});
		expect(hover).not.toBeNull();
		expect(hoverValue(hover)).toContain("— table");
	});

	it("a plugin requiring a newer api version is skipped, not loaded half-way", async () => {
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./future-plugin.mjs"] }),
			"future-plugin.mjs": HOOKS_PLUGIN.replace("export const api = 1;", "export const api = 99;"),
		});
		const uri = h.open("q.sql", "SELEC 1");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.length > 0);
		expect(d.diagnostics.some((x) => x.source === "test-plugin")).toBe(false);
	});

	// The exact plugin from the PLUGINS.md quick start — this test keeps the tutorial honest.
	it("the PLUGINS.md quick-start lint rule works as documented", async () => {
		const TUTORIAL_PLUGIN = `
export const api = 1;

const rangeOf = (span) => ({
	start: { line: span.line - 1, character: span.column },
	end: { line: span.endLine - 1, character: span.endColumn },
});

export default function activate(ctx) {
	return {
		hooks: {
			diagnostics({ session, diagnostics }) {
				for (const sym of session.deriveSymbols()) {
					if (sym.kind === "table" && !sym.alias) {
						diagnostics.push({
							range: rangeOf(sym.span),
							severity: 2,
							message: "Team rule: every table gets an alias.",
							source: "sqllens-rules",
						});
					}
				}
			},
		},
	};
}
`;
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./sqllens-rules.mjs"] }),
			"sqllens-rules.mjs": TUTORIAL_PLUGIN,
		});
		const bare = h.open("bare.sql", "SELECT amount FROM sales");
		const d = await h.waitForDiagnosticsWhere(bare, (p) => p.diagnostics.some((x) => x.source === "sqllens-rules"));
		const rule = d.diagnostics.find((x) => x.source === "sqllens-rules")!;
		expect(msgText(rule.message)).toContain("alias");
		expect(rule.range.start.character).toBe("SELECT amount FROM ".length);
		const aliased = h.open("aliased.sql", "SELECT s.amount FROM sales AS s");
		const d2 = await h.waitForDiagnostics(aliased);
		expect(d2.diagnostics.some((x) => x.source === "sqllens-rules")).toBe(false);
	});

	it("SQLLENS_NO_PLUGINS=1 disables plugin loading entirely", async () => {
		process.env.SQLLENS_NO_PLUGINS = "1";
		h = await startLspHarness({
			".sqllens.json": JSON.stringify({ plugins: ["./hooks-plugin.mjs"] }),
			"hooks-plugin.mjs": HOOKS_PLUGIN,
		});
		const uri = h.open("q.sql", "SELEC 1");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.length > 0);
		expect(d.diagnostics.some((x) => x.source === "test-plugin")).toBe(false);
	});
});
