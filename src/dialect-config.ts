// src/dialect-config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { Schema, resolveDialect, type Dialect, type SchemaMapping } from "sqllens";

// ---------------------------------------------------------------------------
// Dialect resolution: a document's dialect is configured, never guessed. Reads
// <root>/.sqllens.json — ordered glob rules, first match wins, else `default`.
// A rule's `dialect` value is resolved through the library's derived-dialect map,
// so it accepts a dialect name OR an engine name (`athena` → trino, `fabric` →
// tsql, …). An optional `schema` key points at a JSON catalog (a SchemaMapping)
// used by the semantic-diagnostics and hover tiers. A missing/malformed config
// falls back to the "databricks" default and records a warning (surfaced over
// window/logMessage by the server) — loading never throws.
//
// Config problems additionally surface as ConfigIssues: positioned (raw-text
// offsets) so the server can publish real diagnostics ON the config file and
// serve quickfix code actions (unknown dialect → replace with a valid one).
// A missing config file is NOT an issue — zero-config is a supported state.
// ---------------------------------------------------------------------------

/** The primary dialect names offered as quickfixes (the `Dialect` union at runtime). */
export const PRIMARY_DIALECTS: readonly Dialect[] = [
	"databricks",
	"tsql",
	"snowflake",
	"bigquery",
	"redshift",
	"postgres",
	"duckdb",
	"trino",
	"sqlite",
	"mysql",
];

/** A positioned, machine-actionable config problem (offsets into the config raw text). */
export interface ConfigIssue {
	message: string;
	/** Raw-text offset span of the offending value (including quotes); 0/0 when not locatable. */
	start: number;
	end: number;
	/** "unknown-dialect" issues carry the bad value and are quickfixable. */
	kind: "unknown-dialect" | "other";
	badValue?: string;
}

interface Rule {
	files: string;
	dialect: Dialect;
}

export interface DialectConfig {
	/** The dialect for a workspace-relative path (POSIX-style), first matching rule then default. */
	dialectFor(relPath: string): Dialect;
	/** The catalog from the `schema` key, if present and valid. */
	schema?: Schema;
	/** Non-fatal problems (missing/malformed config, unknown dialect, bad schema) for logMessage. */
	warnings: string[];
	/** Positioned problems for diagnostics on the config file itself (missing file excluded). */
	issues: ConfigIssue[];
	/** The config raw text the issues' offsets refer to (undefined when no config exists). */
	raw?: string;
}

/** Locate the span of the quoted `value` in `raw`, searching from `from`; 0/0 when absent. */
function spanOf(raw: string, value: string, from = 0): { start: number; end: number } {
	const needle = `"${value}"`;
	const idx = raw.indexOf(needle, from);
	return idx === -1 ? { start: 0, end: 0 } : { start: idx, end: idx + needle.length };
}

/**
 * Load `<root>/.sqllens.json`. Never throws. `configText` overrides the on-disk
 * content (the server passes the open editor buffer so validation is live);
 * the `schema` file is always read from disk.
 */
export function loadDialectConfig(rootDir: string, configText?: string): DialectConfig {
	const warnings: string[] = [];
	const issues: ConfigIssue[] = [];
	const rules: Rule[] = [];
	let fallback: Dialect = "databricks";
	let schema: Schema | undefined;

	let raw: string | undefined = configText;
	if (raw === undefined) {
		try {
			raw = readFileSync(join(rootDir, ".sqllens.json"), "utf8");
		} catch {
			warnings.push("No .sqllens.json found; defaulting all files to the databricks dialect.");
		}
	}

	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw) as {
				dialects?: { files: string; dialect: string }[];
				default?: string;
				schema?: string;
			};
			let searchFrom = 0;
			for (const r of parsed.dialects ?? []) {
				const dialect = resolveDialect(r.dialect);
				if (dialect === undefined) {
					const span = spanOf(raw, r.dialect, searchFrom);
					searchFrom = span.end;
					warnings.push(
						`Unknown dialect "${r.dialect}" in .sqllens.json rule for "${r.files}"; rule ignored.`,
					);
					issues.push({
						message: `Unknown dialect "${r.dialect}" (rule for "${r.files}" is ignored).`,
						...span,
						kind: "unknown-dialect",
						badValue: r.dialect,
					});
					continue;
				}
				rules.push({ files: r.files, dialect });
			}
			if (parsed.default !== undefined) {
				const dialect = resolveDialect(parsed.default);
				if (dialect !== undefined) fallback = dialect;
				else {
					warnings.push(`Unknown default dialect "${parsed.default}" in .sqllens.json; using databricks.`);
					issues.push({
						message: `Unknown default dialect "${parsed.default}"; falling back to databricks.`,
						...spanOf(raw, parsed.default, raw.indexOf('"default"')),
						kind: "unknown-dialect",
						badValue: parsed.default,
					});
				}
			}
			if (parsed.schema !== undefined) {
				try {
					const mapping = JSON.parse(readFileSync(join(rootDir, parsed.schema), "utf8")) as SchemaMapping;
					schema = new Schema(mapping);
				} catch {
					warnings.push(`Could not read schema file "${parsed.schema}" referenced by .sqllens.json.`);
					issues.push({
						message: `Could not read schema file "${parsed.schema}".`,
						...spanOf(raw, parsed.schema, raw.indexOf('"schema"')),
						kind: "other",
					});
				}
			}
		} catch {
			warnings.push(".sqllens.json is not valid JSON; defaulting all files to the databricks dialect.");
			issues.push({
				message: ".sqllens.json is not valid JSON; all files fall back to the databricks dialect.",
				start: 0,
				end: 0,
				kind: "other",
			});
		}
	}

	const dialectFor = (relPath: string): Dialect => {
		const posix = relPath.replace(/\\/g, "/");
		for (const rule of rules) if (minimatch(posix, rule.files)) return rule.dialect;
		return fallback;
	};

	return { dialectFor, schema, warnings, issues, raw };
}

/** Levenshtein distance — ranks quickfix dialect candidates by closeness to the bad value. */
export function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const row = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[n];
}
