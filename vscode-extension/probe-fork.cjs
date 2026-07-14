// Reproduces what vscode-languageclient does for TransportKind.ipc:
// fork the server module with --node-ipc and drive initialize over IPC.
const { fork } = require("node:child_process");
const path = require("node:path");
const { createMessageConnection, IPCMessageReader, IPCMessageWriter } = require("vscode-jsonrpc/node");

const serverModule = path.join(path.dirname(require.resolve("sqllens-language-server")), "main.js");
console.log("server module:", serverModule);

const child = fork(serverModule, ["--node-ipc"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.on("exit", (code, sig) => console.log("child exit:", code, sig));
child.on("error", (e) => console.log("child error:", e.message));

const conn = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
conn.listen();
conn.sendRequest("initialize", { processId: process.pid, rootUri: null, capabilities: {} })
	.then((r) => {
		console.log("INITIALIZE OK — hoverProvider:", r.capabilities.hoverProvider === true);
		child.kill();
		process.exit(0);
	})
	.catch((e) => {
		console.log("INITIALIZE FAILED:", e.message);
		child.kill();
		process.exit(1);
	});
setTimeout(() => {
	console.log("TIMEOUT waiting for initialize");
	child.kill();
	process.exit(1);
}, 10000);
