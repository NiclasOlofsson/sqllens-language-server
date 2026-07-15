// Language-id dialect binding: our own `sql-<dialect>` language ids (driven from sqllens's
// dialect keys) encode the dialect on the wire. A dialect-carrying language id is EXPLICIT
// configuration and wins over .sqllens.json glob rules; plain "sql" keeps the config path.
import { describe, it, expect, afterEach } from "vitest";
import { dialectFromLanguageId } from "../src/dialect-config.js";
import { startLspHarness, type LspHarness } from "./helpers/lsp-harness.js";

describe("dialectFromLanguageId", () => {
	it("maps sql-<dialect> ids through the dialect resolver", () => {
		expect(dialectFromLanguageId("sql-tsql")).toBe("tsql");
		expect(dialectFromLanguageId("sql-duckdb")).toBe("duckdb");
		expect(dialectFromLanguageId("sql-bigquery")).toBe("bigquery");
	});

	it("accepts engine names via the derived-dialect map (sql-athena is trino, sql-fabric is tsql)", () => {
		expect(dialectFromLanguageId("sql-athena")).toBe("trino");
		expect(dialectFromLanguageId("sql-fabric")).toBe("tsql");
	});

	it("plain sql, foreign ids, and unknown suffixes carry no dialect", () => {
		expect(dialectFromLanguageId("sql")).toBeUndefined();
		expect(dialectFromLanguageId("plaintext")).toBeUndefined();
		expect(dialectFromLanguageId("sql-klingon")).toBeUndefined();
	});
});

describe("language-id binding (e2e)", () => {
	let h: LspHarness | undefined;
	afterEach(() => {
		h?.dispose();
		h = undefined;
	});

	// SELECT TOP is T-SQL-only: it parses clean under tsql and is a syntax error elsewhere.
	const TOP = "SELECT TOP 5 amount FROM sales";

	it("sql-tsql binds the dialect with zero config", async () => {
		h = await startLspHarness({});
		const uri = h.open("q.sql", TOP, "sql-tsql");
		const d = await h.waitForDiagnostics(uri);
		expect(d.diagnostics).toEqual([]);
	});

	it("plain sql keeps the config path (databricks default rejects TOP)", async () => {
		h = await startLspHarness({});
		const uri = h.open("q.sql", TOP, "sql");
		const d = await h.waitForDiagnostics(uri);
		expect(d.diagnostics.length).toBeGreaterThan(0);
	});

	it("a dialect-carrying language id wins over the project config's dialect", async () => {
		h = await startLspHarness({ ".sqllens.json": JSON.stringify({ default: "tsql" }) });
		// Config says tsql (TOP would be fine); the language id says duckdb — duckdb wins, TOP errors.
		const uri = h.open("q.sql", TOP, "sql-duckdb");
		const d = await h.waitForDiagnosticsWhere(uri, (p) => p.diagnostics.length > 0);
		expect(d.diagnostics.length).toBeGreaterThan(0);
	});
});
