import { describe, it, expect } from "vitest";
import { SqlSession } from "sqllens";
import { computeSignatureHelp } from "../src/features/signature.js";

describe("computeSignatureHelp", () => {
	it("each signature carries the harvested one-line description as documentation (sqllens 1.3)", () => {
		const sql = "select round(amount, ";
		const session = SqlSession.create(sql, "duckdb");
		const help = computeSignatureHelp(session, { line: 0, character: sql.length });
		expect(help).not.toBeNull();
		expect(help!.signatures[0].label).toContain("round(");
		expect(String(help!.signatures[0].documentation ?? "")).toContain("Round to");
	});
});
