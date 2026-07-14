// The CLI surface of the bin: --help / --version answer without starting a server,
// and a missing transport flag prints usage instead of an unhandled throw.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = join(__dirname, "..");

function runCli(...args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "src", "main.ts"), ...args], {
		encoding: "utf8",
		cwd: repoRoot,
		timeout: 30_000,
	});
}

describe("cli", () => {
	it("--help prints usage (transports, config discovery, env vars) and exits 0", () => {
		const res = runCli("--help");
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("--stdio");
		expect(res.stdout).toContain("--node-ipc");
		expect(res.stdout).toContain("--socket");
		expect(res.stdout).toContain("--pipe");
		expect(res.stdout).toContain(".sqllens.json");
		expect(res.stdout).toContain("SQLLENS_USER_CONFIG");
		expect(res.stdout).toContain("SQLLENS_NO_PLUGINS");
	});

	it("--version prints the package version and exits 0", () => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
		const res = runCli("--version");
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe(pkg.version);
	});

	it("no transport flag prints the usage to stderr and exits 1 (no stack trace)", () => {
		const res = runCli();
		expect(res.status).toBe(1);
		expect(res.stderr).toContain("--stdio");
		expect(res.stderr).not.toContain("at "); // no unhandled-throw stack
	});
});
