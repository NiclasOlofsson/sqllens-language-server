import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Fast co-dev loop against a local sqllens checkout: SQLLENS_LOCAL=1 npm test
// aliases the "sqllens" import to ../sql-dialect-grammars/src directly (TS source,
// no build step needed there). Off by default — CI and everyday `npm test` use the
// installed npm package like any other consumer.
const local = process.env.SQLLENS_LOCAL === "1";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
		// sqllens ships multi-MB generated ANTLR parsers per dialect; importing it
		// into many workers at once is memory-heavy, so cap the pool.
		pool: "threads",
		maxWorkers: 2,
		alias: local
			? {
					sqllens: resolve(import.meta.dirname, "../sql-dialect-grammars/src/index.ts"),
					"sqllens/minijinja": resolve(import.meta.dirname, "../sql-dialect-grammars/src/minijinja/index.ts"),
				}
			: undefined,
	},
});
