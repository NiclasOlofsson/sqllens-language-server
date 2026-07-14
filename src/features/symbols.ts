import { type DocumentSymbol, type Range, SymbolKind } from "vscode-languageserver-types";
import { formatType, type Sym, type SqlSession } from "sqllens";
import { rangeFromSpan } from "../ranges.js";

// ---------------------------------------------------------------------------
// Document symbols: the outline, in dbt Anvil's structure so the two products
// read identically: each CTE is a Variable-kind symbol with its output columns
// as Field children, and the final query is a Class-kind symbol named after the
// file (Anvil: the model), holding the final output columns. Improvement over
// Anvil's constant 'column' detail: columns carry their inferred type when the
// analysis knows it. Aliases and bare references stay out of the outline.
//
// Meta: Claude Code's LSP tool speaks this method (documentSymbol); no workspaceSymbol here — single-document.
// ---------------------------------------------------------------------------

const FRAME_KIND: Record<string, SymbolKind> = {
	cte: SymbolKind.Variable, // Anvil: SqlSymbolKind.cte
	subquery: SymbolKind.Namespace,
	lateral: SymbolKind.Namespace,
};

/** The union of a parent's own range and its children's — VS Code requires children
 *  to be contained in the parent range, and a declaration's span covers only its name. */
function containAll(own: Range, children: DocumentSymbol[]): Range {
	let { start, end } = own;
	for (const c of children) {
		if (
			c.range.start.line < start.line ||
			(c.range.start.line === start.line && c.range.start.character < start.character)
		)
			start = c.range.start;
		if (c.range.end.line > end.line || (c.range.end.line === end.line && c.range.end.character > end.character))
			end = c.range.end;
	}
	return { start, end };
}

function columnSymbol(s: Sym): DocumentSymbol {
	const range = rangeFromSpan(s.span);
	const typed = s.type && s.type.kind !== "unknown" ? formatType(s.type) : undefined;
	return { name: s.name, kind: SymbolKind.Field, range, selectionRange: range, detail: typed ?? "column" };
}

export function computeDocumentSymbols(session: SqlSession, uri?: string): DocumentSymbol[] {
	const syms = session.deriveSymbols();
	const outputsByFrame = new Map<string, Sym[]>();
	for (const s of syms) {
		if (s.kind !== "column" || !s.modifiers.includes("output")) continue;
		const list = outputsByFrame.get(s.frame) ?? [];
		list.push(s);
		outputsByFrame.set(s.frame, list);
	}

	const out: DocumentSymbol[] = [];
	for (const s of syms) {
		if (!s.modifiers.includes("declaration")) continue;
		const kind = FRAME_KIND[s.kind];
		if (kind === undefined) continue; // tables, aliases, functions: not outline groups
		const children = (outputsByFrame.get(s.name) ?? []).map(columnSymbol);
		const own = rangeFromSpan(s.span);
		out.push({
			name: s.name,
			kind,
			detail: s.kind === "cte" ? "CTE" : s.kind,
			range: containAll(own, children),
			selectionRange: own,
			children,
		});
	}

	// The final query: main-frame outputs grouped under a Class symbol named after
	// the file — Anvil's "model" framing; falls back to "query" without a uri.
	const finals = (outputsByFrame.get("_main_") ?? []).map(columnSymbol);
	if (finals.length > 0) {
		const stem = uri
			?.split(/[\\/]/)
			.pop()
			?.replace(/\.[^.]*$/, "");
		const own = finals[0].range;
		out.push({
			name: stem || "query",
			kind: SymbolKind.Class,
			detail: "final query",
			range: containAll(own, finals),
			selectionRange: finals[0].selectionRange,
			children: finals,
		});
	}
	return out;
}
