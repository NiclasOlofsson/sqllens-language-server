# CLAUDE.md — sqllens-language-server

The SQL language server built on sqllens. A standalone LSP, split out from the
sqllens repo so the two ship and version on their own cadence. Multi-dialect,
source-first, semantics-first.

Positioning (Niclas, 2026-07-13): the name says sqllens, deliberately neither
"SQL" nor "dbt". The product ships first as a standalone SQL LSP — being useful
WITHOUT dbt is the hard part and the design challenge — and becomes a full
dbt-enabled LSP later (the dbt machinery already exists in the sibling dbt Anvil
repo, `../dbt-studio-vscode`). "Not a dbt tool" is a branding statement, not a
functional limit.

npm name: `sqllens-language-server`. Claude Code plugin planned in `claude-plugin/`
(slug `sqllens-lsp`), with this repo doubling as a self-hosted marketplace. The
thin VS Code client extension (Milestone 2) lives in `vscode-extension/` as a
self-contained sub-package (own package.json/build/tests, not an npm workspace),
so the root release train stays server-only.

## Where the source came from

The sqllens parser/analyzer lives in the sibling folder `../sql-dialect-grammars`
(the local folder is named `sql-dialect-grammars`; the package it publishes is
`sqllens`; repo github.com/NiclasOlofsson/sqllens). Read that repo's `CLAUDE.md`
before working here.

This repo's `src/` is the lift of that repo's `src/lsp/` seed (flattened one
level), rewired to import the published `sqllens` package instead of the in-repo
barrel. Consume sqllens as a dependency; never fork it, never reimplement
analysis here — the server is a thin protocol adapter and must stay one.

## Tooling

Matches the sibling exactly: npm, ESM (`"type": "module"`), node >=20.11,
typescript ^6 (`tsc -p tsconfig.build.json` emits `dist/`), tsgo
(`@typescript/native-preview`) for typecheck, vitest, prettier (tabs, width 4,
120 cols), semantic-release (Angular preset — NEVER a `!` type suffix or
`BREAKING CHANGE:` footer; majors are decided out of band).

## Commands

```bash
npm run typecheck        # tsgo, noEmit
npm test                 # vitest: acceptance + feature suites (in-memory JSON-RPC)
npm run build            # tsc → dist/
npm run smoke            # boots the real bin/cli.js --stdio and drives init/hover
npm run dev              # server from source via tsx (needs --stdio, already in script)
SQLLENS_LOCAL=1 npm test # co-dev: alias sqllens → ../sql-dialect-grammars/src
```

`--stdio` is mandatory on every launch path: `createConnection` throws without a
transport flag.

## Background discussion

The naming decision, the SQL-vs-dbt positioning, and an analysis of the incumbent
(joe-re/sql-language-server) were worked out with Niclas in a Claude Code session;
transcript at
`C:\Users\nicke\.claude\projects\c--Development-github-sql-dialect-grammars\2e6a74d1-c30e-4dec-a0c7-f10c56551b44.jsonl`.
The bootstrap plan and roadmap (milestones: npm publish + Claude Code plugin,
VS Code thin client later, dbt mode after SQL v1) live at
`C:\Users\nicke\.claude\plans\lets-build-an-lsp-optimized-robin.md`.

## Status

Bootstrapped 2026-07-13; v0.1.0 published to npm 2026-07-14 (manual first
publish, tag v0.1.0 is the semantic-release baseline; releases via
`gh workflow run release.yml` once npm trusted publishing is linked). Repo is
public and doubles as a live plugin marketplace. Claude plugin verified
end-to-end on Claude Code 2.1.161; current 2.1.20x has an upstream Windows
LSP-launcher regression breaking ALL plugin LSP servers (their issue #73961) —
test by pinning `claude install 2.1.161`. Test workspace + protocol probe
drivers live in `temp_auto/localtest/`. Next: community-marketplace submission,
then Milestone 2 (VS Code extension).
