import { describe, it, expect } from "vitest";
import { resolveCompletion } from "../src/features/completion-resolve.js";

// resolve is total over just the item (no session): everything it needs rides in `data`.
const fnItem = (label: string, dialect: string) => ({
	label,
	data: { kind: "function" as const, label, dialect },
});

describe("resolveCompletion", () => {
	it("detail carries sqllens's canonical vendor notation (optional params bracketed)", () => {
		// databricks aes_decrypt: expr, key, then three optional params — the notation the
		// harvest originally mined must round-trip back out (sqllens 1.3 renderSignature).
		const resolved = resolveCompletion(fnItem("aes_decrypt", "databricks") as never);
		expect(resolved.detail).toContain("aes_decrypt(expr, key");
		expect(resolved.detail).toContain("[, mode");
	});

	it("documentation fence lists each overload on its own line", () => {
		const resolved = resolveCompletion(fnItem("date_add", "databricks") as never);
		const doc = (resolved.documentation as { value: string }).value;
		expect(doc.split("\n").filter((l) => l.startsWith("date_add(")).length).toBeGreaterThanOrEqual(2);
	});

	it("an unknown function is returned unchanged", () => {
		const item = fnItem("definitely_not_a_function_xyz", "databricks");
		const resolved = resolveCompletion(item as never);
		expect(resolved.detail).toBeUndefined();
		expect(resolved.documentation).toBeUndefined();
	});
});
