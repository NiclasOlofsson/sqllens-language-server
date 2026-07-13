// src/index.ts — the embeddable surface: host processes call startServer(connection, options)
// directly instead of launching the stdio binary. The CLI (src/main.ts) is a thin wrapper over this.
export { startServer, type ServerOptions } from "./server.js";
