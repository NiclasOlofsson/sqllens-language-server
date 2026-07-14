#!/usr/bin/env node
// src/main.ts
// Attachable entry: the same server any LSP client (VS Code, Claude Code, ...) connects to.
// createConnection picks the transport off argv; exactly one transport flag is required.
// --help / --version answer here, before any LSP machinery starts.
import { createRequire } from "node:module";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startServer } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `sqllens-language-server ${version}
Multi-dialect SQL language server (LSP), built on sqllens.

Usage: sqllens-language-server <transport>

Transports (exactly one required):
  --stdio            JSON-RPC over stdin/stdout (the common choice)
  --node-ipc         Node child-process IPC (when forked from a Node host)
  --socket=<port>    connect to a TCP port the client is listening on
  --pipe=<name>      named pipe (Windows) / Unix domain socket

Options:
  --help             print this help and exit
  --version          print the version and exit

Configuration (discovered from the initialize workspace root, not passed as flags):
  <workspace>/.sqllens.json   project layer: glob-to-dialect rules, default dialect,
                              schema catalog, plugins
  ~/.sqllens.json             user layer, merged under the project file

Environment:
  SQLLENS_USER_CONFIG=<path>  user-layer config location (default ~/.sqllens.json)
  SQLLENS_NO_PLUGINS=1        disable plugin loading
  SQLLENS_TRACE_SYNC=<file>   append per-change document-sync traces (debug aid)

Features: diagnostics (push and pull), typed hover with lineage, completion,
signature help, go to definition, references, document symbols, semantic tokens,
code actions, folding, inlay hints, code lens, selection ranges.
Dialects: databricks, tsql, snowflake, bigquery, redshift, postgres, duckdb,
trino, sqlite, mysql.

Docs: https://github.com/NiclasOlofsson/sqllens-language-server
Plugins: PLUGINS.md in the repo (JS/ESM plugin tutorial)`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
	console.log(version);
	process.exit(0);
}
const hasTransport = argv.some(
	(a) => a === "--stdio" || a === "--node-ipc" || a.startsWith("--socket=") || a.startsWith("--pipe="),
);
if (!hasTransport) {
	console.error(HELP);
	console.error("\nerror: a transport flag is required (see Usage above).");
	process.exit(1);
}

startServer(createConnection(ProposedFeatures.all));
