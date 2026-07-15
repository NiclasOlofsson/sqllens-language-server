import { describe, it, expect } from "vitest";
import { Schema, SqlSession } from "sqllens";
import { computeCompletion } from "../src/features/completion.js";

// Completion slot coverage. The suite previously only tested column slots and function
// resolve; these pin the FROM/JOIN/qualified-path slots. Three are SENTINELS (it.fails)
// for gaps sqllens is currently reworking (announced on the sqllens-lsp vault channel,
// 2026-07-15): they flip the suite red the release the engine starts answering, exactly
// like the DML hover sentinel.

const flat = new Schema({ sales: { amount: "decimal" }, customers: { id: "bigint" } });
const nested = new Schema({ analytics: { sales: { amount: "decimal" } }, raw: { events: { id: "bigint" } } });

const labels = (sql: string, schema: Schema, at = sql.length) => {
	const session = SqlSession.create(sql, "databricks", { schema });
	return computeCompletion(session, { line: 0, character: at }).map((i) => i.label);
};

describe("completion slots", () => {
	it("JOIN slot offers the schema tables (works today — regression pin)", () => {
		const got = labels("SELECT amount FROM sales JOIN ", flat);
		expect(got).toContain("sales");
		expect(got).toContain("customers");
	});

	it("FROM slot offers the schema tables (works today — regression pin)", () => {
		const got = labels("SELECT amount FROM ", flat);
		expect(got).toContain("sales");
		expect(got).toContain("customers");
	});

	// KNOWN GAP: CTE names are never offered as relation candidates.
	it.fails("(sentinel) FROM slot offers in-scope CTE names once the engine answers", () => {
		const got = labels("WITH recent AS (SELECT 1 AS x) SELECT x FROM ", flat);
		expect(got).toContain("recent");
	});

	// KNOWN GAP: after a schema qualifier dot, candidates are function noise, not members.
	it.fails("(sentinel) qualified path offers the schema's member tables once the engine answers", () => {
		const got = labels("SELECT amount FROM analytics.", nested);
		expect(got).toContain("sales");
	});
});
