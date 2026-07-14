import type { Hover, Position } from "vscode-languageserver-types";
import { formatType, lookupSignature, symbolAt, type SchemaProvider, type SqlSession, type Sym } from "sqllens";
import { cellBaseAt, rangeFromCst, rangeFromSpan, shiftRange } from "../ranges.js";
import { renderSignature } from "./completion-resolve.js";

// ---------------------------------------------------------------------------
// Hover: an Anvil-style markdown card, filled with what static analysis knows.
// The card leads with the inferred TYPE of the expression under the cursor
// (with provable nullability) — the part the catalog can't tell you — then
// describes the symbol: tables and aliases get their column lists from the
// schema catalog, CTEs get their derived output columns, columns get their
// binding and base-table lineage. Sections are separated by `---` rules,
// matching dbt Anvil's hover template (the two products should feel related).
//
// `icons` gates $(codicon) theme icons: our VS Code client opts in via
// initializationOptions and renders them through a hover middleware; every
// other client gets clean plain markdown.
//
// Meta: Claude Code's LSP tool speaks this method (hover).
// ---------------------------------------------------------------------------

export interface HoverOptions {
	/** The active catalog — feeds the column lists on table/alias cards. */
	schema?: SchemaProvider;
	/** Emit $(codicon) icons (clients that opt in via initializationOptions.themeIcons). */
	icons?: boolean;
}

// Same codicon vocabulary as dbt Anvil's SqlIcons, for cross-product familiarity.
const ICONS: Record<string, string> = {
	table: "symbol-class",
	cte: "symbol-variable",
	alias: "symbol-reference",
	column: "symbol-field",
	function: "symbol-function",
	subquery: "symbol-object",
	lateral: "symbol-object",
	lineage: "arrow-right",
};

const MAX_COLUMNS = 30;

export function computeHover(session: SqlSession, position: Position, opts: HoverOptions = {}): Hover | null {
	const off = session.doc.lines.offsetAt(position.line, position.character);
	const icon = (kind: string): string => (opts.icons ? `$(${ICONS[kind] ?? "symbol-misc"}) ` : "");

	// The typed headline: inference's answer for the expression under the cursor.
	const hit = session.nodeAt(off);
	let headline: string | undefined;
	let range: Hover["range"];
	if (hit) {
		const types = session.types();
		const type = types.typeOf(hit.expr, hit.scope);
		if (type.kind !== "unknown") {
			// hit.expr.cst is CELL-relative (nodeAt routes to the owning cell) — shift to doc coords.
			range = shiftRange(rangeFromCst(hit.expr.cst), cellBaseAt(session.doc, off));
			const nullability = types.nullabilityOf(hit.expr, hit.scope);
			const suffix = nullability === "notnull" ? " — not null" : nullability === "nullable" ? " — nullable" : "";
			headline = formatType(type) + suffix;
		}
	}

	const syms = session.deriveSymbols();
	const sym = symbolAt(syms, off);
	if (!sym) return headline ? { contents: md(fence(headline)), range } : null;

	if (!headline && sym.type && sym.type.kind !== "unknown") headline = formatType(sym.type);

	const sections: string[] = [];
	if (headline) sections.push(fence(headline));

	const columnLines = (cols: { name: string; type?: string }[]): string => {
		const shown = cols.slice(0, MAX_COLUMNS);
		const lines = shown.map((c) => `${icon("column")}\`${c.name}\`${c.type ? ` · ${c.type}` : ""}`);
		if (cols.length > shown.length) lines.push(`… and ${cols.length - shown.length} more`);
		return `**Columns**  \n${lines.join("  \n")}`;
	};
	const cteOutputs = (cteName: string): { name: string; type?: string }[] => {
		const seen = new Set<string>();
		const out: { name: string; type?: string }[] = [];
		for (const s of syms) {
			if (s.kind !== "column" || s.frame !== cteName || !s.modifiers.includes("output")) continue;
			if (seen.has(s.name)) continue;
			seen.add(s.name);
			out.push({ name: s.name, type: s.type && s.type.kind !== "unknown" ? formatType(s.type) : undefined });
		}
		return out;
	};
	const catalogColumns = (tableName: string): { name: string; type?: string }[] | undefined =>
		opts.schema?.columnsFor(tableName.split("."), session.dialect)?.map((c) => ({ name: c.name, type: c.type }));

	switch (sym.kind) {
		case "table": {
			const alias = sym.alias ? ` · alias \`${sym.alias.name}\`` : "";
			sections.push(`${icon("table")}**\`${sym.name}\`** — table${alias}`);
			const cols = catalogColumns(sym.name);
			if (cols?.length) sections.push(columnLines(cols));
			break;
		}
		case "cte": {
			sections.push(`${icon("cte")}**\`${sym.name}\`** — CTE`);
			const cols = cteOutputs(sym.name);
			if (cols.length) sections.push(columnLines(cols));
			break;
		}
		case "alias": {
			const target = syms.find(
				(s) =>
					(s.kind === "table" || s.kind === "cte" || s.kind === "subquery" || s.kind === "lateral") &&
					s.alias?.name === sym.name &&
					s.frame === sym.frame,
			);
			if (!target) {
				sections.push(`${icon("alias")}**\`${sym.name}\`** — alias`);
				break;
			}
			sections.push(`${icon("alias")}**\`${sym.name}\`** — alias for \`${target.name}\``);
			const cols = target.kind === "table" ? catalogColumns(target.name) : cteOutputs(target.name);
			if (cols?.length) sections.push(columnLines(cols));
			break;
		}
		case "column": {
			const of = sym.source ? ` of \`${sym.source.name}\`` : "";
			sections.push(`${icon("column")}**\`${sym.name}\`** — column${of}`);
			if (sym.origins?.length) {
				const lines = sym.origins.map(
					(o) => `${icon("lineage")}from \`${[...o.table, o.column].join(".")}\``,
				);
				sections.push(lines.join("  \n"));
			}
			break;
		}
		case "function": {
			sections.push(`${icon("function")}**\`${sym.name}\`** — function`);
			const sig = lookupSignature(session.dialect, sym.name.toLowerCase());
			if (sig) sections.push("```sql\n" + renderSignature(sig) + "\n```");
			break;
		}
		default:
			sections.push(`${icon(sym.kind)}**\`${sym.name}\`** — ${sym.kind}`);
	}

	return {
		contents: md(sections.join("\n\n---\n\n")),
		range: range ?? rangeFromSpan(sym.span),
	};
}

function md(value: string): { kind: "markdown"; value: string } {
	return { kind: "markdown", value };
}

function fence(v: string): string {
	return "```\n" + v + "\n```";
}
