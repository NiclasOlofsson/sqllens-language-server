import { CompletionItemKind } from "vscode-languageserver-types";
import type { CompletionItem, Position, Range } from "vscode-languageserver-types";
import { type Completion, type Dialect, type SqlSession } from "sqllens";

// ---------------------------------------------------------------------------
// Completion: the interactive editor feature that lives in the BROKEN-input
// world (the user is mid-keystroke). It maps the cached document's caret offset
// to the session's `completeAt()` candidates — keywords, schema tables, scope
// columns, function names — and turns each into an LSP CompletionItem. Pure
// translation: positions in (line/character), items out. completeAt() never
// throws, so neither does this.
// ---------------------------------------------------------------------------

// Our coarse completion kind → the standard LSP CompletionItemKind.
const KIND: Record<Completion["kind"], CompletionItemKind> = {
	keyword: CompletionItemKind.Keyword,
	column: CompletionItemKind.Field,
	table: CompletionItemKind.Class,
	function: CompletionItemKind.Function,
	// An in-scope CTE in a relation slot (sqllens 1.5): a query-local relation, so it gets the
	// Variable icon the outline already gives CTEs (symbols.ts FRAME_KIND) — visibly apart from
	// the catalog tables it is ranked ahead of.
	cte: CompletionItemKind.Variable,
	// One segment of a qualified path (sqllens 1.5): `analytics` in `analytics.sales`.
	namespace: CompletionItemKind.Module,
	// Templated candidates (ref()/source()-style, sqllens 1.2): rendered text, not a plain symbol.
	template: CompletionItemKind.Snippet,
};

export function computeCompletion(session: SqlSession, position: Position): CompletionItem[] {
	const off = session.doc.lines.offsetAt(position.line, position.character);
	const items = session.completeAt(off);
	// The span of the partial word the engine pruned against (sqllens 1.6), present only when
	// something is already typed. Handing it back as each item's textEdit range is what makes
	// delimited identifiers work: a caret inside `"my_t` or `` `my_t `` has an opening quote in
	// the span, which the client's own word-range guess would leave stranded before the insert.
	const replace = rangeOf(session, items.replaceRange);
	return items.map((c) => {
		const item: CompletionItem = { label: c.label, kind: KIND[c.kind] };
		if (c.detail !== undefined) item.detail = c.detail;
		if (replace) item.textEdit = { range: replace, newText: c.label };
		// Everything completionItem/resolve needs, since resolve receives ONLY the item (no
		// doc/position): the kind, the label, and the document's dialect for the signature lookup.
		item.data = { kind: c.kind, label: c.label, dialect: session.dialect } satisfies CompletionItemData;
		return item;
	});
}

/** A sqllens ReplaceRange (char offsets into the document) → LSP Range; undefined stays undefined,
 *  which leaves the item without a textEdit and the client back on its own word-range guess. */
function rangeOf(session: SqlSession, replaceRange: { start: number; end: number } | undefined): Range | undefined {
	if (!replaceRange) return undefined;
	const start = session.doc.lines.positionAt(replaceRange.start);
	const end = session.doc.lines.positionAt(replaceRange.end);
	return {
		start: { line: start.line, character: start.column },
		end: { line: end.line, character: end.column },
	};
}

/** The `data` payload carried on each CompletionItem so completionItem/resolve — which gets only the
 *  item — can fill a function's signature lazily. */
export interface CompletionItemData {
	kind: Completion["kind"];
	label: string;
	dialect: Dialect;
}
