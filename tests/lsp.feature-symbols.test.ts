import { describe, it, expect } from "vitest";
import { SqlSession } from "sqllens";
import { computeDocumentSymbols } from "../src/features/symbols.js";
import { Schema } from "sqllens";
import type { DocumentSymbol } from "vscode-languageserver-types";

const session = (sql: string) => SqlSession.create(sql, "databricks");

const flatten = (syms: DocumentSymbol[]): DocumentSymbol[] =>
	syms.flatMap((s) => [s, ...flatten(s.children ?? [])]);

describe("computeDocumentSymbols", () => {
	it("lists a CTE as a group with its output columns as children (Anvil structure)", () => {
		const sql = "WITH recent AS (SELECT id AS rid FROM sales) SELECT rid FROM recent";
		const syms = computeDocumentSymbols(session(sql), "file:///x/orders.sql");
		const recent = syms.find((s) => s.name === "recent");
		expect(recent).toBeDefined();
		expect(recent!.detail).toBe("CTE");
		expect(recent!.children?.some((c) => c.name === "rid")).toBe(true);
		// children must be contained in the parent range (VS Code drops them otherwise)
		expect(recent!.range.end.character).toBeGreaterThan(recent!.selectionRange.end.character);
	});

	it("groups the final query's outputs under a Class symbol named after the file", () => {
		const sql = "SELECT amount AS amount_out FROM sales";
		const syms = computeDocumentSymbols(session(sql), "file:///models/revenue.sql");
		const query = syms.find((s) => s.detail === "final query");
		expect(query?.name).toBe("revenue");
		expect(query?.children?.some((c) => c.name === "amount_out")).toBe(true);
	});

	it("returns an array (possibly empty) and never throws on valid SQL", () => {
		expect(Array.isArray(computeDocumentSymbols(session("SELECT 1")))).toBe(true);
	});

	it("carries inferred types in the outline detail when given a schema", () => {
		// A bare `SELECT amount` is a reference, not an output declaration (see
		// symbols.test.ts "emits a bare projected column as a single reference") — the
		// outline only carries declared/output columns, so alias it to exercise that path.
		const schema = new Schema({ sales: { amount: "decimal" } });
		const withAlias = SqlSession.create("SELECT amount AS amount_out FROM sales", "databricks", { schema });
		const amount = flatten(computeDocumentSymbols(withAlias)).find((s) => s.name === "amount_out");
		expect(amount?.detail).toContain("decimal");
	});
});
