# sqllens-lsp — Claude Code plugin

SQL code intelligence for Claude Code. Wires the
[sqllens-language-server](https://github.com/NiclasOlofsson/sqllens-language-server)
into Claude Code's LSP tool, so Claude gets positioned diagnostics after every
edit to a `.sql` file, plus hover types, go-to-definition, references, and
document symbols on demand. Multi-dialect (`databricks`, `tsql`, `snowflake`,
`bigquery`, `redshift`, `postgres`, `duckdb`, `trino`, `sqlite`, `mysql`),
source-first: no database connection needed.

## Install

1. Install the language server (the plugin wires it up, it does not bundle it).
   Either globally:

```bash
npm install -g sqllens-language-server
```

   or per project (the plugin launches via `npx --no-install`, which resolves
   your project's `node_modules` first, then the global install — so a local
   install also pins the server version per project):

```bash
npm install -D sqllens-language-server
```

2. Install the plugin:

```
/plugin marketplace add NiclasOlofsson/sqllens-language-server
/plugin install sqllens-lsp@sqllens-language-server
```

3. Optional but recommended: a `.sqllens.json` at your workspace root pins the
   dialect per file glob and points at a schema catalog (see the
   [server README](../README.md) for the format). Without it, files fall back
   to the `databricks` dialect and schema-aware tiers stay quiet.

## What you get

- Diagnostics: syntax errors plus semantic errors (unknown table/column/field
  when a schema catalog is configured), reported to Claude automatically after
  each edit.
- Hover: the inferred type of the expression under the cursor.
- Navigation: go-to-definition and find-references for CTEs, aliases, and
  derived columns; document symbols for the file's structure.

## Try it

With the plugin installed, open a workspace containing this `schema.json`:

```json
{ "sales": { "id": "bigint", "amount": "decimal(10,2)", "region": "varchar" } }
```

and this `.sqllens.json`:

```json
{ "default": "duckdb", "schema": "schema.json" }
```

Three things to ask Claude that exercise the plugin end to end:

1. "Create `report.sql` selecting total amount per region from sales." — after
   the edit, the LSP diagnostics come back clean (or flag any typo'd column as
   `unknown column`, positioned on the identifier).
2. "What type does the `amount` column have in report.sql?" — Claude answers
   from hover: `decimal(10,2)` from the catalog, or the inferred result type of
   an expression over it.
3. "Rename the CTE in report.sql and update every usage." — Claude finds the
   usages via references instead of text search.

## Troubleshooting

- Server errors on startup (`npm error` / "canceled due to missing packages" in
  `/plugin` → Errors): step 1 was skipped — the server is installed neither in
  the project nor globally. `npx --no-install sqllens-language-server --stdio`
  should start (and wait silently) in a terminal at your workspace root. The
  plugin never downloads the server; it only runs what you installed.
- Every file treated as Databricks SQL: add a `.sqllens.json` with your
  dialect(s).
- No unknown-table/column diagnostics: expected without a schema catalog —
  syntax tiers still run; add `schema` to `.sqllens.json` for the semantic tier.

## Support

Issues and questions: https://github.com/NiclasOlofsson/sqllens-language-server/issues

MIT licensed, same as the server.
