// src/plugin.ts — the PUBLIC plugin authoring contract, importable (types-only)
// as `sqllens-language-server/plugin`.
//
// A plugin is one ES module: `export default function activate(ctx) { ... }`.
// activate returns the providers and hooks the plugin wants plugged in (or
// nothing to decline — how a user-layer plugin skips workspaces it doesn't
// apply to). Providers feed the analysis IN (schema); hooks shape the answers
// OUT (diagnostics, hover, completion, code actions). Every hook is additive
// and crash-isolated: a throwing hook logs once and the server's own answer
// ships untouched.
//
// `export const api = 1` is the compatibility handshake: the server skips a
// plugin whose `api` is newer than PLUGIN_API_VERSION instead of half-loading it.
import type { CodeAction, CompletionItem, Diagnostic, Position, Range } from "vscode-languageserver-types";
import type { Column, SqlSession, Sym } from "sqllens";

/** The plugin API version this server implements (mirror it as `export const api`). */
export const PLUGIN_API_VERSION = 1;

/** What activate(ctx) receives. */
export interface PluginContext {
	/** Absolute workspace root path. */
	workspaceRoot: string;
	/** This plugin's options, deep-merged across config layers (user file under project file). */
	options: Record<string, unknown>;
	/** Log to the client's output channel, tagged with the plugin name. */
	log(message: string): void;
}

/**
 * A live catalog source — the sqllens TableResolver shape. `resolve` must be
 * synchronous and cheap (called during analysis); return undefined for unknown,
 * never guess. `fetch` is called out of band with the accumulated misses; warm
 * the cache `resolve` reads and the server re-analyzes and republishes on its own.
 */
export interface PluginSchemaProvider {
	/** Sync lookup by folded table-name parts (e.g. ["catalog","schema","table"] or shorter). */
	resolve(parts: string[]): Column[] | undefined;
	/** Async batch warm-up for the missed names. Optional — without it, cold names never heal. */
	fetch?(missing: string[][]): Promise<void>;
	/**
	 * What a miss MEANS. "closed" (default): the catalog is complete, an unresolved table is an
	 * unknown-table diagnostic. "open": a miss is "I don't know — do not diagnose". Declare "open"
	 * when your resolver only knows part of the world.
	 */
	world?: "closed" | "open";
}

export interface DiagnosticsHookArgs {
	session: SqlSession;
	uri: string;
	/** The server's computed diagnostics; push more (set `source` to your plugin name) or filter. */
	diagnostics: Diagnostic[];
}

export interface HoverHookArgs {
	session: SqlSession;
	uri: string;
	position: Position;
	/** The resolved symbol under the cursor, when there is one. */
	symbol?: Sym;
	/** The hover's markdown cards; push to append (cards are joined with `---` rules). */
	cards: string[];
}

export interface CompletionHookArgs {
	session: SqlSession;
	uri: string;
	position: Position;
	/** The server's completion items; push to append. */
	items: CompletionItem[];
}

export interface CodeActionsHookArgs {
	session: SqlSession;
	uri: string;
	range: Range;
	/** The diagnostics the client sent for the requested range. */
	diagnostics: Diagnostic[];
	/** The server's actions; push to append. */
	actions: CodeAction[];
}

/** One optional hook per LSP feature. All may be async — hover and completion spend the
 *  user's keystroke budget, so keep those fast. */
export interface PluginHooks {
	diagnostics?(args: DiagnosticsHookArgs): void | Promise<void>;
	hover?(args: HoverHookArgs): void | Promise<void>;
	completion?(args: CompletionHookArgs): void | Promise<void>;
	codeActions?(args: CodeActionsHookArgs): void | Promise<void>;
}

/** What activate returns. Everything optional; return null/undefined to decline activation. */
export interface SqllensPlugin {
	schema?: PluginSchemaProvider;
	hooks?: PluginHooks;
	/** Cleanup (close connections); called on config reload and server shutdown. */
	dispose?(): void | Promise<void>;
}

export type PluginActivate = (
	ctx: PluginContext,
) => SqllensPlugin | null | undefined | Promise<SqllensPlugin | null | undefined>;
