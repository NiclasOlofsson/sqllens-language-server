import { describe, it, expect } from "vitest";
import { SqlSession } from "sqllens";
import { computeSemanticTokens, SEMANTIC_LEGEND } from "../src/features/semantic-tokens.js";

// The lexer alone can't classify call sites: grammar-reserved names (duckdb/postgres
// COALESCE) lex as keywords while ordinary functions (round, upper) are plain
// identifiers. The symbols overlay must give ordinary call sites the `function`
// token type so all calls highlight alike.
describe("semantic tokens function overlay", () => {
	it("emits the function token type for ordinary call-site identifiers", () => {
		const session = SqlSession.create("select round(amount, 2) from sales", "duckdb");
		const fnType = SEMANTIC_LEGEND.tokenTypes.indexOf("function");
		expect(fnType).toBeGreaterThan(-1);
		const data = computeSemanticTokens(session).data;
		// data is quintuples: [deltaLine, deltaChar, length, type, modifiers]
		const types = [];
		for (let i = 3; i < data.length; i += 5) types.push(data[i]);
		expect(types).toContain(fnType);
	});

	it("keyword-lexed call sites (duckdb coalesce) also emit function, and built-ins carry defaultLibrary", () => {
		const session = SqlSession.create("select coalesce(amount, 1), round(amount, 2) from sales", "duckdb");
		const fnType = SEMANTIC_LEGEND.tokenTypes.indexOf("function");
		const data = computeSemanticTokens(session).data;
		const fns = [];
		for (let i = 0; i < data.length; i += 5) if (data[i + 3] === fnType) fns.push(data[i + 4]);
		// both call sites present as function tokens...
		expect(fns.length).toBe(2);
		// ...and both are dialect built-ins → defaultLibrary bit set
		expect(fns.every((m) => (m & 1) === 1)).toBe(true);
	});
});
