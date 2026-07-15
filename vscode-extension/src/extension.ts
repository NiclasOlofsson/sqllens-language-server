// The entire extension: client wiring around the bundled sqllens-language-server.
// The server ships inside this extension as an npm dependency and runs as a forked
// module in VS Code's own Node — no PATH lookup, no separate install.
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
	// The package exports only its root entry (dist/index.js); resolve the sibling
	// main.js (the connection entry) from it rather than a subpath import.
	const serverModule = path.join(path.dirname(require.resolve("sqllens-language-server")), "main.js");
	client = new LanguageClient(
		"sqllens",
		"sqllens SQL",
		{
			run: { module: serverModule, transport: TransportKind.ipc },
			debug: { module: serverModule, transport: TransportKind.ipc },
		},
		{
			documentSelector: [
				{ language: "sql" },
				// Our sql-<dialect> language ids: picking one IS picking the dialect — the
				// server reads it off didOpen's languageId and it wins over .sqllens.json.
				...[
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
				].map((d) => ({ language: `sql-${d}` })),
				// Route the server's own config file to it: it validates the config live,
				// squiggles bad values, and serves the change-dialect quickfixes.
				{ pattern: "**/.sqllens.json" },
			],
			// Tell the server it may emit $(codicon) theme icons in hover markdown …
			initializationOptions: { themeIcons: true },
			middleware: {
				// … and re-wrap the returned markdown with icon support enabled, which
				// plain LSP-converted MarkdownStrings don't carry.
				provideHover: async (document, position, token, next) => {
					const hover = await next(document, position, token);
					if (!hover) return hover;
					hover.contents = hover.contents.map((c) =>
						c instanceof vscode.MarkdownString ? new vscode.MarkdownString(c.value, true) : c,
					);
					return hover;
				},
			},
		},
	);
	await client.start();
}

export function deactivate(): Thenable<void> | undefined {
	return client?.stop();
}
