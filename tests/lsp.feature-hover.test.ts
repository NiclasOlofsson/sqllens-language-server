import { describe, it, expect } from "vitest";
import { Schema } from "sqllens";
import { SqlSession } from "sqllens";
import { computeHover } from "../src/features/hover.js";

const session = (sql: string, schema?: Schema) => SqlSession.create(sql, "databricks", { schema });

describe("computeHover", () => {
	it("shows the inferred type of a column with a schema", () => {
		const sql = "SELECT amount FROM sales";
		const schema = new Schema({ sales: { amount: "decimal" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.indexOf("amount") });
		expect(h).not.toBeNull();
		const value =
			typeof h!.contents === "object" && "value" in h!.contents
				? (h!.contents as any).value
				: String(h!.contents);
		expect(value).toMatch(/decimal/);
	});

	it("returns null when there is no expression under the cursor", () => {
		const sql = "SELECT amount FROM sales";
		expect(computeHover(session(sql), { line: 0, character: sql.indexOf("FROM") })).toBeNull();
	});

	it("table hover is a card with the catalog column list", () => {
		const sql = "SELECT amount FROM sales";
		const schema = new Schema({ sales: { id: "bigint", amount: "decimal" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.indexOf("sales") }, { schema });
		const v = (h!.contents as { value: string }).value;
		expect(v).toContain("`sales`");
		expect(v).toContain("— table");
		expect(v).toContain("**Columns**");
		expect(v).toContain("`id` · bigint");
		expect(v).toContain("`amount` · decimal");
		expect(v).not.toContain("$("); // icons are opt-in; default is plain markdown
	});

	it("alias hover resolves its target and lists the target's columns", () => {
		const sql = "SELECT s.amount FROM sales AS s";
		const schema = new Schema({ sales: { amount: "decimal" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.lastIndexOf("s") }, { schema });
		const v = (h!.contents as { value: string }).value;
		expect(v).toContain("alias for `sales`");
		expect(v).toContain("`amount` · decimal");
	});

	// Lineage regression pins (user report 2026-07-14 claimed missing lineage on unaliased
	// columns; a 30-shape matrix showed every SELECT form works — these lock that in).
	it("bare column with an unaliased table carries the base-table lineage line", () => {
		const sql = "SELECT amount FROM sales";
		const schema = new Schema({ sales: { amount: "decimal" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.indexOf("amount") }, { schema });
		const v = (h!.contents as { value: string }).value;
		expect(v).toContain("— column of `sales`");
		expect(v).toContain("from `sales.amount`");
	});

	it("table-qualified column (the no-alias qualification) carries lineage", () => {
		const sql = "SELECT sales.amount FROM sales";
		const schema = new Schema({ sales: { amount: "decimal" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.indexOf("amount") }, { schema });
		expect((h!.contents as { value: string }).value).toContain("from `sales.amount`");
	});

	it("lineage traces through a CTE to the base table", () => {
		const sql = "WITH c AS (SELECT amount FROM sales) SELECT amount FROM c";
		const schema = new Schema({ sales: { amount: "decimal" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.lastIndexOf("amount") }, { schema });
		expect((h!.contents as { value: string }).value).toContain("from `sales.amount`");
	});

	it("WHERE-clause column carries lineage", () => {
		const sql = "SELECT amount FROM sales WHERE region = 'x'";
		const schema = new Schema({ sales: { amount: "decimal", region: "varchar" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.indexOf("region") }, { schema });
		expect((h!.contents as { value: string }).value).toContain("from `sales.region`");
	});

	// KNOWN GAP, upstream: sqllens deriveSymbols() returns no symbols for UPDATE/DELETE
	// (and models INSERT VALUES as synthetic col1/col2), so DML columns hover without a
	// card or lineage. This sentinel FAILS THE SUITE the day sqllens adds DML symbols —
	// then flip it into a real assertion. Tracked in the sqllens repo.
	it.fails("(sentinel) UPDATE SET column hover has a column card once sqllens models DML", () => {
		const sql = "UPDATE sales SET amount = 1 WHERE region = 'x'";
		const schema = new Schema({ sales: { amount: "decimal", region: "varchar" } });
		const h = computeHover(session(sql, schema), { line: 0, character: sql.indexOf("amount") }, { schema });
		expect((h?.contents as { value: string } | undefined)?.value ?? "").toContain("— column");
	});

	it("function hover carries the harvested description and the vendor docs link (sqllens 1.3)", () => {
		const sql = "SELECT upper(region) FROM sales";
		const s = SqlSession.create(sql, "duckdb");
		const h = computeHover(s, { line: 0, character: sql.indexOf("upper") });
		const v = (h!.contents as { value: string }).value;
		expect(v).toContain("— function");
		expect(v).toContain("Converts `string` to upper case.");
		expect(v).toContain("](https://duckdb.org/");
	});

	it("falls back to symbol kind + name when no type is inferable (no schema)", () => {
		const sql = "WITH c AS (SELECT 1 AS x) SELECT x FROM c";
		const s = SqlSession.create(sql, "databricks");
		const h = computeHover(s, { line: 0, character: sql.indexOf("FROM c") + 5 });
		expect(h).not.toBeNull();
		const v = (h!.contents as { value: string }).value;
		expect(v).toContain("`c`");
		expect(v).toContain("— CTE");
		// the CTE card lists its derived output columns
		expect(v).toContain("**Columns**");
		expect(v).toContain("`x`");
	});
});
