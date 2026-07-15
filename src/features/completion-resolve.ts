import { MarkupKind } from "vscode-languageserver-types";
import type { CompletionItem } from "vscode-languageserver-types";
import { lookupFnDoc, lookupSignature, renderSignature, type FnSignature } from "sqllens";
import type { CompletionItemData } from "./completion.js";

// ---------------------------------------------------------------------------
// completionItem/resolve: the lazy second half of completion. The list handler
// (computeCompletion) emits bare items with a `data` payload but no expensive
// detail; the editor calls resolve only for the item it focuses, and we fill the
// function signature THEN — never for the whole list. resolve receives ONLY the
// item, so everything the lookup needs (kind, label, dialect) rides in `data`.
// Pure translation over the public SIGNATURES table (sqllens 1.2: a name maps
// to an ordered overload SET); never throws.
// ---------------------------------------------------------------------------

/** How many overloads the documentation fence shows before eliding the tail. */
const MAX_OVERLOADS = 8;

/** Resolve one CompletionItem: a known function gains its first overload in `detail`, and
 *  `documentation` becomes real docs (sqllens 1.3 FN_DOCS): the harvested one-line description,
 *  the overload fence ONLY when there is more than one shape (detail already shows a single
 *  one — repeating it read as a bug), and the vendor docs link. Every other item is returned
 *  unchanged. Total — never throws. */
export function resolveCompletion(item: CompletionItem): CompletionItem {
	const data = item.data as CompletionItemData | undefined;
	if (!data || data.kind !== "function") return item;

	const lower = data.label.toLowerCase();
	const sigs = lookupSignature(data.dialect, lower);
	if (!sigs || sigs.length === 0) return item; // no curated or harvested signature — leave as-is.

	item.detail = renderSignature(sigs[0]);
	const doc = lookupFnDoc(data.dialect, lower);
	const parts: string[] = [];
	if (doc?.description) parts.push(doc.description);
	if (sigs.length > 1) parts.push("```sql\n" + renderOverloads(sigs) + "\n```");
	if (doc?.docUrl) parts.push(`[${data.dialect} docs](${doc.docUrl})`);
	if (parts.length > 0) item.documentation = { kind: MarkupKind.Markdown, value: parts.join("\n\n") };
	return item;
}

/** The overload set as one fence body, one rendered signature per line (sqllens's canonical
 *  vendor-notation renderer — optional params bracketed, variadic marked), elided past the cap. */
export function renderOverloads(sigs: readonly FnSignature[]): string {
	const shown = sigs.slice(0, MAX_OVERLOADS).map((s) => renderSignature(s));
	if (sigs.length > shown.length) shown.push(`-- and ${sigs.length - shown.length} more overload(s)`);
	return shown.join("\n");
}
