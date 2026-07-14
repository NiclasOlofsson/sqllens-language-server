// The entire extension: client wiring around the bundled sqllens-language-server.
// The server ships inside this extension as an npm dependency and runs as a forked
// module in VS Code's own Node — no PATH lookup, no separate install.
import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(_context: ExtensionContext): Promise<void> {
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
				// Route the server's own config file to it: it validates the config live,
				// squiggles bad values, and serves the change-dialect quickfixes.
				{ pattern: "**/.sqllens.json" },
			],
		},
	);
	await client.start();
}

export function deactivate(): Thenable<void> | undefined {
	return client?.stop();
}
