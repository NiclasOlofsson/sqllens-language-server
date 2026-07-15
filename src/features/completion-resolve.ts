import { MarkupKind } from "vscode-languageserver-types";
import type { CompletionItem } from "vscode-languageserver-types";
import { lookupSignature, renderSignature, type FnSignature } from "sqllens";
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

/** Resolve one CompletionItem: a known function gains its first overload in `detail` and the
 *  overload set (capped) in a Markdown `documentation` fence; every other item is returned
 *  unchanged. Total — never throws. */
export function resolveCompletion(item: CompletionItem): CompletionItem {
	const data = item.data as CompletionItemData | undefined;
	if (!data || data.kind !== "function") return item;

	const sigs = lookupSignature(data.dialect, data.label.toLowerCase());
	if (!sigs || sigs.length === 0) return item; // no curated or harvested signature — leave as-is.

	item.detail = renderSignature(sigs[0]);
	item.documentation = { kind: MarkupKind.Markdown, value: "```sql\n" + renderOverloads(sigs) + "\n```" };
	return item;
}

/** The overload set as one fence body, one rendered signature per line (sqllens's canonical
 *  vendor-notation renderer — optional params bracketed, variadic marked), elided past the cap. */
export function renderOverloads(sigs: readonly FnSignature[]): string {
	const shown = sigs.slice(0, MAX_OVERLOADS).map((s) => renderSignature(s));
	if (sigs.length > shown.length) shown.push(`-- and ${sigs.length - shown.length} more overload(s)`);
	return shown.join("\n");
}
