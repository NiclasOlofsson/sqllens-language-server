import { describe, it, expect } from "vitest";
import { SqlSession } from "sqllens";
import { computeDefinition } from "../src/features/definition.js";

const session = (sql: string) => SqlSession.create(sql, "databricks");

describe("computeDefinition", () => {
	it("jumps from a CTE reference in FROM to the CTE declaration", () => {
		const sql = "WITH recent AS (SELECT id FROM sales) SELECT id FROM recent";
		const refIdx = sql.lastIndexOf("recent"); // the FROM reference
		const loc = computeDefinition(session(sql), lineCol(sql, refIdx), "file:///q.sql");
		expect(loc).not.toBeNull();
		// definition is the earlier declaration, before the reference
		const defStart = loc!.range.start;
		expect(defStart.line).toBe(0);
		expect(defStart.character).toBeLessThan(refIdx);
	});

	it("jumps from a tsql variable use to its DECLARE", () => {
		// sqllens 1.7 made DECLARE a real declaration, so the generic Sym.definition path already
		// answers here; this pins that a T-SQL script's local variables navigate like CTE names do.
		const sql = "DECLARE @total int = 5;\nSELECT @total + 1 AS bumped;";
		const use = SqlSession.create(sql, "tsql");
		const loc = computeDefinition(use, { line: 1, character: 9 }, "file:///q.sql");
		// The DECLARE's `@total`, sigil included (line 0, after "DECLARE ").
		expect(loc?.range.start).toEqual({ line: 0, character: sql.indexOf("@total") });
	});

	it("returns null for a bare catalog table with no in-query definition", () => {
		const sql = "SELECT id FROM sales";
		const loc = computeDefinition(session(sql), lineCol(sql, sql.indexOf("sales")), "file:///q.sql");
		expect(loc).toBeNull();
	});
});

function lineCol(text: string, offset: number) {
	const before = text.slice(0, offset);
	const line = before.split("\n").length - 1;
	const character = offset - (before.lastIndexOf("\n") + 1);
	return { line, character };
}
