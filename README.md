# sqllens-language-server

A multi-dialect SQL language server built on [sqllens](https://github.com/NiclasOlofsson/sqllens),
the TypeScript SQL parser and static analyzer. The server is a thin Language Server
Protocol (LSP) adapter: it maps editor requests to the library's passes (`parse →
lower → resolveScopes → qualify → infer → symbols`) and translates the results into
LSP shapes. It holds no analysis logic of its own: diagnostics, types, definitions,
output columns, tokens, completions, and signatures all come from the library.

Source-first and semantics-first: the server understands SQL statically, across ten
real dialects, without a database connection. Schema knowledge is optional and file-fed;
with it you get semantic diagnostics, typed hover, and schema-aware completion, and
without it the syntax tiers keep working.

Dialects: `databricks`, `tsql`, `snowflake`, `bigquery`, `redshift`, `postgres`,
`duckdb`, `trino`, `sqlite`, `mysql`.

## Install and run

```bash
npm install -g sqllens-language-server
sqllens-language-server --stdio
```

The server speaks LSP over stdio (the `--stdio` flag is required). It is meant to be
launched by an editor / LSP client, not used interactively from a terminal.

The server holds one session per open file (rebuilt on edit) and serves every feature
from that cached document.

## Features

Every feature carries real source positions (no count-only or point-only output).

- Diagnostics: syntax errors from the parser plus semantic diagnostics from
  `qualify` (unknown table/column/field), each as a positioned range.
- Hover: the inferred type of the expression under the cursor, ranged to the
  covering expression's source span.
- Go-to-definition: jumps to a symbol's definition span (CTE, alias, derived
  column).
- References: find-all-occurrences plus the declaration of the symbol under the
  cursor.
- Document highlight: the same occurrences scoped to the open document.
- Document symbols: the symbol tree (sources, CTEs, output columns) with each
  symbol's span.
- Code lens: a reference-count lens over each declared symbol.
- Folding ranges: foldable regions for statements, CTEs, and subqueries.
- Selection ranges: expand/shrink selection following the syntax tree from the
  caret outward.
- Inlay hints: inline output-column types, shown at each projection.
- Semantic tokens: semantic highlighting from the document's token stream, each
  token with its exact span and role; serves full, range, and delta requests.
- Completion: scope-aware suggestions at the caret (keywords, schema
  tables/columns, function names). Works on mid-edit / invalid input.
- Completion resolve: lazily fills a completion item's signature detail for
  function candidates.
- Signature help: parameter hints while typing inside a call's parens, from a
  curated per-dialect signature table.
- Pull diagnostics (`textDocument/diagnostic`): the same items as the push path,
  served on demand; push and pull coexist and the client picks whichever it supports.

## Dialect and schema config: `.sqllens.json`

A document's dialect is configured, never guessed. On initialize, the server reads
`.sqllens.json` from the workspace root. It holds an ordered list of glob rules
(first match wins), an optional default, and an optional `schema` catalog. A missing
or malformed config is non-fatal: every file falls back to the `databricks` dialect
and a warning is logged over the LSP `window/logMessage` channel.

Example `.sqllens.json`:

```json
{
	"dialects": [
		{ "files": "warehouse/snowflake/**/*.sql", "dialect": "snowflake" },
		{ "files": "edw/**/*.sql", "dialect": "tsql" }
	],
	"default": "databricks",
	"schema": "schema.json"
}
```

`schema` points at a JSON catalog (a `SchemaMapping`: `{ table: { column: type } }`)
resolved relative to the workspace root. The catalog feeds the semantic-diagnostics
and hover tiers; without it those tiers degrade gracefully (syntax diagnostics and
structural symbols still work).

Example `schema.json`:

```json
{
	"sales": { "id": "bigint", "amount": "decimal(10,2)", "region": "string" }
}
```

## Attaching a client

Point any LSP client at the stdio launch command:

- command: `sqllens-language-server`
- args: `["--stdio"]`
- working directory: the workspace root that holds `.sqllens.json`

The client sends `initialize` with the workspace `rootUri`; the server reads
`.sqllens.json` from there.

## Embedding: handing the server a live catalog (`SchemaProvider`)

The stdio binary reads a static catalog from the `.sqllens.json` `schema` file. A
host that embeds the server (calls `startServer` itself, rather than launching the
stdio binary) can instead supply a live catalog: any `SchemaProvider` (a
`DefaultTemplateProvider` subclass also satisfies it, adding template resolution), as
the second argument:

```ts
import { startServer } from "sqllens-language-server";
import { CallbackSchema, type TableResolver } from "sqllens";

const resolver: TableResolver = {
	// Sync read from the host's warm cache; undefined = not-yet-loaded (recorded as a miss).
	resolve: (parts) => cache.get(parts.join(".")),
	// Async warm for the missed tables — fetched from the warehouse's information_schema, etc.
	fetch: async (missing) => {
		for (const parts of missing) cache.set(parts.join("."), await loadColumns(parts));
	},
};
startServer(connection, { schema: new CallbackSchema(resolver) });
```

An injected `schema` is the active catalog for every document and takes precedence
over the `.sqllens.json` `schema` file (the file path is the zero-config default; the
embedding slot is the programmatic override).

This is the answer to a big warehouse where a full upfront `SchemaMapping` is
infeasible. `CallbackSchema` resolves each table on demand:

- Analysis stays 100% synchronous: `resolve` answers from whatever the host cache
  holds now; an unknown table degrades to an unknown type, exactly like a missing
  mapping entry (never-wrong, no new diagnostic class).
- Every table the resolver couldn't answer is recorded as a **miss**. After each
  diagnostics publish, if there are fresh misses the server warms the resolver in the
  background (`prime()`) and, when a table is revealed, re-publishes diagnostics for
  that document: a cold read squiggles once and self-heals when the catalog warms.
- `prime()` coalesces concurrent calls and bumps a monotonic `version` only when a
  new table actually arrives, so the re-publish is version-guarded (a stale prime never
  overwrites a newer edit's diagnostics).

`SchemaProvider`, `CallbackSchema`, `TableResolver`, and `DefaultTemplateProvider` are
exported from the sqllens barrel. Note the `world` capability on `SchemaProvider`:
`Schema`/`CallbackSchema` are CLOSED worlds (a miss means the table doesn't exist;
unknown-table may fire and self-heals via `prime()`), while `DefaultTemplateProvider`
defaults OPEN (a miss is unknown, never diagnosed). A subclass backing `columnsFor`
with a describe cache should declare `override readonly world = "closed" as const`
to keep the unknown-table flow.

## Development

```bash
npm install
npm run typecheck        # tsgo, noEmit
npm test                 # vitest: in-memory acceptance + feature suites
npm run build            # tsc → dist/
npm run smoke            # boots the real packaged binary over stdio
npm run dev              # run the server from source (tsx) with --stdio
```

Co-development against a local sqllens checkout (sibling folder
`../sql-dialect-grammars`): `SQLLENS_LOCAL=1 npm test` aliases `sqllens` to the
sibling's TypeScript source, and `tsgo -p tsconfig.dev.json` typechecks against it.
CI and everyday runs use the published npm package like any other consumer.

## Proof

The repeatable proof is the in-memory acceptance suite,
[`tests/lsp.acceptance.test.ts`](tests/lsp.acceptance.test.ts). It drives the
real server over an in-memory JSON-RPC duplex pair and asserts positioned results for
every feature against a temp workspace with `.sqllens.json` + `schema.json`. It
exercises `startServer` (the same function the stdio binary runs), so the tested code
path is the shipped one. `npm run smoke` additionally proves the packaged, bin-wired
artifact boots outside the test runner.

## License

MIT
