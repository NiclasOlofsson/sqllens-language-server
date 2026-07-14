# sqllens SQL

Multi-dialect SQL language support for VS Code, powered by the
[sqllens](https://github.com/NiclasOlofsson/sqllens) analyzer via
[sqllens-language-server](https://github.com/NiclasOlofsson/sqllens-language-server).
Fully self-contained: the language server is bundled with the extension, so
installing it is the only step.

Source-first and semantics-first: SQL is understood statically, across ten real
dialects, without a database connection.

## Features

- Diagnostics: positioned syntax errors plus semantic errors (unknown
  table/column/field) when a schema catalog is configured.
- Typed hover (with nullability where provable), go-to-definition, find
  references, document highlight, document symbols, code lens.
- Scope-aware completion (works mid-edit), signature help, inlay hints,
  semantic highlighting, folding and selection ranges.

Dialects: `databricks`, `tsql`, `snowflake`, `bigquery`, `redshift`,
`postgres`, `duckdb`, `trino`, `sqlite`, `mysql`.

## Configuration: `.sqllens.json`

Optional, at the workspace root. Maps files to dialects (first match wins) and
points at a schema catalog that switches on the semantic tier:

```json
{
	"dialects": [{ "files": "tsql/**/*.sql", "dialect": "tsql" }],
	"default": "duckdb",
	"schema": "schema.json"
}
```

`schema.json` is a plain `{ "table": { "column": "type" } }` catalog. Without
any config, files fall back to the `databricks` dialect and the syntax tiers
still work.

## Development

This folder is a self-contained sub-package of the
[sqllens-language-server repo](https://github.com/NiclasOlofsson/sqllens-language-server):

```bash
npm install
npm run build        # tsc → dist/
npm run package      # vsce → .vsix
```

The bundled server version is pinned by this package's dependency on
`sqllens-language-server`; extension releases mirror server releases.

## License

MIT
