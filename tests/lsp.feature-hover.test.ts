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
