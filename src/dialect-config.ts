// src/dialect-config.ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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
// LAYERING: a user-level config (default `~/.sqllens.json`, overridable via
// SQLLENS_USER_CONFIG or the userConfigPath argument) merges UNDER the project
// file — the dbt profiles.yml split. Project wins on scalars (default, schema);
// project glob rules match before user rules; `plugins` lists concatenate
// user-first with per-module option deep-merge (user supplies credentials, the
// project overrides what it pins). User-file problems are warnings only —
// positioned ConfigIssues always refer to the PROJECT file's raw text.
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

/** One declared plugin, normalized from a config `plugins` entry (string or {module, options}). */
export interface PluginSpec {
	/** Bare npm package name, or a path starting with "./", "../" (or absolute) relative to baseDir. */
	module: string;
	/** Per-plugin options, deep-merged across layers (project leaf wins). */
	options: Record<string, unknown>;
	/** The directory path-form modules resolve against (the declaring config file's directory). */
	baseDir: string;
	/** Which config file declared it — user plugins load first, project plugins after. */
	layer: "user" | "project";
}

interface Rule {
	files: string;
	dialect: Dialect;
}

export interface DialectConfig {
	/** The dialect for a workspace-relative path (POSIX-style), first matching rule then default. */
	dialectFor(relPath: string): Dialect;
	/** The catalog from the `schema` key, if present and valid (project layer wins). */
	schema?: Schema;
	/** Declared plugins across both layers, user layer first, deduped by module identity. */
	plugins: PluginSpec[];
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

/** The raw JSON shape both config layers share. */
interface RawConfig {
	dialects?: { files: string; dialect: string }[];
	default?: string;
	schema?: string;
	plugins?: unknown[];
}

/** Plain-object deep merge; `over` leaf values win, arrays and scalars replace. */
function deepMerge(under: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...under };
	for (const [k, v] of Object.entries(over)) {
		const prev = out[k];
		out[k] =
			prev !== null &&
			typeof prev === "object" &&
			!Array.isArray(prev) &&
			v !== null &&
			typeof v === "object" &&
			!Array.isArray(v)
				? deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>)
				: v;
	}
	return out;
}

/** Normalize a config `plugins` array; invalid entries warn (prefixed for the user layer) and drop. */
function parsePlugins(
	entries: unknown[],
	baseDir: string,
	layer: "user" | "project",
	warnings: string[],
): PluginSpec[] {
	const specs: PluginSpec[] = [];
	for (const entry of entries) {
		if (typeof entry === "string" && entry.length > 0) {
			specs.push({ module: entry, options: {}, baseDir, layer });
			continue;
		}
		if (entry !== null && typeof entry === "object" && typeof (entry as { module?: unknown }).module === "string") {
			const e = entry as { module: string; options?: unknown };
			const options =
				e.options !== null && typeof e.options === "object" && !Array.isArray(e.options)
					? (e.options as Record<string, unknown>)
					: {};
			specs.push({ module: e.module, options, baseDir, layer });
			continue;
		}
		warnings.push(
			`Invalid ${layer} config plugins entry ${JSON.stringify(entry)}; expected a string or { module, options }.`,
		);
	}
	return specs;
}

/** A plugin's dedupe identity: bare names by name, path modules by their resolved absolute path. */
function pluginKey(spec: PluginSpec): string {
	return /^(\.{1,2}[/\\]|\/|[A-Za-z]:[/\\])/.test(spec.module) ? resolve(spec.baseDir, spec.module) : spec.module;
}

/** The default user-layer config path: $SQLLENS_USER_CONFIG, else ~/.sqllens.json. */
export function defaultUserConfigPath(): string {
	return process.env.SQLLENS_USER_CONFIG ?? join(homedir(), ".sqllens.json");
}

/**
 * The dialect a `sql-<name>` language id encodes, resolved through the library's
 * derived-dialect map (so engine names bind too: `sql-athena` → trino, `sql-fabric` → tsql).
 * undefined for plain "sql" and anything foreign — those keep the config path. A
 * dialect-carrying language id is EXPLICIT per-document configuration (the user or client
 * bound the file to that language), so the server lets it win over the config file's rules.
 */
export function dialectFromLanguageId(languageId: string): Dialect | undefined {
	if (!languageId.startsWith("sql-")) return undefined;
	return resolveDialect(languageId.slice("sql-".length));
}

/**
 * Load `<root>/.sqllens.json` layered over the user config. Never throws.
 * `configText` overrides the on-disk PROJECT content (the server passes the
 * open editor buffer so validation is live); `schema` files are always read
 * from disk. `userConfigPath` defaults to defaultUserConfigPath().
 */
export function loadDialectConfig(rootDir: string, configText?: string, userConfigPath?: string): DialectConfig {
	const warnings: string[] = [];
	const issues: ConfigIssue[] = [];
	const rules: Rule[] = [];
	let fallback: Dialect | undefined;
	let schema: Schema | undefined;

	// --- user layer: warnings only, never positioned issues -----------------
	const userPath = userConfigPath ?? defaultUserConfigPath();
	const userDir = dirname(userPath);
	const userRules: Rule[] = [];
	let userFallback: Dialect | undefined;
	let userSchemaFile: string | undefined;
	let userPlugins: PluginSpec[] = [];
	let userRaw: string | undefined;
	try {
		userRaw = readFileSync(userPath, "utf8");
	} catch {
		/* no user config — zero-config is a supported state */
	}
	if (userRaw !== undefined) {
		try {
			const parsed = JSON.parse(userRaw) as RawConfig;
			for (const r of parsed.dialects ?? []) {
				const dialect = resolveDialect(r.dialect);
				if (dialect === undefined) {
					warnings.push(
						`Unknown dialect "${r.dialect}" in user config ${userPath} (rule for "${r.files}" ignored).`,
					);
					continue;
				}
				userRules.push({ files: r.files, dialect });
			}
			if (parsed.default !== undefined) {
				userFallback = resolveDialect(parsed.default);
				if (userFallback === undefined)
					warnings.push(`Unknown default dialect "${parsed.default}" in user config ${userPath}; ignored.`);
			}
			userSchemaFile = parsed.schema;
			userPlugins = parsePlugins(parsed.plugins ?? [], userDir, "user", warnings);
		} catch {
			warnings.push(`User config ${userPath} is not valid JSON; user layer ignored.`);
		}
	}

	// --- project layer: existing behavior, plus plugins ---------------------
	let projectPlugins: PluginSpec[] = [];
	let projectSchemaFile: string | undefined;
	let raw: string | undefined = configText;
	if (raw === undefined) {
		try {
			raw = readFileSync(join(rootDir, ".sqllens.json"), "utf8");
		} catch {
			if (userRaw === undefined)
				warnings.push("No .sqllens.json found; defaulting all files to the databricks dialect.");
		}
	}

	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw) as RawConfig;
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
			projectSchemaFile = parsed.schema;
			if (projectSchemaFile !== undefined) {
				try {
					const mapping = JSON.parse(readFileSync(join(rootDir, projectSchemaFile), "utf8")) as SchemaMapping;
					schema = new Schema(mapping);
				} catch {
					warnings.push(`Could not read schema file "${projectSchemaFile}" referenced by .sqllens.json.`);
					issues.push({
						message: `Could not read schema file "${projectSchemaFile}".`,
						...spanOf(raw, projectSchemaFile, raw.indexOf('"schema"')),
						kind: "other",
					});
				}
			}
			projectPlugins = parsePlugins(parsed.plugins ?? [], rootDir, "project", warnings);
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

	// --- merge: project wins on scalars; user schema only fills a gap -------
	if (schema === undefined && projectSchemaFile === undefined && userSchemaFile !== undefined) {
		try {
			const mapping = JSON.parse(readFileSync(resolve(userDir, userSchemaFile), "utf8")) as SchemaMapping;
			schema = new Schema(mapping);
		} catch {
			warnings.push(`Could not read schema file "${userSchemaFile}" referenced by user config ${userPath}.`);
		}
	}
	const effectiveFallback: Dialect = fallback ?? userFallback ?? "databricks";
	const mergedRules = [...rules, ...userRules]; // project rules match first

	// Plugins: user layer first (load order), then project — a project re-declaration
	// of the same module folds into ONE spec at the project position, its options
	// deep-merged over the user's (credentials from home, pins from the repo).
	const plugins: PluginSpec[] = [];
	const byKey = new Map<string, PluginSpec>();
	for (const spec of [...userPlugins, ...projectPlugins]) {
		const key = pluginKey(spec);
		const prev = byKey.get(key);
		if (prev === undefined) {
			byKey.set(key, spec);
			plugins.push(spec);
			continue;
		}
		const merged: PluginSpec = { ...spec, options: deepMerge(prev.options, spec.options) };
		plugins.splice(plugins.indexOf(prev), 1);
		plugins.push(merged);
		byKey.set(key, merged);
	}

	const dialectFor = (relPath: string): Dialect => {
		const posix = relPath.replace(/\\/g, "/");
		for (const rule of mergedRules) if (minimatch(posix, rule.files)) return rule.dialect;
		return effectiveFallback;
	};

	return { dialectFor, schema, plugins, warnings, issues, raw };
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
