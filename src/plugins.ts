// src/plugins.ts — the plugin host: resolves configured plugin modules, imports
// and activates them, wraps their schema providers into the CallbackSchema seam,
// and runs their hooks with per-call crash isolation. A plugin failure of ANY
// kind degrades to "plugin absent", logged — never to a broken server.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CallbackSchema, type SchemaProvider } from "sqllens";
import type { PluginSpec } from "./dialect-config.js";
import {
	PLUGIN_API_VERSION,
	type PluginActivate,
	type PluginContext,
	type PluginHooks,
	type PluginSchemaProvider,
	type SqllensPlugin,
} from "./plugin.js";

/** Path-form module specifiers (./ ../ absolute POSIX or Windows drive) — everything else is a bare npm name. */
const PATH_FORM = /^(\.{1,2}[/\\]|\/|[A-Za-z]:[/\\])/;

let cachedGlobalRoot: string | null | undefined;
/** The npm global node_modules dir via `npm root -g`, spawned lazily at most once per process.
 *  Node's resolver never looks there by itself, and a server bundled inside an editor extension
 *  can't reach it via its own module paths either — this is the explicit third leg. */
export function npmGlobalRoot(): string | undefined {
	if (cachedGlobalRoot === undefined) {
		try {
			const res = spawnSync("npm", ["root", "-g"], {
				encoding: "utf8",
				shell: process.platform === "win32",
				timeout: 15_000,
			});
			const out = res.status === 0 ? (res.stdout ?? "").trim() : "";
			cachedGlobalRoot = out.length > 0 ? out : null;
		} catch {
			cachedGlobalRoot = null;
		}
	}
	return cachedGlobalRoot ?? undefined;
}

/** Resolve a plugin spec to an absolute module path. Path-form: against the declaring config's
 *  directory. Bare names: workspace node_modules → the server's own module paths (covers a
 *  globally installed server finding globally installed siblings) → the npm global root. */
export function resolvePluginModule(
	spec: PluginSpec,
	workspaceRoot: string,
	globalRoot: () => string | undefined = npmGlobalRoot,
): string {
	if (PATH_FORM.test(spec.module)) return resolve(spec.baseDir, spec.module);
	try {
		return createRequire(join(workspaceRoot, "package.json")).resolve(spec.module);
	} catch {
		/* next leg */
	}
	try {
		return createRequire(import.meta.url).resolve(spec.module);
	} catch {
		/* next leg */
	}
	const g = globalRoot();
	if (g !== undefined) {
		try {
			return createRequire(join(g, "package.json")).resolve(spec.module);
		} catch {
			/* fall through to the error */
		}
	}
	throw new Error(
		`Cannot resolve plugin "${spec.module}" from the workspace node_modules, the server installation, ` +
			`or the npm global root${g ? ` (${g})` : ""}. Install it (npm i -g ${spec.module}) ` +
			`or reference a file with a "./" path.`,
	);
}

export interface PluginHostLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

interface LoadedPlugin {
	name: string;
	layer: "user" | "project";
	instance: SqllensPlugin;
	/** The plugin's schema wrapped for the engine (CallbackSchema; world override when "open"). */
	schema?: SchemaProvider;
}

const errorText = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** An "open"-world view over a CallbackSchema: same lookups, misses and prime, but a miss means
 *  "unknown — do not diagnose" instead of "does not exist" (CallbackSchema itself is always closed). */
class OpenWorldSchema implements SchemaProvider {
	readonly world = "open" as const;
	constructor(private readonly inner: CallbackSchema) {}
	columnsFor(parts: string[], dialect?: string) {
		return this.inner.columnsFor(parts, dialect);
	}
	tables(dialect?: string) {
		return this.inner.tables(dialect);
	}
	get version() {
		return this.inner.version;
	}
	get misses() {
		return this.inner.misses;
	}
	prime() {
		return this.inner.prime();
	}
}

function wrapSchema(provider: PluginSchemaProvider): SchemaProvider {
	const callback = new CallbackSchema({
		resolve: (parts) => provider.resolve(parts),
		fetch: provider.fetch ? (missing) => provider.fetch!(missing) : undefined,
	});
	return provider.world === "open" ? new OpenWorldSchema(callback) : callback;
}

/** The resolve-on-demand duck type (mirrors the server's isLazyCatalog). */
interface LazyMember {
	readonly misses: ReadonlyArray<string[]>;
	prime(): Promise<boolean>;
}
const isLazy = (s: SchemaProvider): s is SchemaProvider & LazyMember => {
	const c = s as Partial<LazyMember>;
	return typeof c.prime === "function" && Array.isArray(c.misses);
};

/** First-hit-wins chain over several catalogs; misses and prime() aggregate across the lazy
 *  members so the server's re-publish loop drives every plugin catalog at once. */
class CompositeSchema implements SchemaProvider {
	constructor(private readonly members: readonly SchemaProvider[]) {}
	columnsFor(parts: string[], dialect?: string) {
		for (const m of this.members) {
			const cols = m.columnsFor(parts, dialect);
			if (cols !== undefined) return cols;
		}
		return undefined;
	}
	tables(dialect?: string) {
		return [...new Set(this.members.flatMap((m) => m.tables(dialect)))];
	}
	get version() {
		return this.members.reduce((sum, m) => sum + m.version, 0);
	}
	/** Closed only when EVERY member declares a complete world — one open member means a total
	 *  miss might still exist somewhere, so unknown-table must not fire (never-wrong). */
	get world(): "closed" | "open" {
		return this.members.every((m) => (m.world ?? "closed") === "closed") ? "closed" : "open";
	}
	get misses(): ReadonlyArray<string[]> {
		return this.members.flatMap((m) => (isLazy(m) ? [...m.misses] : []));
	}
	async prime(): Promise<boolean> {
		const results = await Promise.all(this.members.map((m) => (isLazy(m) ? m.prime() : Promise.resolve(false))));
		return results.some(Boolean);
	}
}

/** Compose the active catalog chain; undefined for none, the member itself for one. */
export function composeSchemas(members: readonly SchemaProvider[]): SchemaProvider | undefined {
	if (members.length === 0) return undefined;
	if (members.length === 1) return members[0];
	return new CompositeSchema(members);
}

export class PluginHost {
	private plugins: LoadedPlugin[] = [];
	private generation = 0;

	constructor(
		private readonly log: PluginHostLogger,
		private readonly globalRoot: () => string | undefined = npmGlobalRoot,
	) {}

	/** Dispose the current plugins and load `specs` in order (user layer first — the config
	 *  merge already ordered them). Every failure is per-plugin: logged and skipped. */
	async load(specs: readonly PluginSpec[], workspaceRoot: string): Promise<void> {
		await this.dispose();
		if (process.env.SQLLENS_NO_PLUGINS === "1") {
			if (specs.length > 0)
				this.log.info(`SQLLENS_NO_PLUGINS=1 — skipping ${specs.length} configured plugin(s).`);
			return;
		}
		const generation = ++this.generation;
		const loaded: LoadedPlugin[] = [];
		for (const spec of specs) {
			try {
				const path = resolvePluginModule(spec, workspaceRoot, this.globalRoot);
				const url = pathToFileURL(path);
				url.searchParams.set("sqllens-gen", String(generation)); // a reload imports fresh code
				const mod = (await import(url.href)) as { api?: unknown; default?: unknown };
				if (typeof mod.api === "number" && mod.api > PLUGIN_API_VERSION) {
					this.log.warn(
						`Plugin ${spec.module} requires plugin API ${mod.api}; this server supports ${PLUGIN_API_VERSION} — skipped.`,
					);
					continue;
				}
				if (mod.api === undefined)
					this.log.warn(`Plugin ${spec.module} exports no \`api\` version; assuming ${PLUGIN_API_VERSION}.`);
				if (typeof mod.default !== "function") {
					this.log.error(`Plugin ${spec.module} must default-export an activate(ctx) function — skipped.`);
					continue;
				}
				const ctx: PluginContext = {
					workspaceRoot,
					options: spec.options,
					log: (m) => this.log.info(`[${spec.module}] ${m}`),
				};
				const instance = await (mod.default as PluginActivate)(ctx);
				if (instance === null || instance === undefined) {
					this.log.info(`Plugin ${spec.module} declined to activate.`);
					continue;
				}
				loaded.push({
					name: spec.module,
					layer: spec.layer,
					instance,
					schema: instance.schema ? wrapSchema(instance.schema) : undefined,
				});
				this.log.info(`Plugin ${spec.module} active (${spec.layer} layer).`);
			} catch (err) {
				this.log.error(`Plugin ${spec.module} failed to load: ${errorText(err)}`);
			}
		}
		this.plugins = loaded;
	}

	/** Plugin catalogs for the active-schema chain — project layer before user (more specific wins). */
	schemas(): SchemaProvider[] {
		const withSchema = this.plugins.filter((p) => p.schema !== undefined);
		return [
			...withSchema.filter((p) => p.layer === "project"),
			...withSchema.filter((p) => p.layer === "user"),
		].map((p) => p.schema as SchemaProvider);
	}

	/** Run one hook across all plugins in load order. A throwing/rejecting hook logs and is
	 *  skipped — the server's own answer always ships. */
	async runHook<K extends keyof PluginHooks>(name: K, args: Parameters<Required<PluginHooks>[K]>[0]): Promise<void> {
		for (const plugin of this.plugins) {
			const hook = plugin.instance.hooks?.[name] as ((a: typeof args) => void | Promise<void>) | undefined;
			if (hook === undefined) continue;
			try {
				await hook(args);
			} catch (err) {
				this.log.error(`Plugin ${plugin.name} ${name} hook failed: ${errorText(err)}`);
			}
		}
	}

	/** Dispose every plugin (config reload, shutdown). Individual dispose failures only log. */
	async dispose(): Promise<void> {
		for (const plugin of this.plugins) {
			try {
				await plugin.instance.dispose?.();
			} catch (err) {
				this.log.error(`Plugin ${plugin.name} dispose failed: ${errorText(err)}`);
			}
		}
		this.plugins = [];
	}
}
