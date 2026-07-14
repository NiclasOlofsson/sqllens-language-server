# Plugins

sqllens-language-server loads plugins: plain JavaScript (ES module) files or npm packages that
extend the server with your own catalog sources and your own behavior on top of every LSP answer.
A plugin is one module with one job:

```js
export const api = 1;

export default function activate(ctx) {
	return {
		schema: { ... },   // feed the analysis: a live table catalog
		hooks: { ... },    // shape the answers: diagnostics, hover, completion, code actions
		dispose() { ... }, // optional cleanup
	};
}
```

Providers feed analysis in, hooks shape answers out. Every hook call is crash-isolated: a plugin
that throws is logged and skipped, and the server's own answer ships untouched. A broken plugin
degrades to an absent plugin, never to a broken editor.

## Quick start: a team lint rule in five minutes

Create two files in a workspace.

`.sqllens.json`:

```json
{
	"default": "databricks",
	"plugins": ["./sqllens-rules.mjs"]
}
```

`sqllens-rules.mjs`:

```js
export const api = 1;

// Symbol spans are 1-based line / 0-based column; LSP ranges are 0-based both.
const rangeOf = (span) => ({
	start: { line: span.line - 1, character: span.column },
	end: { line: span.endLine - 1, character: span.endColumn },
});

export default function activate(ctx) {
	return {
		hooks: {
			diagnostics({ session, diagnostics }) {
				for (const sym of session.deriveSymbols()) {
					if (sym.kind === "table" && !sym.alias) {
						diagnostics.push({
							range: rangeOf(sym.span),
							severity: 2, // 1 error, 2 warning, 3 info, 4 hint
							message: "Team rule: every table gets an alias.",
							source: "sqllens-rules",
						});
					}
				}
			},
		},
	};
}
```

Open `SELECT amount FROM sales` and the table name gets a warning from source `sqllens-rules`.
Write `FROM sales AS s` and it goes away. The rule runs against resolved scopes and symbols in
all ten dialects; you wrote eleven lines of it.

## The activate contract

`activate(ctx)` runs once per load (it may be async). `ctx` has three fields:

```js
ctx.workspaceRoot; // absolute workspace path
ctx.options;       // this plugin's options, merged across config layers (see below)
ctx.log("...");    // lands in the client's output channel, tagged with the plugin name
```

Return an object with any of `schema`, `hooks`, `dispose`. Return `null` or `undefined` to
decline: a user-layer plugin registered for every project can look at `ctx.workspaceRoot` and
stay out of workspaces where it doesn't apply.

`export const api = 1` is the compatibility handshake. The server skips a plugin whose `api` is
newer than what it implements, instead of loading it half-way.

## Hooks

Every hook has the same shape: you get what the user asked, the analyzed `session`, and the
answer the server was about to send. Mutate the answer (push, filter) or return nothing to leave
it alone. Hooks may be async; hover and completion sit on the user's keystroke, so keep them fast.

```js
hooks: {
	diagnostics({ session, uri, diagnostics }) {},          // push Diagnostic items; set `source`
	hover({ session, uri, position, symbol, cards }) {},    // push markdown strings; joined with --- rules
	completion({ session, uri, position, items }) {},       // push CompletionItem entries
	codeActions({ session, uri, range, diagnostics, actions }) {}, // push CodeAction entries
}
```

`session` is a sqllens `SqlSession`: `session.deriveSymbols()`, `session.types()`,
`session.dialect`, and the rest of the sqllens public API. `symbol` in the hover hook is the
resolved symbol under the cursor, when there is one.

Multiple plugins run in load order (user layer first, then project); each sees what earlier
hooks appended.

## Live catalogs: the schema provider

The `schema` provider connects the server to a catalog only you can reach, a warehouse, a
metastore, an internal API. It powers unknown-column diagnostics, typed hover, and schema-aware
completion. The contract is a sync/async split so analysis never blocks:

```js
export const api = 1;

export default function activate(ctx) {
	const cache = new Map();
	return {
		schema: {
			// Sync and cheap: called during analysis. undefined = not (yet) known. Never guess.
			resolve(parts) {
				return cache.get(parts.join("."));
			},
			// Async and batched: called out of band with the names resolve() missed.
			// Warm the cache; the server re-analyzes and republishes on its own.
			async fetch(missing) {
				const rows = await queryInformationSchema(ctx.options, missing);
				for (const t of rows) cache.set(t.name, t.columns); // [{ name, type }]
			},
		},
	};
}
```

`resolve` receives folded table-name parts (for example `["analytics", "orders"]` or just
`["orders"]`) and returns an array of `{ name, type }` columns or `undefined`. A cold document
may squiggle once while `fetch` runs, then heal when the cache warms; that loop (misses, prime,
republish) already exists in the server, plugins inherit it.

One more field decides what a miss means:

```js
schema: {
	world: "open", // a miss means "unknown, do not diagnose"
	resolve(parts) { ... },
}
```

The default is `"closed"`: your catalog is complete, so an unresolved table IS an unknown table
and gets a diagnostic. Declare `"open"` when your resolver only knows part of the world, and the
server stays silent about the rest instead of being wrong.

When several catalogs are active (a `schema.json` file, project plugins, user plugins), lookups
chain in that order and the first answer wins.

## Config layering: project file and user file

Two config files, same format:

- `<workspace>/.sqllens.json`: the project layer, committed, says what the project is.
- `~/.sqllens.json`: the user layer, personal, active in every workspace. Override the location
  with the `SQLLENS_USER_CONFIG` environment variable.

Project wins on scalars (`default`, `schema`); project glob rules match before user rules;
`plugins` lists concatenate with the user layer loading first. When both layers declare the same
plugin, its options deep-merge with the project value winning per key. That split keeps
credentials out of the repo:

`~/.sqllens.json` (personal, holds the secret):

```json
{
	"plugins": [{ "module": "sqllens-plugin-databricks", "options": { "token": "dapi..." } }]
}
```

`<workspace>/.sqllens.json` (committed, pins what the project needs):

```json
{
	"plugins": [{ "module": "sqllens-plugin-databricks", "options": { "profile": "prod" } }]
}
```

The plugin's `ctx.options` arrives as `{ "token": "dapi...", "profile": "prod" }`.

## Installing plugins from npm

Bare module names resolve in three steps, first hit wins:

1. the workspace `node_modules` (for projects that have one)
2. the server's own installation (a globally installed server finds globally installed plugins)
3. the npm global root (`npm root -g`), so `npm i -g sqllens-plugin-x` works even when the
   server runs bundled inside an editor extension

Most SQL workspaces have no `package.json`, and that's fine: install plugins globally, the same
way the server itself is installed for Claude Code:

```bash
npm i -g sqllens-plugin-databricks
```

Publishing one: name it `sqllens-plugin-<something>` so it's findable, and make the entry point
resolvable:

```json
{
	"name": "sqllens-plugin-example",
	"version": "1.0.0",
	"type": "module",
	"main": "index.mjs",
	"peerDependencies": { "sqllens-language-server": ">=0.3" }
}
```

Plugins import nothing from the server at runtime (the whole contract is the object `activate`
returns), so there is no dual-install hazard; the peer dependency is documentation.

## TypeScript

Node runs `.ts` files natively (type stripping, default-on since Node 22.18 and 23.6), so a
path plugin can simply be TypeScript, no build step:

```json
{ "plugins": ["./tools/sqllens-rules.ts"] }
```

Two rules from Node, not from us: erasable syntax only (no runtime `enum`, no `namespace`
values), and the server must run on a Node new enough to strip types. Get typed hooks from the
types-only export, nothing is imported at runtime:

```ts
import type { PluginContext, SqllensPlugin } from "sqllens-language-server/plugin";

const activate = (ctx: PluginContext): SqllensPlugin => ({ ... });
export default activate;
```

For an npm-published plugin, compile to `.js` as usual so consumers on any Node version can load it.

## Lifecycle and safety

- Plugins load during `initialize`, so every request sees the final plugin set. Keep `activate`
  fast; slow work belongs in `fetch` or behind lazy calls.
- Editing `.sqllens.json` reloads plugins only when the `plugins` entries actually changed, so
  keystrokes in the config don't churn your warehouse connections. `dispose()` runs before every
  reload and on shutdown.
- Editing the plugin's own source needs a fresh load: touch the `plugins` entry or restart the
  server (in VS Code: Developer: Reload Window).
- `SQLLENS_NO_PLUGINS=1` disables plugin loading entirely, a kill switch for debugging.
- Loading a plugin is executing code. Bare npm names are the safer surface: they can only load
  something you deliberately installed. A `./path` plugin inside a repo runs on open, so treat
  cloned repos with the same care as any code you run; in VS Code, Restricted Mode keeps the
  extension (and so plugins) off until you trust the folder.

## API stability and roadmap

The plugin API version is 1: the four hooks above, the schema provider, and the activate
contract. Planned next, behind future `api` bumps: a templates provider (ref()-style resolution,
arriving with dbt mode), and hooks for code lens, inlay hints, and semantic tokens.
