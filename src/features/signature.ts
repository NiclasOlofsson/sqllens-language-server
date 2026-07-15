import type { Position, SignatureHelp } from "vscode-languageserver-types";
import { lookupFnDoc, type SqlSession } from "sqllens";

// ---------------------------------------------------------------------------
// Signature help: the interactive editor feature that shows parameter hints
// while typing inside a call's parentheses. It maps the cached document's caret
// offset to the session's `signatureAt()` result and turns it into an LSP
// SignatureHelp. Since sqllens 1.2 the info carries the full OVERLOAD SET of
// the called name (harvested/authored order) plus the active indexes — the
// shape maps one to one onto LSP. Pure translation: position in, SignatureHelp
// out. signatureAt() never throws and returns null when the caret isn't inside
// a call, so neither does this.
// ---------------------------------------------------------------------------

export function computeSignatureHelp(session: SqlSession, position: Position): SignatureHelp | null {
	const off = session.doc.lines.offsetAt(position.line, position.character);
	const info = session.signatureAt(off);
	if (!info) return null;
	// The called name, recovered from the rendered label (every overload shares it) — keys
	// the FN_DOCS lookup so each signature carries the harvested one-line description.
	const first = info.signatures[0]?.label ?? "";
	const name = first.slice(0, first.indexOf("(")).trim().toLowerCase();
	const description = name ? lookupFnDoc(session.dialect, name)?.description : undefined;
	return {
		signatures: info.signatures.map((s) => ({
			label: s.label,
			parameters: s.parameters.map((p) => ({ label: p.label })),
			...(description ? { documentation: description } : {}),
		})),
		activeSignature: info.activeSignature,
		activeParameter: info.activeParameter,
	};
}
