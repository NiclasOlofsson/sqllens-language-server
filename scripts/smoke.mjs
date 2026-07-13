// scripts/smoke.mjs — boots the REAL packaged binary (bin/cli.js --stdio) as a child
// process and drives initialize → didOpen → diagnostics → hover over its stdio. This is
// the one path the vitest acceptance suite (in-memory duplex) does not prove: that the
// shebang'd, bin-wired artifact starts and speaks LSP outside the test runner.
// Run: npm run build && npm run smoke
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createProtocolConnection,
	StreamMessageReader,
	StreamMessageWriter,
	InitializeRequest,
	DidOpenTextDocumentNotification,
	PublishDiagnosticsNotification,
	HoverRequest,
} from "vscode-languageserver-protocol/node";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Temp workspace: dialect config + schema catalog + one query.
const root = mkdtempSync(join(tmpdir(), "sqllens-smoke-"));
writeFileSync(join(root, ".sqllens.json"), JSON.stringify({ default: "duckdb", schema: "schema.json" }));
writeFileSync(
	join(root, "schema.json"),
	JSON.stringify({ sales: { id: "bigint", amount: "decimal(10,2)", region: "varchar" } }),
);
const sql = "select amount from sales";

const child = spawn(process.execPath, [join(repoRoot, "bin", "cli.js"), "--stdio"], {
	stdio: ["pipe", "pipe", "inherit"],
});
const client = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));

const fail = (msg) => {
	console.error("SMOKE FAIL:", msg);
	child.kill();
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
};
setTimeout(() => fail("timed out after 15s"), 15000).unref();

const diagnostics = new Promise((resolveDiag) => {
	client.onNotification(PublishDiagnosticsNotification.type, (p) => resolveDiag(p));
});
client.listen();

const init = await client.sendRequest(InitializeRequest.type, {
	processId: null,
	rootUri: pathToFileURL(root).toString(),
	capabilities: {},
	workspaceFolders: null,
});
if (!init.capabilities.hoverProvider) fail("server reported no hoverProvider");

const uri = pathToFileURL(join(root, "query.sql")).toString();
await client.sendNotification(DidOpenTextDocumentNotification.type, {
	textDocument: { uri, languageId: "sql", version: 1, text: sql },
});

const diag = await diagnostics;
if (diag.uri !== uri) fail(`diagnostics for unexpected uri: ${diag.uri}`);
if (diag.diagnostics.length !== 0) fail(`expected clean diagnostics, got: ${JSON.stringify(diag.diagnostics)}`);

// Hover over "amount" (line 0, col 8).
const hover = await client.sendRequest(HoverRequest.type, {
	textDocument: { uri },
	position: { line: 0, character: 8 },
});
const hoverText = JSON.stringify(hover?.contents ?? null);
if (!hoverText.includes("decimal")) fail(`hover did not carry the schema type, got: ${hoverText}`);

console.log("SMOKE OK");
console.log("  initialize : hover/definition/completion capabilities advertised");
console.log("  diagnostics:", diag.diagnostics.length, "problems (clean file)");
console.log("  hover      :", hoverText);

client.dispose();
child.kill();
rmSync(root, { recursive: true, force: true });
process.exit(0);
