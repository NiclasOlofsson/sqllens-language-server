import { MarkupKind } from "vscode-languageserver-types";
import type { CompletionItem } from "vscode-languageserver-types";
import { lookupSignature, type FnSignature, type ParamSig } from "sqllens";
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

/** The overload set as one fence body, one rendered signature per line, elided past the cap. */
export function renderOverloads(sigs: readonly FnSignature[]): string {
	const shown = sigs.slice(0, MAX_OVERLOADS).map(renderSignature);
	if (sigs.length > shown.length) shown.push(`-- and ${sigs.length - shown.length} more overload(s)`);
	return shown.join("\n");
}

/** `name(p1: t1, p2: t2)`; a variadic signature marks its repeating last param with a trailing `…`.
 *  Shared with the hover card's function section. */
export function renderSignature(sig: FnSignature): string {
	const parts = sig.params.map(paramLabel);
	const rendered =
		sig.variadic && parts.length > 0 ? [...parts.slice(0, -1), `${parts[parts.length - 1]}, …`] : parts;
	return `${sig.name}(${rendered.join(", ")})`;
}

/** One param's display string: `name: type` when typed, else just `name`. */
function paramLabel(p: ParamSig): string {
	return p.type ? `${p.name}: ${p.type}` : p.name;
}
