# vscode-extension

The VS Code client extension for sqllens-language-server (Milestone 2). A
self-contained sub-package in this repo: own `package.json`, own `src/` + tests,
own build and packaging (`vsce`), deliberately NOT an npm workspace of the root
package — the server's semantic-release train at the repo root stays untouched.

Release flow (decided 2026-07-13): chained, not manual. The extension workflow
runs on completion of the server's Release workflow (`on: workflow_run` — NOT
`on: release`, which never fires for GITHUB_TOKEN-created releases), pins the
freshly released server version, mirrors it as the extension version, builds,
tests, publishes via vsce. Manual dispatch remains the escape hatch for
extension-only fixes. Tags namespaced `vscode-vX.Y.Z` so semantic-release never
sees them.

Decision (Niclas, 2026-07-13): the extension is COMPLETE — it bundles the server
as an npm dependency and runs it in-process (module transport), so installing
the extension is the only step. No global npm install, no PATH lookup. The cost
is a fat vsix and a version pin: shipping server updates to VS Code users means
cutting an extension release.

The extension is still client wiring only (vscode-languageclient around the
bundled server); no analysis, no server source lives here.
