# [0.4.0](https://github.com/NiclasOlofsson/sqllens-language-server/compare/v0.3.0...v0.4.0) (2026-07-15)


### Features

* sql-<dialect> language ids bind the dialect per document ([a2d6aa9](https://github.com/NiclasOlofsson/sqllens-language-server/commit/a2d6aa92f30eecb89336a3a48ea11afde4351e99))
* sqllens 1.3.0, adopt the canonical signature renderer ([6aef031](https://github.com/NiclasOlofsson/sqllens-language-server/commit/6aef0317baf00de4bc0ecfbb007ae5d7083deeef)), closes [#33](https://github.com/NiclasOlofsson/sqllens-language-server/issues/33)
* sqllens 1.4.0 ([30479ce](https://github.com/NiclasOlofsson/sqllens-language-server/commit/30479ce8912db96189b36b988de0222b4179676a))
* surface harvested function docs (sqllens 1.3 FN_DOCS) ([681466f](https://github.com/NiclasOlofsson/sqllens-language-server/commit/681466fd0cfa5d37012e126400307333b4a057c7))
* **vscode-extension:** extension id sqllens-vscode ([97ce35e](https://github.com/NiclasOlofsson/sqllens-language-server/commit/97ce35e9ce04c6711eaaa9d2b013495fa41d56d3))
* **vscode-extension:** Marketplace readiness ([babc0cc](https://github.com/NiclasOlofsson/sqllens-language-server/commit/babc0ccf5708547a69702a927a50d1b48cdb9764))
* **vscode-extension:** sqllens wordmark icon for the Marketplace ([9368192](https://github.com/NiclasOlofsson/sqllens-language-server/commit/9368192cb8bb897234ce9c6312c2b237a8f25dac)), closes [#777777](https://github.com/NiclasOlofsson/sqllens-language-server/issues/777777)

# [0.3.0](https://github.com/NiclasOlofsson/sqllens-language-server/compare/v0.2.0...v0.3.0) (2026-07-14)


### Bug Fixes

* **ci:** treat Context7 too-early cooldown as soft skip ([80ba742](https://github.com/NiclasOlofsson/sqllens-language-server/commit/80ba7420ba75e69557bd31c97e15d2eafec2743f))


### Features

* **cli:** --help and --version; friendly usage on missing transport ([c2faf49](https://github.com/NiclasOlofsson/sqllens-language-server/commit/c2faf4999006b5c4afe075f4acabcaf5e3e5c0f9))
* JS/ESM plugin system (providers, hooks, config layering) ([6b1653e](https://github.com/NiclasOlofsson/sqllens-language-server/commit/6b1653e97653c4f0c9d392e4d80e4711d0b37fa3))
* sqllens 1.2.0, harvested signature tables and overload sets ([7c56574](https://github.com/NiclasOlofsson/sqllens-language-server/commit/7c56574c684b542962d26bc52f888499eeb17b87))

# [0.2.0](https://github.com/NiclasOlofsson/sqllens-language-server/compare/v0.1.0...v0.2.0) (2026-07-14)


### Bug Fixes

* config diagnostics push-only, VS Code showed pull+push duplicates ([bd36b61](https://github.com/NiclasOlofsson/sqllens-language-server/commit/bd36b61e7129c27875d44e6c45c9ce99160799b5))
* exclusive diagnostics channel per client, no more duplicates ([65b9fc3](https://github.com/NiclasOlofsson/sqllens-language-server/commit/65b9fc355c1c10fc2490653b2012effca39c3a51))
* function overlay covers keyword-lexed call sites; broader built-in test ([45e2a39](https://github.com/NiclasOlofsson/sqllens-language-server/commit/45e2a395215a0015c2ddf6b9b45ec253d9397913))


### Features

* .sqllens.json diagnostics, change-dialect quickfixes, live reload ([cceda3d](https://github.com/NiclasOlofsson/sqllens-language-server/commit/cceda3d813d8e42f76fb2d5a2cf24eabb5248aef))
* Anvil-aligned outline structure ([af82eee](https://github.com/NiclasOlofsson/sqllens-language-server/commit/af82eee0e614cd9adef08e0a5aa3f282509a4899))
* Anvil-style hover cards with inferred-type headline ([572fe89](https://github.com/NiclasOlofsson/sqllens-language-server/commit/572fe896033c4851fd673139180c7fea65b2d878))
* defaultLibrary modifier on known-function tokens ([c9fcab3](https://github.com/NiclasOlofsson/sqllens-language-server/commit/c9fcab3c41735f01b9a983bbd0e1b0a0c4aac31f))
* function hover card carries the curated signature ([2cb94f6](https://github.com/NiclasOlofsson/sqllens-language-server/commit/2cb94f61be66a8855f72338f667b7d4a88d6e8ae))
* function token type in semantic highlighting ([d138f94](https://github.com/NiclasOlofsson/sqllens-language-server/commit/d138f9434b2382c1d8a0d5515f607848cb120058))
* offer config quickfixes from SQL documents too ([658f311](https://github.com/NiclasOlofsson/sqllens-language-server/commit/658f311ac8afc0d5c411c6937f0dc39bff966971))
* **vscode-extension:** thin client extension, server bundled ([3d784b4](https://github.com/NiclasOlofsson/sqllens-language-server/commit/3d784b4522f801ff6100d645656881b5e9d37a58))
