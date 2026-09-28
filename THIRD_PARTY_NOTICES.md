# Dependency and asset inventory

This inventory describes installed direct dependencies from the committed lockfile on 2026-09-26. Their own licenses govern their distribution; this document does not replace bundled license texts or grant a license to this project's code. The project license is still pending release preparation.

| Dependency | Installed version | Declared license | Purpose |
| --- | --- | --- | --- |
| Phaser | 3.90.0 | MIT | 2D game rendering |
| Express | 5.2.1 | MIT | Local HTTP service |
| dotenv | 17.4.2 | BSD-2-Clause | Server environment loading |
| Zod | 4.6.5 | MIT | Runtime contracts |
| TypeScript | 5.9.3 | Apache-2.0 | Compilation |
| Vite | 7.3.6 | MIT | Client build |
| Vitest | 3.2.7 | MIT | Tests |
| tsx | 4.23.15 | MIT | Development/script runner |
| Playwright Test | 1.63.0 | Apache-2.0 | Development dependency |

Transitive dependencies are specified in package-lock.json and retain their upstream licenses. A public packaged binary/client bundle still needs its full dependency notice inventory; this table alone is not a completed legal audit.

The current map and characters are drawn by project code in src/game.ts. CSS uses locally available system fonts; no font files are bundled. No Jev-Lab or SillyTavern sprites or source files were imported during this release-preparation pass. Those projects are cited as references, not distributed dependencies. Screenshot provenance is documented in [docs/images/README.md](docs/images/README.md).

Jev model weights are not distributed. Real decisions require access to the configured external API; service availability, API terms and billing are separate from the code license.

The source candidate now includes a [187-entry locked inventory](docs/release/dependency-inventory.json) and [direct runtime license texts](docs/release/direct-runtime-licenses.md). Platform-specific optional entries are included in the inventory even if absent from the current machine. No dependency binaries or compiled browser bundle are included in the source export.

The included screenshots illustrate the authored game UI in offline rules mode; see [image provenance](docs/images/README.md). Their inclusion does not create a project license grant.
