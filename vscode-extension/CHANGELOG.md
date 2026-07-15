# Changelog

Extension releases mirror [sqllens-language-server](https://github.com/NiclasOlofsson/sqllens-language-server/blob/master/CHANGELOG.md)
releases; the server changelog is the detailed record.

## 0.3.0

First Marketplace release. Bundles sqllens-language-server 0.3.x:

- Diagnostics (syntax + schema-aware semantic tier), typed hover with lineage,
  go-to-definition, references, completion with signature detail and vendor
  function docs, signature help, document symbols, semantic highlighting,
  folding, inlay hints, code lens.
- Ten dialects; `.sqllens.json` config with positioned errors and quickfixes.
- `sql-<dialect>` languages: the language picker doubles as a dialect picker.
- JS/ESM plugin system (see PLUGINS.md in the repo).
