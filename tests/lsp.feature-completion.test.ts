import { describe, it, expect } from "vitest";
import { CompletionItemKind } from "vscode-languageserver-types";
import { Schema, SqlSession } from "sqllens";
import { computeCompletion } from "../src/features/completion.js";

// Completion slot coverage: the FROM/JOIN/qualified-path slots and the caret's replace
// range. The CTE and qualified-path cases were it.fails sentinels for gaps sqllens was
// reworking (announced on the sqllens-lsp vault channel, 2026-07-15); sqllens 1.5.0
// answered both, so they are real assertions now and pin the kind mapping the engine's
// new "cte"/"namespace" candidates land on. One sentinel remains for backtick-delimited
// prefixes (sqllens 1.6 pruning), and the DML hover sentinel still stands in its own file.

const flat = new Schema({ sales: { amount: "decimal" }, customers: { id: "bigint" } });
const nested = new Schema({ analytics: { sales: { amount: "decimal" } }, raw: { events: { id: "bigint" } } });
const deep = new Schema({ prod: { gold: { orders: { id: "bigint" } }, silver: { orders: { id: "bigint" } } } });

const items = (sql: string, schema: Schema, at = sql.length) => {
	const session = SqlSession.create(sql, "databricks", { schema });
	return computeCompletion(session, { line: 0, character: at });
};
const labels = (sql: string, schema: Schema, at = sql.length) => items(sql, schema, at).map((i) => i.label);

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

	it("FROM slot offers in-scope CTE names, marked apart from catalog tables", () => {
		const got = items("WITH recent AS (SELECT 1 AS x) SELECT x FROM ", flat);
		const cte = got.find((i) => i.label === "recent");
		expect(cte).toBeDefined();
		// A CTE is a query-local relation, so it must NOT read as a catalog table (Class) in the
		// list — the outline gives CTEs the Variable kind and completion follows it.
		expect(cte?.kind).toBe(CompletionItemKind.Variable);
	});

	it("a CTE shadowing a catalog table ranks ahead of it", () => {
		// Both are named `sales`; the CTE is what the query would actually bind, so offering the
		// table first would put the wrong one under the caret on the first keystroke.
		const relations = items("WITH sales AS (SELECT 1 AS x) SELECT x FROM ", flat).filter(
			(i) => i.kind === CompletionItemKind.Variable || i.kind === CompletionItemKind.Class,
		);
		expect(relations[0]).toMatchObject({ label: "sales", kind: CompletionItemKind.Variable });
	});

	it("qualified path offers the schema's member tables", () => {
		const got = labels("SELECT amount FROM analytics.", nested);
		expect(got).toContain("sales");
		expect(got).not.toContain("events"); // the other schema's table stays out
	});

	it("an intermediate path segment offers the next segment only, never the full path", () => {
		// LSP clients replace the token at the caret, so a full-path label ("prod.gold") would
		// insert as "prod.prod.gold" — the segment is the only correct label here.
		const got = items("SELECT id FROM prod.", deep);
		expect(got.map((i) => i.label)).toEqual(["gold", "silver"]);
		expect(got.every((i) => i.kind === CompletionItemKind.Module)).toBe(true);
	});
});

describe("completion replace range", () => {
	it("a partially typed name carries the engine's replace range as the item's textEdit", () => {
		// Without the edit range the client guesses a word range of its own; the point of taking
		// sqllens's (1.6) is that it is delimiter-aware, so the guess never strands a quote.
		const [item] = items("SELECT amount FROM sal", flat);
		expect(item.label).toBe("sales");
		expect(item.textEdit).toEqual({
			range: { start: { line: 0, character: 19 }, end: { line: 0, character: 22 } },
			newText: "sales",
		});
	});

	it("an empty-prefix caret leaves items without a textEdit", () => {
		// Nothing typed means nothing to replace; an insert-at-caret item is what the client wants.
		expect(items("SELECT amount FROM ", flat).every((i) => i.textEdit === undefined)).toBe(true);
	});

	it("the replace range survives a caret on a later line", () => {
		const sql = "SELECT amount\nFROM sal";
		const session = SqlSession.create(sql, "databricks", { schema: flat });
		const [item] = computeCompletion(session, { line: 1, character: 8 });
		expect(item.textEdit).toMatchObject({
			range: { start: { line: 1, character: 5 }, end: { line: 1, character: 8 } },
		});
	});

	// KNOWN GAP (sqllens 1.6 prefix pruning, reported on the vault channel 2026-07-30): a caret
	// inside a BACKTICK-quoted identifier prunes every candidate away, so a databricks/mysql user
	// typing `sal gets an empty list where the double-quote dialects answer normally. Flips this
	// suite red the release the engine starts matching backticked prefixes.
	it.fails("(sentinel) a backtick-quoted prefix still offers the matching table", () => {
		expect(labels("SELECT amount FROM `sal", flat)).toContain("sales");
	});
});
