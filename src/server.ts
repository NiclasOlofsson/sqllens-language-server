// src/server.ts
import {
	type CodeAction,
	CodeActionKind,
	type Connection,
	type Diagnostic,
	DiagnosticSeverity,
	type InitializeParams,
	type InitializeResult,
	type Range,
	TextDocuments,
	TextDocumentSyncKind,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import { appendFileSync } from "node:fs";
import { SqlSession, type SchemaProvider } from "sqllens";
import { editDistance, loadDialectConfig, PRIMARY_DIALECTS, type DialectConfig } from "./dialect-config.js";
import { PluginHost, composeSchemas } from "./plugins.js";
import { computeDiagnostics } from "./features/diagnostics.js";
import { computeDocumentDiagnostics } from "./features/pull-diagnostics.js";
import { computeHoverModel, renderHoverModel } from "./features/hover.js";
import { computeDocumentSymbols } from "./features/symbols.js";
import { computeDefinition } from "./features/definition.js";
import {
	computeSemanticTokens,
	computeSemanticTokensRange,
	computeSemanticTokensDelta,
	forgetSemanticTokens,
	SEMANTIC_LEGEND,
} from "./features/semantic-tokens.js";
import { computeCompletion } from "./features/completion.js";
import { resolveCompletion } from "./features/completion-resolve.js";
import { computeSignatureHelp } from "./features/signature.js";
import { computeReferences, computeDocumentHighlight } from "./features/references.js";
import { computeCodeLens } from "./features/code-lens.js";
import { computeFoldingRanges } from "./features/folding.js";
import { computeSelectionRanges } from "./features/selection.js";
import { computeInlayHints } from "./features/inlay-hints.js";

// ---------------------------------------------------------------------------
// The server: connection wiring only. It holds ONE SqlSession per open file,
// rebuilt on open/change and cached in `sessions`, and serves every feature from
// that cached model — no per-request re-parse. SqlSession is the verb-shaped
// facade over one SqlDocument; features reach the document's escape-hatch
// members (LineIndex, cellAt, statements) via `session.doc`. Each document maps
// to its dialect (via .sqllens.json). No analysis lives here; the LSP↔internal
// coordinate conversion stays at this boundary (in ranges.ts / SqlDocument.lines).
// startServer(connection) is shared by the stdio binary (main.ts) and the
// in-memory acceptance suite, so the tested code path IS the shipped one.
//
// EMBEDDING (Task 8): the stdio binary reads a static catalog from .sqllens.json.
// A host that embeds the server can instead hand it a live catalog via
// startServer(connection, { schema }) — any SchemaProvider, typically a
// CallbackSchema whose tables are fetched lazily from a big warehouse, or a
// CallbackTemplateCatalog that ALSO resolves dbt-logical refs. An injected schema
// is the active catalog for every document (it wins over the file schema). When it
// is a resolve-on-demand catalog (either one), publish() drives the lazy-catalog
// re-publish loop.
// ---------------------------------------------------------------------------

/** A resolve-on-demand catalog that records misses and warms them via prime() — the shape shared by
 *  CallbackSchema (physical tables) and CallbackTemplateCatalog (templated refs). The lazy-catalog
 *  re-publish loop duck-types on this so BOTH drive prime()/republish identically: a resolved templated
 *  ref republishes diagnostics on warm exactly like a resolved physical table. */
interface LazyCatalog {
	readonly misses: ReadonlyArray<string[]>;
	prime(): Promise<boolean>;
}

/** True when `s` is a resolve-on-demand catalog (has prime() + misses) — CallbackSchema OR
 *  CallbackTemplateCatalog. Duck-typed so the loop stays catalog-implementation-agnostic. */
function isLazyCatalog(s: SchemaProvider | undefined): s is SchemaProvider & LazyCatalog {
	const c = s as Partial<LazyCatalog> | undefined;
	return !!c && typeof c.prime === "function" && Array.isArray(c.misses);
}

/** Options a host passes when embedding the server (the non-stdio path). */
export interface ServerOptions {
	/** A live catalog the host supplies (the embedding entry point). When present it is the active
	 *  schema for every document, taking precedence over the file-configured `.sqllens.json` schema.
	 *  A CallbackSchema or CallbackTemplateCatalog here enables the lazy-catalog re-publish loop (fetch
	 *  on miss, re-publish when the resolver warms). */
	schema?: SchemaProvider;
	/** Override for the user-layer config file (default: $SQLLENS_USER_CONFIG, else ~/.sqllens.json).
	 *  The test harness points this into its temp workspace so a developer's real user config never
	 *  leaks into the suite; embedding hosts may redirect it likewise. */
	userConfigPath?: string;
}

export function startServer(connection: Connection, options: ServerOptions = {}): void {
	// SQLLENS_TRACE_SYNC=<file>: append one JSON line per didChange showing the raw
	// change-event shape the client sent — {range,...} = incremental patch, {full} =
	// whole-document. Diagnostic aid for verifying client sync compliance; off unless set.
	const tracePath = process.env.SQLLENS_TRACE_SYNC;
	const docsConfig = tracePath
		? {
				create: (uri: string, languageId: string, version: number, content: string) => {
					try {
						appendFileSync(tracePath, JSON.stringify({ uri, version, open: content.length }) + "\n");
					} catch {
						/* tracing must never break sync */
					}
					return TextDocument.create(uri, languageId, version, content);
				},
				update: (doc: TextDocument, changes: Parameters<typeof TextDocument.update>[1], version: number) => {
					const shapes = changes.map((c) =>
						"range" in c ? { range: c.range, textLength: c.text.length } : { full: c.text.length },
					);
					try {
						appendFileSync(tracePath, JSON.stringify({ uri: doc.uri, version, changes: shapes }) + "\n");
					} catch {
						/* tracing must never break sync */
					}
					return TextDocument.update(doc, changes, version);
				},
			}
		: TextDocument;
	const documents = new TextDocuments<TextDocument>(docsConfig);
	// One SqlSession per open file, keyed by URI; rebuilt on open/change.
	const sessions = new Map<string, SqlSession>();
	let rootDir = process.cwd();
	let config: DialectConfig = loadDialectConfig(rootDir, undefined, options.userConfigPath);
	let themeIcons = false;
	// Plugins declared in the config layers (see src/plugin.ts for the authoring contract).
	// Loaded during initialize (so features see them deterministically) and reloaded when a
	// config edit changes the plugin specs. All failures degrade to "plugin absent", logged.
	const pluginHost = new PluginHost({
		info: (m) => connection.console.info(m),
		warn: (m) => connection.console.warn(m),
		error: (m) => connection.console.error(m),
	});
	let pluginSpecsKey = JSON.stringify(config.plugins);
	// Push/pull channel selection. A client that declares textDocument.diagnostic
	// support (VS Code) PULLS for open documents — and still applies pushes into a
	// separate collection, so pushing too shows every SQL diagnostic twice. When the
	// client pulls, SQL diagnostics travel pull-only (a refresh request replaces the
	// lazy-catalog re-publish); push remains for non-pulling clients and, always, for
	// the config file (pull never covers a closed document).
	let clientPullsDiagnostics = false;

	// The catalog every feature resolves against, with exactly one precedence point: an injected
	// host SchemaProvider replaces everything (the embedding contract); otherwise the file-configured
	// schema chains ahead of plugin catalogs (project plugins before user plugins), first hit wins.
	// Rebuilt (not recomputed per call) so sessions and the prime loop see a stable object.
	let activeCatalog: SchemaProvider | undefined;
	const rebuildCatalog = (): void => {
		activeCatalog =
			options.schema ?? composeSchemas([...(config.schema ? [config.schema] : []), ...pluginHost.schemas()]);
	};
	rebuildCatalog();
	const activeSchema = (): SchemaProvider | undefined => activeCatalog;

	const uriToRel = (uri: string): string => {
		try {
			return relative(rootDir, fileURLToPath(uri));
		} catch {
			return uri;
		}
	};

	// ------------------------------------------------------------------
	// Config-file surface: .sqllens.json gets its own diagnostics (positioned
	// on the offending values), quickfix code actions (unknown dialect →
	// replace with a valid one), and live revalidation + re-apply when edited
	// in the editor. It is NEVER routed through the SQL pipeline.
	// ------------------------------------------------------------------
	const isConfigUri = (uri: string): boolean => uri.replace(/\\/g, "/").endsWith("/.sqllens.json");
	const configUri = (): string => pathToFileURL(join(rootDir, ".sqllens.json")).toString();

	const positionAt = (text: string, offset: number): { line: number; character: number } => {
		let line = 0;
		let lineStart = 0;
		for (let i = 0; i < offset && i < text.length; i++) {
			if (text[i] === "\n") {
				line++;
				lineStart = i + 1;
			}
		}
		return { line, character: offset - lineStart };
	};

	/** The config issues as LSP diagnostics against the CURRENT config text. */
	const configDiagnostics = (): { diagnostic: Diagnostic; badValue?: string }[] => {
		const text = config.raw ?? "";
		return config.issues.map((issue) => {
			const range: Range = { start: positionAt(text, issue.start), end: positionAt(text, issue.end) };
			return {
				diagnostic: {
					range,
					severity: DiagnosticSeverity.Error,
					source: "sqllens",
					message: issue.message,
				},
				badValue: issue.kind === "unknown-dialect" ? issue.badValue : undefined,
			};
		});
	};

	const publishConfigDiagnostics = (): void => {
		connection.sendDiagnostics({ uri: configUri(), diagnostics: configDiagnostics().map((d) => d.diagnostic) });
	};

	/** A one-line, edit-surviving hint attached to SQL documents while the config is broken —
	 *  the channel that reaches consumers that never look at .sqllens.json (Claude Code's
	 *  post-edit diagnostics injection reads SQL-file diagnostics, not config-file ones). */
	const configHint = (): Diagnostic[] => {
		if (config.issues.length === 0) return [];
		const zero = { line: 0, character: 0 };
		return [
			{
				range: { start: zero, end: zero },
				severity: DiagnosticSeverity.Information,
				source: "sqllens",
				message: `Dialect config problem in .sqllens.json: ${config.issues[0].message} Fix .sqllens.json at the workspace root.`,
			},
		];
	};

	/** Reload config (from `text` when the config file is open in the editor, else from disk),
	 *  republish its diagnostics, drop all cached sessions (dialect/schema may have changed),
	 *  and re-analyze every open SQL document. Plugins reload only when their specs changed —
	 *  a keystroke in the config file must not churn plugin connections. Reloads are serialized
	 *  on a chain so rapid config edits can't interleave two plugin load/dispose cycles. */
	let reloadChain: Promise<void> = Promise.resolve();
	const reloadConfig = (text?: string): void => {
		reloadChain = reloadChain
			.then(async () => {
				config = loadDialectConfig(rootDir, text, options.userConfigPath);
				for (const w of config.warnings) connection.console.info(w);
				const specsKey = JSON.stringify(config.plugins);
				if (specsKey !== pluginSpecsKey) {
					pluginSpecsKey = specsKey;
					await pluginHost.load(config.plugins, rootDir);
				}
				rebuildCatalog();
				publishConfigDiagnostics();
				sessions.clear();
				for (const doc of documents.all()) if (!isConfigUri(doc.uri)) publish(doc.uri);
				// Pull-capable clients re-fetch SQL diagnostics themselves after a config change.
				if (clientPullsDiagnostics) void connection.languages.diagnostics.refresh();
			})
			.catch((err) =>
				connection.console.error(`Config reload failed: ${err instanceof Error ? err.message : String(err)}`),
			);
	};

	// Build (or rebuild) the SqlSession for `uri` from the TextDocuments registry's current
	// text, resolving the dialect via config, and cache it. Returns undefined only when the
	// registry has no such open document. On an edit we carry the previous session's underlying
	// document (and its per-statement cell cache) forward via withText(), so statements whose
	// text didn't change reuse their parsed cells AND their cached per-cell analysis — an edit to
	// one statement recomputes only that statement. A fresh open (or a dialect change) starts clean,
	// with the active schema baked into the session for its whole lifetime.
	const rebuild = (uri: string): SqlSession | undefined => {
		if (isConfigUri(uri)) return undefined; // the config file never enters the SQL pipeline
		const td = documents.get(uri);
		if (!td) return undefined;
		const dialect = config.dialectFor(uriToRel(uri));
		const prev = sessions.get(uri);
		const session =
			prev && prev.dialect === dialect
				? prev.withText(td.getText())
				: SqlSession.create(td.getText(), dialect, { uri, schema: activeSchema() });
		sessions.set(uri, session);
		return session;
	};

	// The cached session for `uri`, rebuilding once as a fallback if it is missing.
	const sessionFor = (uri: string): SqlSession | undefined => sessions.get(uri) ?? rebuild(uri);

	connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
		// $(codicon) icons in hover markdown are opt-in: only a client that declares it
		// (our VS Code extension, whose middleware renders them) gets them; everyone
		// else gets plain markdown.
		themeIcons = (params.initializationOptions as { themeIcons?: boolean } | undefined)?.themeIcons === true;
		clientPullsDiagnostics = params.capabilities.textDocument?.diagnostic !== undefined;
		if (params.rootUri) {
			try {
				rootDir = fileURLToPath(params.rootUri);
			} catch {
				/* keep cwd */
			}
		} else if (params.workspaceFolders?.[0]) {
			try {
				rootDir = fileURLToPath(params.workspaceFolders[0].uri);
			} catch {
				/* keep cwd */
			}
		}
		config = loadDialectConfig(rootDir, undefined, options.userConfigPath);
		// window/logMessage at Info level. In vscode-languageserver v10 this is RemoteConsole.info
		// (connection.console), not connection.window.logMessage — same wire notification.
		for (const w of config.warnings) connection.console.info(w);
		// Plugins load INSIDE initialize (activate() should be fast; slow work belongs in a
		// provider's fetch) so every later request sees the final plugin set deterministically.
		pluginSpecsKey = JSON.stringify(config.plugins);
		await pluginHost.load(config.plugins, rootDir);
		rebuildCatalog();
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
				hoverProvider: true,
				definitionProvider: true,
				referencesProvider: true,
				documentHighlightProvider: true,
				documentSymbolProvider: true,
				foldingRangeProvider: true,
				selectionRangeProvider: true,
				codeLensProvider: { resolveProvider: false },
				inlayHintProvider: true,
				semanticTokensProvider: { legend: SEMANTIC_LEGEND, range: true, full: { delta: true } },
				completionProvider: { triggerCharacters: [".", " "], resolveProvider: true },
				signatureHelpProvider: { triggerCharacters: ["(", ","] },
				codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
				diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
			},
		};
	});

	// Initial config state (e.g. a broken config already on disk) is published as soon
	// as the client is ready — diagnostics on a file need no didOpen to be shown.
	connection.onInitialized(() => publishConfigDiagnostics());

	const publish = (uri: string): void => {
		void publishNow(uri);
	};
	const publishNow = async (uri: string): Promise<void> => {
		const session = rebuild(uri);
		if (!session) return;
		const schema = activeSchema();
		// Pull-capable clients own SQL diagnostics via textDocument/diagnostic — pushing
		// too would display every item twice (VS Code renders both channels). We still
		// run the analysis here so the lazy-catalog miss/prime loop below stays live.
		const diagnostics = [...configHint(), ...computeDiagnostics(session, schema)];
		if (!clientPullsDiagnostics) {
			await pluginHost.runHook("diagnostics", { session, uri, diagnostics });
			connection.sendDiagnostics({ uri, diagnostics });
		}

		// Lazy catalog: computeDiagnostics just resolved against `schema`; a resolve-on-demand catalog
		// (CallbackSchema for physical tables, CallbackTemplateCatalog for templated refs) records what it
		// could not answer from the host's warm cache as misses. If any are outstanding, warm the resolver
		// in the background and re-publish when it reveals something new — so a cold read squiggles once
		// (never-wrong) and self-heals. Fire-and-forget: the current publish already went out with the
		// best-known (possibly incomplete) diagnostics. Duck-typed (isLazyCatalog) so a resolved templated
		// ref republishes on warm exactly like a resolved physical table.
		if (isLazyCatalog(schema) && schema.misses.length > 0) {
			// Version guard, keyed on the CLIENT's TextDocument version (documents.get(uri)?.version), NOT
			// the session's own doc.version. vscode-languageserver's TextDocuments fires BOTH onDidOpen and
			// onDidChangeContent for a single open notification, so publish() runs twice per open — the
			// second rebuild() carries the identical text but is still a fresh SqlSession, whose internal
			// doc.version bumps regardless (rebuild()/withText() has no notion of "nothing changed"). The
			// LSP-protocol version only changes on a REAL didChange, so it's the stable axis a slow prime
			// threatens: if the file is edited before prime() settles, that edit's own publish+prime chain
			// owns the re-publish, and this stale callback stands down. The SCHEMA axis needs no guard here:
			// prime() resolves true only when its version actually bumped (new tables arrived), and
			// publish() re-reads the current session + schema, so a re-publish is never stale data — only a
			// redundant one, which the client-version check suppresses. prime() itself coalesces concurrent
			// calls (both CallbackSchema.prime and CallbackTemplateCatalog.prime), so rapid edits can't
			// double-fetch.
			const version = documents.get(uri)?.version;
			void schema.prime().then((changed) => {
				if (!changed || documents.get(uri)?.version !== version) return;
				// Pull mode: ask the client to re-pull instead of pushing the refresh.
				if (clientPullsDiagnostics) void connection.languages.diagnostics.refresh();
				else publish(uri);
			});
		}
	};

	documents.onDidOpen((e) =>
		isConfigUri(e.document.uri) ? reloadConfig(e.document.getText()) : publish(e.document.uri),
	);
	documents.onDidChangeContent((e) =>
		isConfigUri(e.document.uri) ? reloadConfig(e.document.getText()) : publish(e.document.uri),
	);
	documents.onDidClose((e) => {
		if (isConfigUri(e.document.uri)) {
			reloadConfig(); // back to the on-disk content (an unsaved buffer edit dies with the editor)
			return;
		}
		sessions.delete(e.document.uri);
		forgetSemanticTokens(e.document.uri);
	});

	// Quickfixes for config problems. On the config file itself: every unknown-dialect
	// diagnostic intersecting the requested range gets one action per valid dialect,
	// closest name first (preferred), editing the value in place. On a SQL document:
	// the config-hint diagnostic (top of file, while the config is broken) offers the
	// SAME fixes as cross-file workspace edits into .sqllens.json — the fix belongs
	// wherever the user actually is.
	connection.onCodeAction(async (params) => {
		const overlaps = (a: Range, b: Range): boolean => {
			const before = (p: { line: number; character: number }, q: { line: number; character: number }) =>
				p.line < q.line || (p.line === q.line && p.character <= q.character);
			return before(a.start, b.end) && before(b.start, a.end);
		};
		const onConfig = isConfigUri(params.textDocument.uri);
		const actions: CodeAction[] = [];
		// Config quickfixes: on the config file always; on SQL docs only through the
		// zero-width hint at 0:0, and only while the config is broken.
		const hint = configHint()[0];
		if (onConfig || (hint !== undefined && overlaps(hint.range, params.range))) {
			for (const { diagnostic, badValue } of configDiagnostics()) {
				if (badValue === undefined) continue;
				if (onConfig && !overlaps(diagnostic.range, params.range)) continue;
				const ranked = [...PRIMARY_DIALECTS].sort(
					(a, b) => editDistance(badValue.toLowerCase(), a) - editDistance(badValue.toLowerCase(), b),
				);
				ranked.forEach((dialect, i) =>
					actions.push({
						title: onConfig
							? `Change dialect to "${dialect}"`
							: `Fix .sqllens.json: change dialect "${badValue}" to "${dialect}"`,
						kind: CodeActionKind.QuickFix,
						diagnostics: [onConfig ? diagnostic : configHint()[0]],
						isPreferred: i === 0,
						edit: {
							changes: {
								[configUri()]: [{ range: diagnostic.range, newText: `"${dialect}"` }],
							},
						},
					}),
				);
			}
		}
		if (!onConfig) {
			const session = sessionFor(params.textDocument.uri);
			if (session)
				await pluginHost.runHook("codeActions", {
					session,
					uri: params.textDocument.uri,
					range: params.range,
					diagnostics: params.context.diagnostics,
					actions,
				});
		}
		return actions;
	});

	// Pull diagnostics (textDocument/diagnostic): same items as the push path computes.
	// Channel selection is exclusive per client (see clientPullsDiagnostics): pull-capable
	// clients get SQL diagnostics ONLY here; others ONLY via push.
	connection.languages.diagnostics.on(async (params) => {
		// Config diagnostics travel ONLY on the push channel: push works for a closed
		// file (Problems shows the broken config before it's ever opened) and pushes
		// replace per-uri so there is exactly one copy. Serving them here too made
		// clients that both pull and receive pushes (VS Code) display duplicates.
		if (isConfigUri(params.textDocument.uri)) return { kind: "full" as const, items: [] };
		const session = sessionFor(params.textDocument.uri);
		if (!session) return { kind: "full" as const, items: [] };
		const report = computeDocumentDiagnostics(session, activeSchema());
		if (report.kind !== "full") return report;
		const items = [...configHint(), ...report.items];
		await pluginHost.runHook("diagnostics", { session, uri: params.textDocument.uri, diagnostics: items });
		return { ...report, items };
	});

	connection.onHover(async (params) => {
		const session = sessionFor(params.textDocument.uri);
		if (!session) return null;
		// Hooks see the pre-render model (cards + resolved symbol) and append; the join to
		// markdown happens after, so plugin cards get the same `---` separators as ours.
		const model = computeHoverModel(session, params.position, { schema: activeSchema(), icons: themeIcons }) ?? {
			cards: [],
		};
		await pluginHost.runHook("hover", {
			session,
			uri: params.textDocument.uri,
			position: params.position,
			symbol: model.symbol,
			cards: model.cards,
		});
		return renderHoverModel(model);
	});

	connection.onDefinition((params) => {
		const session = sessionFor(params.textDocument.uri);
		if (!session) return null;
		return computeDefinition(session, params.position, params.textDocument.uri);
	});

	connection.onReferences((params) => {
		const session = sessionFor(params.textDocument.uri);
		if (!session) return [];
		return computeReferences(session, params.position, params.context.includeDeclaration, params.textDocument.uri);
	});

	connection.onDocumentHighlight((params) => {
		const session = sessionFor(params.textDocument.uri);
		if (!session) return [];
		return computeDocumentHighlight(session, params.position);
	});

	connection.onDocumentSymbol((params) => {
		const session = sessionFor(params.textDocument.uri);
		if (!session) return [];
		return computeDocumentSymbols(session, params.textDocument.uri);
	});

	connection.onFoldingRanges((params) => {
		const session = sessionFor(params.textDocument.uri);
		return session ? computeFoldingRanges(session) : [];
	});

	connection.onSelectionRanges((params) => {
		const session = sessionFor(params.textDocument.uri);
		return session ? computeSelectionRanges(session, params.positions) : [];
	});

	connection.onCodeLens((params) => {
		const session = sessionFor(params.textDocument.uri);
		return session ? computeCodeLens(session) : [];
	});

	connection.languages.inlayHint.on((params) => {
		const session = sessionFor(params.textDocument.uri);
		return session ? computeInlayHints(session, params.range) : [];
	});

	connection.languages.semanticTokens.on((params) => {
		const uri = params.textDocument.uri;
		const session = sessionFor(uri);
		return session ? computeSemanticTokens(session, uri) : { data: [] };
	});

	connection.languages.semanticTokens.onRange((params) => {
		const session = sessionFor(params.textDocument.uri);
		return session ? computeSemanticTokensRange(session, params.range) : { data: [] };
	});

	connection.languages.semanticTokens.onDelta((params) => {
		const uri = params.textDocument.uri;
		const session = sessionFor(uri);
		return session ? computeSemanticTokensDelta(session, uri, params.previousResultId) : { data: [] };
	});

	connection.onCompletion(async (params) => {
		const session = sessionFor(params.textDocument.uri);
		if (!session) return [];
		const items = computeCompletion(session, params.position);
		await pluginHost.runHook("completion", {
			session,
			uri: params.textDocument.uri,
			position: params.position,
			items,
		});
		return items;
	});

	// completionItem/resolve receives ONLY the item (no doc/position); resolveCompletion reads its
	// `data` payload to fill a function's signature lazily. Total — never throws.
	connection.onCompletionResolve((item) => resolveCompletion(item));

	connection.onSignatureHelp((params) => {
		const session = sessionFor(params.textDocument.uri);
		return session ? computeSignatureHelp(session, params.position) : null;
	});

	documents.listen(connection);
	connection.listen();
}
