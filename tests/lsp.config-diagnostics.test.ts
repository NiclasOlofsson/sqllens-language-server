// Config-file surface: .sqllens.json problems become positioned diagnostics on the
// config file itself, a hint diagnostic on SQL documents (the channel that reaches
// post-edit diagnostic consumers), change-dialect quickfixes, and live reload — an
// edit to the open config re-applies dialects without a server restart.
import { describe, expect, it, afterAll } from "vitest";
import {
	CodeActionRequest,
	DidChangeTextDocumentNotification,
	DiagnosticSeverity,
	type CodeAction,
} from "vscode-languageserver-protocol/node";
import { startLspHarness, type LspHarness } from "./helpers/lsp-harness.js";

const BAD_CONFIG = '{\n\t"default": "duckdbsd",\n\t"schema": "schema.json"\n}\n';
const FIXED_CONFIG = '{\n\t"default": "tsql",\n\t"schema": "schema.json"\n}\n';
const SCHEMA = JSON.stringify({ sales: { id: "bigint", amount: "decimal(10,2)" } });
// TOP is T-SQL syntax: a parse error under the databricks fallback, clean under tsql.
const TSQL_ONLY = "select top 3 amount from sales\n";

describe("lsp .sqllens.json diagnostics, quickfixes, live reload", () => {
	let h: LspHarness;
	afterAll(() => h.dispose());

	it("runs the full config-error loop", async () => {
		h = await startLspHarness({ ".sqllens.json": BAD_CONFIG, "schema.json": SCHEMA });

		// 1) Opening the broken config yields an Error diagnostic spanning the quoted bad value.
		const configUri = h.open(".sqllens.json", BAD_CONFIG);
		const configDiags = await h.waitForDiagnosticsWhere(configUri, (d) => d.diagnostics.length > 0);
		const diag = configDiags.diagnostics[0];
		expect(diag.severity).toBe(DiagnosticSeverity.Error);
		expect(diag.message).toContain('"duckdbsd"');
		expect(diag.range.start).toEqual({ line: 1, character: 12 }); // "duckdbsd" incl. quotes
		expect(diag.range.end).toEqual({ line: 1, character: 22 });

		// 2) A SQL document carries an Information hint pointing at the config, ahead of
		//    its own diagnostics (here: TOP fails to parse under the databricks fallback).
		const sqlUri = h.open("q.sql", TSQL_ONLY);
		const sqlDiags = await h.waitForDiagnosticsWhere(sqlUri, (d) => d.diagnostics.length >= 2);
		expect(sqlDiags.diagnostics[0].severity).toBe(DiagnosticSeverity.Information);
		expect(sqlDiags.diagnostics[0].message).toContain(".sqllens.json");
		expect(sqlDiags.diagnostics[0].message).toContain("duckdbsd");

		// 3) Quickfixes on the config diagnostic: one per dialect, closest name first & preferred.
		const actions = (await h.client.sendRequest(CodeActionRequest.type, {
			textDocument: { uri: configUri },
			range: diag.range,
			context: { diagnostics: [diag] },
		})) as CodeAction[];
		expect(actions.length).toBe(10);
		expect(actions[0].title).toBe('Change dialect to "duckdb"');
		expect(actions[0].isPreferred).toBe(true);
		expect(actions[0].edit?.changes?.[configUri]?.[0]?.newText).toBe('"duckdb"');
		expect(actions[0].edit?.changes?.[configUri]?.[0]?.range).toEqual(diag.range);

		// 4) Live reload: editing the open config re-validates AND re-applies dialects —
		//    config diagnostics clear, and the SQL document (now tsql) goes fully clean:
		//    hint gone, TOP parses.
		await h.client.sendNotification(DidChangeTextDocumentNotification.type, {
			textDocument: { uri: configUri, version: 2 },
			contentChanges: [{ text: FIXED_CONFIG }],
		});
		await h.waitForDiagnosticsWhere(configUri, (d) => d.diagnostics.length === 0);
		await h.waitForDiagnosticsWhere(sqlUri, (d) => d.diagnostics.length === 0);
	});
});
