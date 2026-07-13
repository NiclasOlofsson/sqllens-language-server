#!/usr/bin/env node
// src/main.ts
// Attachable stdio entry: the same server any LSP client (VS Code) connects to.
// Requires an explicit transport flag (--stdio) — createConnection throws without one.
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startServer } from "./server.js";

startServer(createConnection(ProposedFeatures.all));
